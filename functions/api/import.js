const DEFAULT_UPSTREAM_IMPORTER =
  "https://homeslop-importer-killthelightsandputonashow.vercel.app/api/import";

function jsonError(error, status = 502, diagnostics = null) {
  return Response.json(
    { error, diagnostics },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Homeslop-Route": "cloudflare-relay",
      },
    },
  );
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const source = requestUrl.searchParams.get("url");

  if (!source) {
    return jsonError("Missing the AO3 URL.", 400);
  }

  const upstreamBase = context.env.UPSTREAM_IMPORTER_URL || DEFAULT_UPSTREAM_IMPORTER;
  let upstreamUrl;

  try {
    upstreamUrl = new URL(upstreamBase);
    upstreamUrl.searchParams.set("url", source);
  } catch {
    return jsonError("Homeslop's external importer URL is misconfigured.", 500);
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
        durationMs: Date.now() - started,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const responseHeaders = new Headers();
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

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
