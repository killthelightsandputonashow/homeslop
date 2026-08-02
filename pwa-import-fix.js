const HOMESLOP_CANONICAL_ORIGIN = "https://homeslop.insane-but-smart.workers.dev";
const HOMESLOP_IMPORT_PATH = "/api/import";

const nativeFetch = window.fetch.bind(window);

function isHomeslopImportRequest(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return url.pathname === HOMESLOP_IMPORT_PATH;
  } catch {
    return false;
  }
}

function canonicalImportUrl(input) {
  const original = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const canonical = new URL(HOMESLOP_IMPORT_PATH, HOMESLOP_CANONICAL_ORIGIN);
  canonical.search = original.search;
  canonical.searchParams.set("homeslop_client", "pwa");
  canonical.searchParams.set("homeslop_nonce", String(Date.now()));
  return canonical;
}

window.fetch = async function homeslopFetch(input, init = {}) {
  if (!isHomeslopImportRequest(input)) return nativeFetch(input, init);

  const requestInit = {
    ...init,
    cache: "no-store",
    credentials: "omit",
    headers: {
      Accept: "text/html, application/json",
      ...(init.headers || {}),
    },
  };

  const canonical = canonicalImportUrl(input);

  try {
    const response = await nativeFetch(canonical, requestInit);
    if (response.status !== 404 && response.status !== 405) return response;
  } catch (error) {
    console.warn("Homeslop canonical importer request failed", error);
  }

  return nativeFetch(input, requestInit);
};

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

async function refreshServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();

    if (registration?.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  } catch (error) {
    console.warn("Homeslop could not refresh its service worker", error);
  }
}

if (isStandalone()) {
  window.addEventListener("load", refreshServiceWorker, { once: true });
}
