const AO3_HOST = "archiveofourown.org";
const AO3_HOSTS = ["archiveofourown.org", "www.archiveofourown.org"];
const USER_AGENT = "Homeslop/0.1 personal AO3 reader (single user, on-demand imports)";
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

function jsonError(error, status = 400, extraHeaders = {}) {
  return Response.json(
    { error },
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

async function requestOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AO3_TIMEOUT_MS);

  try {
    return await fetch(url, {
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
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAO3(url) {
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
        const response = await requestOnce(candidate);
        lastResponse = response;
        lastError = null;

        if (response.ok || !RETRYABLE_STATUSES.has(response.status)) {
          return { response, attempts };
        }
      } catch (error) {
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

  let response;
  let attempts = 0;
  try {
    const result = await requestAO3(ao3Url);
    response = result.response;
    attempts = result.attempts;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonError(
        "AO3 did not answer after several timed attempts. It may be slow or refusing Cloudflare traffic right now. Try again later.",
        504,
      );
    }
    return jsonError(
      "Homeslop could not establish a connection to AO3 after several attempts. The app is online, but the AO3 connection path is unavailable right now.",
      502,
    );
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const headers = {
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
      "X-Homeslop-Attempts": String(attempts),
    };

    if (response.status === 429) {
      return jsonError("AO3 asked Homeslop to slow down. Wait a while before importing again.", 429, headers);
    }

    if (response.status === 404) {
      return jsonError("AO3 could not find that work. It may be deleted, hidden, or restricted.", 404, headers);
    }

    if (response.status === 403) {
      return jsonError("AO3 refused this request. Login-only and restricted works are not supported yet.", 403, headers);
    }

    if (response.status === 525) {
      return jsonError(
        "AO3's Cloudflare connection failed its SSL handshake after several retries (HTTP 525). Homeslop itself is online; try again later.",
        502,
        headers,
      );
    }

    return jsonError(`AO3 returned HTTP ${response.status} after ${attempts} attempts.`, 502, headers);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return jsonError("AO3 returned an unexpected file type.", 502, {
      "X-Homeslop-Attempts": String(attempts),
    });
  }

  const html = await response.text();
  if (!html.includes('id="workskin"') && !html.includes("id='workskin'")) {
    return jsonError("The AO3 response did not contain a readable work body.", 422, {
      "X-Homeslop-Attempts": String(attempts),
    });
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Homeslop-Attempts": String(attempts),
    },
  });
}
