const AO3_HOST = "archiveofourown.org";
const AO3_HOSTS = ["archiveofourown.org", "www.archiveofourown.org"];
const USER_AGENT = "Homeslop/0.2 personal AO3 reader (single-user, on-demand imports)";
const IMPORTER_VERSION = "0.2.0-vercel";
const REQUEST_TIMEOUT_MS = 9000;

function cleanText(value, limit = 140) {
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

function normalizeSource(value) {
  let source;
  try {
    source = new URL(value);
  } catch {
    throw new Error("The importer received an invalid URL.");
  }

  const host = source.hostname.toLowerCase().replace(/^www\./, "");
  if (source.protocol !== "https:" || host !== AO3_HOST) {
    throw new Error("Only HTTPS links from archiveofourown.org are allowed.");
  }

  const match = source.pathname.match(/^\/works\/(\d+)/);
  if (!match) {
    throw new Error("The URL must point to an AO3 work or chapter.");
  }

  const normalized = new URL(`https://${AO3_HOST}/works/${match[1]}`);
  normalized.searchParams.set("view_full_work", "true");
  normalized.searchParams.set("view_adult", "true");
  return normalized;
}

function setCommonHeaders(response, origin) {
  const allowedOrigins = new Set([
    "https://homeslop.insane-but-smart.workers.dev",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ]);

  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }

  response.setHeader("Vary", "Origin");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Homeslop-Importer", IMPORTER_VERSION);
}

function sendJson(response, status, payload, origin) {
  setCommonHeaders(response, origin);
  response.status(status).json(payload);
}

async function summarizeErrorPage(response) {
  try {
    const body = await response.clone().text();
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return cleanText(title || body);
  } catch {
    return null;
  }
}

async function fetchOnce(url, number) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    return {
      response,
      diagnostic: {
        number,
        hostname: url.hostname,
        outcome: "http",
        status: response.status,
        durationMs: Date.now() - started,
        cfRay: response.headers.get("cf-ray"),
        server: response.headers.get("server"),
        responseNote: response.ok ? null : await summarizeErrorPage(response),
      },
    };
  } catch (error) {
    return {
      response: null,
      diagnostic: {
        number,
        hostname: url.hostname,
        outcome: "exception",
        durationMs: Date.now() - started,
        timedOut: error instanceof Error && error.name === "AbortError",
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(request, response) {
  const origin = request.headers.origin;
  setCommonHeaders(response, origin);

  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
    return response.status(204).end();
  }

  if (request.method !== "GET") {
    return sendJson(response, 405, { error: "Only GET requests are supported." }, origin);
  }

  const rawSource = Array.isArray(request.query.url) ? request.query.url[0] : request.query.url;
  if (!rawSource) {
    return sendJson(response, 400, { error: "Missing the AO3 URL." }, origin);
  }

  let source;
  try {
    source = normalizeSource(rawSource);
  } catch (error) {
    return sendJson(
      response,
      400,
      { error: error instanceof Error ? error.message : "Invalid AO3 URL." },
      origin,
    );
  }

  const diagnostics = {
    id: crypto.randomUUID(),
    importerVersion: IMPORTER_VERSION,
    provider: "vercel",
    region: process.env.VERCEL_REGION || "unknown",
    startedAt: new Date().toISOString(),
    totalDurationMs: 0,
    attempts: [],
  };

  const overallStarted = Date.now();
  let successfulResponse = null;
  let lastResponse = null;

  for (let index = 0; index < AO3_HOSTS.length; index += 1) {
    const candidate = new URL(source);
    candidate.hostname = AO3_HOSTS[index];

    const result = await fetchOnce(candidate, index + 1);
    diagnostics.attempts.push(result.diagnostic);

    if (result.response) {
      lastResponse = result.response;
      if (result.response.ok) {
        successfulResponse = result.response;
        break;
      }

      if (![525, 526, 520, 521, 522, 523, 524, 530, 502, 503, 504].includes(result.response.status)) {
        break;
      }
    }
  }

  diagnostics.totalDurationMs = Date.now() - overallStarted;
  const upstreamResponse = successfulResponse || lastResponse;

  if (!upstreamResponse) {
    console.warn("Homeslop Vercel importer received no AO3 response", diagnostics);
    return sendJson(
      response,
      502,
      {
        error: "The Vercel importer could not establish a usable connection to AO3.",
        diagnostics,
      },
      origin,
    );
  }

  if (!upstreamResponse.ok) {
    console.warn("Homeslop Vercel importer received an AO3 error", diagnostics);
    const status = upstreamResponse.status === 429 ? 429 : 502;
    return sendJson(
      response,
      status,
      {
        error: `AO3 returned HTTP ${upstreamResponse.status} through the Vercel route.`,
        diagnostics,
      },
      origin,
    );
  }

  const contentType = upstreamResponse.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return sendJson(
      response,
      502,
      { error: "AO3 returned an unexpected file type.", diagnostics },
      origin,
    );
  }

  const html = await upstreamResponse.text();
  if (!html.includes('id="workskin"') && !html.includes("id='workskin'")) {
    return sendJson(
      response,
      422,
      { error: "The AO3 response did not contain a readable work body.", diagnostics },
      origin,
    );
  }

  setCommonHeaders(response, origin);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Homeslop-Diagnostic-ID", diagnostics.id);
  return response.status(200).send(html);
}
