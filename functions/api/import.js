const AO3_HOST = "archiveofourown.org";
const AO3_HOSTS = ["archiveofourown.org", "www.archiveofourown.org"];
const USER_AGENT = "Homeslop/0.1 personal AO3 reader (single user, on-demand imports)";
const IMPORTER_VERSION = "0.1.3-diag";
const AO3_TIMEOUT_MS = 15000;
const RETRYABLE_STATUSES = new Set([
  408,
  425,
  500,
  502,
  503,
  504,
  520,
  521,
  522,
  523,
  524,
  525,
  526,
  530,
]);

function jsonError(error, status = 400, extraHeaders = {}, diagnostics = null) {
  return Response.json(
    { error, diagnostics },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders,
      },
    },
  );
}

function validateSource(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The importer received an invalid URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || host !== AO3_HOST) {
    throw new Error("Only HTTPS links from archiveofourown.org are allowed.");
  }

  const match = url.pathname.match(/^\/works\/(\d+)/);
  if (!match) {
    throw new Error("The URL must point to an AO3 work or chapter.");
  }

  const normalized = new URL(`https://${AO3_HOST}/works/${match[1]}`);
  normalized.searchParams.set("view_full_work", "true");
  normalized.searchParams.set("view_adult", "true");
  return normalized;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanText(value, limit = 120) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

async function summarizeErrorResponse(response) {
  if (response.ok) return null;

  try {
    const body = await response.clone().text();
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = cleanText(titleMatch?.[1] || "", 100);
    const excerpt = cleanText(body, 140);
    return title || excerpt || null;
  } catch {
    return null;
  }
}

function makeDiagnostics(context, ao3Url) {
  return {
    id: crypto.randomUUID(),
    importerVersion: IMPORTER_VERSION,
    workerColo: context.request.cf?.colo || "unknown",
    sourceHost: ao3Url.hostname,
    startedAt: new Date().toISOString(),
    totalDurationMs: 0,
    attempts: [],
  };
}

function formatDiagnostics(diagnostics) {
  const lines = [
    `diagnostic id: ${diagnostics.id}`,
    `importer: ${diagnostics.importerVersion}`,
    `worker colo: ${diagnostics.workerColo}`,
    `total: ${diagnostics.totalDurationMs}ms`,
  ];

  diagnostics.attempts.forEach((attempt) => {
    if (attempt.outcome === "http") {
      const details = [
        `HTTP ${attempt.status}`,
        `${attempt.durationMs}ms`,
        attempt.cfRay ? `cf-ray ${attempt.cfRay}` : null,
        attempt.server ? `server ${attempt.server}` : null,
        attempt.responseNote ? `page “${attempt.responseNote}”` : null,
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(`attempt ${attempt.number} (${attempt.hostname}): ${details}`);
    } else {
      const details = [
        attempt.timedOut ? "timed out" : attempt.errorName || "fetch error",
        `${attempt.durationMs}ms`,
        attempt.errorMessage || null,
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(`attempt ${attempt.number} (${attempt.hostname}): ${details}`);
    }
  });

  return lines.join("\n");
}

function diagnosticError(message, diagnostics) {
  return `${message}\n\n${formatDiagnostics(diagnostics)}`;
}

async function requestOnce(url, number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AO3_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
      },
    });

    const summary = {
      number,
      hostname: url.hostname,
      outcome: "http",
      status: response.status,
      statusText: response.statusText || "",
      durationMs: Date.now() - started,
      finalHost: (() => {
        try {
          return new URL(response.url).hostname;
        } catch {
          return url.hostname;
        }
      })(),
      cfRay: response.headers.get("cf-ray"),
      server: response.headers.get("server"),
      contentType: response.headers.get("content-type"),
      responseNote: await summarizeErrorResponse(response),
    };

    return { response, summary };
  } catch (error) {
    const summary = {
      number,
      hostname: url.hostname,
      outcome: "exception",
      durationMs: Date.now() - started,
      timedOut: error instanceof Error && error.name === "AbortError",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    };

    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.homeslopSummary = summary;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAO3(url, diagnostics) {
  let lastResponse = null;
  let lastError = null;
  let attempts = 0;

  // Two rounds across the canonical and www hostnames. A 525 is often brief,
  // so a delayed retry may succeed without making the user press Import again.
  for (let round = 0; round < 2; round += 1) {
    for (const hostname of AO3_HOSTS) {
      attempts += 1;
      const candidate = new URL(url);
      candidate.hostname = hostname;

      if (attempts > 1) {
        await sleep(Math.min(2500, 650 * attempts));
      }

      try {
        const result = await requestOnce(candidate, attempts);
        diagnostics.attempts.push(result.summary);
        lastResponse = result.response;
        lastError = null;

        if (result.response.ok || !RETRYABLE_STATUSES.has(result.response.status)) {
          return { response: result.response, attempts };
        }
      } catch (error) {
        diagnostics.attempts.push(
          error?.homeslopSummary || {
            number: attempts,
            hostname,
            outcome: "exception",
            durationMs: 0,
            timedOut: false,
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        );
        lastError = error;
      }
    }
  }

  if (lastResponse) {
    return { response: lastResponse, attempts };
  }

  throw lastError || new Error("AO3 request failed before a response was received.");
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const source = requestUrl.searchParams.get("url");

  if (!source) {
    return jsonError("Missing the AO3 URL.");
  }

  let ao3Url;
  try {
    ao3Url = validateSource(source);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid AO3 URL.");
  }

  const diagnostics = makeDiagnostics(context, ao3Url);
  const overallStarted = Date.now();
  let response;
  let attempts = 0;

  try {
    const result = await requestAO3(ao3Url, diagnostics);
    response = result.response;
    attempts = result.attempts;
  } catch (error) {
    diagnostics.totalDurationMs = Date.now() - overallStarted;
    console.warn("Homeslop AO3 import failed", diagnostics);

    if (error instanceof Error && error.name === "AbortError") {
      return jsonError(
        diagnosticError(
          "AO3 did not answer after several timed attempts. It may be slow or refusing Cloudflare traffic right now.",
          diagnostics,
        ),
        504,
        { "X-Homeslop-Diagnostic-ID": diagnostics.id },
        diagnostics,
      );
    }

    return jsonError(
      diagnosticError(
        "Homeslop could not establish a connection to AO3 after several attempts. The Worker is online, but its outbound AO3 connection failed before a usable response arrived.",
        diagnostics,
      ),
      502,
      { "X-Homeslop-Diagnostic-ID": diagnostics.id },
      diagnostics,
    );
  }

  diagnostics.totalDurationMs = Date.now() - overallStarted;

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const headers = {
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      "X-Homeslop-Attempts": String(attempts),
      "X-Homeslop-Diagnostic-ID": diagnostics.id,
    };

    console.warn("Homeslop AO3 import received an error response", diagnostics);

    if (response.status === 429) {
      return jsonError(
        diagnosticError("AO3 asked Homeslop to slow down. Wait a while before importing again.", diagnostics),
        429,
        headers,
        diagnostics,
      );
    }

    if (response.status === 404) {
      return jsonError(
        diagnosticError("AO3 could not find that work. It may be deleted, hidden, or restricted.", diagnostics),
        404,
        headers,
        diagnostics,
      );
    }

    if (response.status === 403) {
      return jsonError(
        diagnosticError("AO3 refused this request. Login-only and restricted works are not supported yet.", diagnostics),
        403,
        headers,
        diagnostics,
      );
    }

    if (response.status === 525) {
      return jsonError(
        diagnosticError(
          "AO3's Cloudflare edge returned HTTP 525. That means the request reached AO3's Cloudflare layer, but that layer could not complete TLS with AO3's origin server.",
          diagnostics,
        ),
        502,
        headers,
        diagnostics,
      );
    }

    return jsonError(
      diagnosticError(`AO3 returned HTTP ${response.status} after ${attempts} attempts.`, diagnostics),
      502,
      headers,
      diagnostics,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return jsonError(
      diagnosticError("AO3 returned an unexpected file type.", diagnostics),
      502,
      {
        "X-Homeslop-Attempts": String(attempts),
        "X-Homeslop-Diagnostic-ID": diagnostics.id,
      },
      diagnostics,
    );
  }

  const html = await response.text();
  if (!html.includes('id="workskin"') && !html.includes("id='workskin'")) {
    return jsonError(
      diagnosticError("The AO3 response did not contain a readable work body.", diagnostics),
      422,
      {
        "X-Homeslop-Attempts": String(attempts),
        "X-Homeslop-Diagnostic-ID": diagnostics.id,
      },
      diagnostics,
    );
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Homeslop-Attempts": String(attempts),
      "X-Homeslop-Diagnostic-ID": diagnostics.id,
    },
  });
}
