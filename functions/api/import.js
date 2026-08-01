const AO3_HOST = "archiveofourown.org";
const USER_AGENT = "Homeslop/0.1 personal AO3 reader (single user, on-demand imports)";

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

async function requestAO3(url) {
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8",
      "User-Agent": USER_AGENT,
    },
  });
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
  try {
    response = await requestAO3(ao3Url);
  } catch {
    return jsonError("Homeslop could not establish a connection to AO3. Try again when AO3 is reachable.", 502);
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const headers = retryAfter ? { "Retry-After": retryAfter } : {};

    if (response.status === 429) {
      return jsonError("AO3 asked Homeslop to slow down. Wait a while before importing again.", 429, headers);
    }

    if (response.status === 404) {
      return jsonError("AO3 could not find that work. It may be deleted, hidden, or restricted.", 404);
    }

    if (response.status === 403) {
      return jsonError("AO3 refused this request. Login-only and restricted works are not supported yet.", 403);
    }

    return jsonError(`AO3 returned HTTP ${response.status}.`, 502, headers);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    return jsonError("AO3 returned an unexpected file type.", 502);
  }

  const html = await response.text();
  if (!html.includes('id="workskin"') && !html.includes("id='workskin'")) {
    return jsonError("The AO3 response did not contain a readable work body.", 422);
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
