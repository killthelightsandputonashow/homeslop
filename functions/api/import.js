const DEFAULT_UPSTREAM_IMPORTER =
  "https://homeslop-importer-killthelightsandp.vercel.app/api/import";

function corsHeaders(request) {
  const origin = request?.headers?.get?.("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonError(error, status = 502, diagnostics = null, request = null) {
  return Response.json(
    { error, diagnostics },
    {
      status,
      headers: {
        ...corsHeaders(request),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Homeslop-Route": "cloudflare-relay",
      },
    },
  );
}

function readableError(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    if (typeof value.message === "string" && value.message.trim()) {
      const code = typeof value.code === "string" ? ` (${value.code})` : "";
      return `${value.message.trim()}${code}`;
    }
    if (typeof value.code === "string" && value.code.trim()) return value.code.trim();
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value || "Unknown upstream error.");
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(context.request),
  });
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const source = requestUrl.searchParams.get("url");

  if (!source) {
    return jsonError("Missing the AO3 URL.", 400, null, context.request);
  }

  const upstreamBase = context.env.UPSTREAM_IMPORTER_URL || DEFAULT_UPSTREAM_IMPORTER;
  let upstreamUrl;

  try {
    upstreamUrl = new URL(upstreamBase);
    upstreamUrl.searchParams.set("url", source);
  } catch {
    return jsonError("Homeslop's external importer URL is misconfigured.", 500, null, context.request);
  }

  const started = Date.now();
  let upstreamResponse;

  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        Origin: new URL(context.request.url).origin,
        "X-Homeslop-Relay": "cloudflare-worker",
      },
    });
  } catch (error) {
    return jsonError(
      "Homeslop reached Cloudflare, but the separate Vercel importer could not be contacted. It may not be deployed yet.",
      502,
      {
        route: "cloudflare-to-vercel",
        upstreamHost: upstreamUrl.hostname,
        durationMs: Date.now() - started,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      context.request,
    );
  }

  const responseHeaders = new Headers(corsHeaders(context.request));
  const forwardedHeaders = [
    "content-type",
    "retry-after",
    "x-homeslop-diagnostic-id",
    "x-homeslop-importer",
  ];

  forwardedHeaders.forEach((name) => {
    const value = upstreamResponse.headers.get(name);
    if (value) responseHeaders.set(name, value);
  });

  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "no-referrer");
  responseHeaders.set("X-Homeslop-Route", "cloudflare-to-vercel");
  responseHeaders.set("X-Homeslop-Relay-Duration", String(Date.now() - started));

  if (!upstreamResponse.ok) {
    const contentType = upstreamResponse.headers.get("content-type") || "";
    let upstreamPayload = null;
    let upstreamMessage = `Vercel returned HTTP ${upstreamResponse.status}.`;

    if (contentType.includes("application/json")) {
      upstreamPayload = await upstreamResponse.json().catch(() => null);
      if (upstreamPayload?.error) {
        upstreamMessage = readableError(upstreamPayload.error);
      } else if (upstreamPayload) {
        upstreamMessage = readableError(upstreamPayload);
      }
    } else {
      const text = await upstreamResponse.text().catch(() => "");
      if (text.trim()) upstreamMessage = text.trim().slice(0, 500);
    }

    return jsonError(
      `Vercel importer error: ${upstreamMessage}`,
      upstreamResponse.status,
      {
        route: "cloudflare-to-vercel",
        upstreamHost: upstreamUrl.hostname,
        upstreamStatus: upstreamResponse.status,
        durationMs: Date.now() - started,
        upstreamDiagnostics: upstreamPayload?.diagnostics || null,
      },
      context.request,
    );
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
