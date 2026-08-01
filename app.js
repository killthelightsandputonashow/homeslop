const DB_NAME = "homeslop-library";
const DB_VERSION = 1;
const STORE_NAME = "stories";

const views = {
  library: document.querySelector("#library-view"),
  import: document.querySelector("#import-view"),
  reader: document.querySelector("#reader-view"),
};

const tabs = [...document.querySelectorAll(".tab")];
const form = document.querySelector("#import-form");
const urlInput = document.querySelector("#ao3-url");
const importButton = document.querySelector("#import-button");
const statusLight = document.querySelector("#status-light");
const statusTitle = document.querySelector("#status-title");
const statusLog = document.querySelector("#status-log");
const footerStatus = document.querySelector("#footer-status");
const emptyLibrary = document.querySelector("#empty-library");
const bookList = document.querySelector("#book-list");
const bookCount = document.querySelector("#book-count");
const bookTemplate = document.querySelector("#book-template");
const readerFrame = document.querySelector("#reader-frame");
const readerTitle = document.querySelector("#reader-title");
const readerAuthor = document.querySelector("#reader-author");
const readerDelete = document.querySelector("#reader-delete");

let activeStoryId = null;
let logLines = ["> paste a work URL to begin."];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("importedAt", "importedAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = action(store);

    tx.oncomplete = () => {
      db.close();
      resolve(result?.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function getAllStories() {
  return runTransaction("readonly", (store) => store.getAll());
}

function getStory(id) {
  return runTransaction("readonly", (store) => store.get(id));
}

function saveStory(story) {
  return runTransaction("readwrite", (store) => store.put(story));
}

function removeStory(id) {
  return runTransaction("readwrite", (store) => store.delete(id));
}

function showView(name) {
  Object.entries(views).forEach(([key, element]) => {
    element.classList.toggle("is-visible", key === name);
  });

  tabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  });

  window.scrollTo({ top: 0, behavior: "instant" });
}

function setFooter(text) {
  footerStatus.textContent = text.toUpperCase();
}

function resetStatus() {
  logLines = ["> paste a work URL to begin."];
  statusLight.className = "status-light idle";
  statusTitle.textContent = "WAITING FOR INPUT";
  statusLog.textContent = logLines.join("\n");
}

function setStatus(kind, title, line, replace = false) {
  statusLight.className = `status-light ${kind}`;
  statusTitle.textContent = title.toUpperCase();

  if (line) {
    if (replace) logLines = [];
    logLines.push(`> ${line}`);
  }

  statusLog.textContent = logLines.join("\n");
  statusLog.scrollTop = statusLog.scrollHeight;
}

function normalizeAO3Url(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("That is not a complete URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "archiveofourown.org") {
    throw new Error("Homeslop currently accepts archiveofourown.org links only.");
  }

  const match = url.pathname.match(/^\/works\/(\d+)/);
  if (!match) {
    throw new Error("Paste a link to an AO3 work or one of its chapters.");
  }

  const workId = match[1];
  const normalized = new URL(`https://archiveofourown.org/works/${workId}`);
  normalized.searchParams.set("view_full_work", "true");
  normalized.searchParams.set("view_adult", "true");

  return { workId, url: normalized.toString() };
}

function absolutizeUrl(value, base) {
  if (!value) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function extractWork(responseHtml, sourceUrl, workId) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(responseHtml, "text/html");
  const workskin = documentNode.querySelector("#workskin");

  if (!workskin) {
    const errorText = documentNode.querySelector(".error, .flash.error")?.textContent?.trim();
    throw new Error(errorText || "AO3 returned a page, but Homeslop could not find the work body.");
  }

  const title =
    documentNode.querySelector("h2.title.heading")?.textContent?.trim() ||
    documentNode.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    `AO3 Work ${workId}`;

  const authorLinks = [...documentNode.querySelectorAll("h3.byline.heading a[rel='author'], h3.byline.heading a")];
  const author = authorLinks.map((link) => link.textContent.trim()).filter(Boolean).join(", ") || "Anonymous";

  const clonedWorkskin = workskin.cloneNode(true);
  clonedWorkskin.querySelectorAll("script").forEach((script) => script.remove());

  clonedWorkskin.querySelectorAll("img[src], source[src], video[src], audio[src]").forEach((element) => {
    element.setAttribute("src", absolutizeUrl(element.getAttribute("src"), sourceUrl));
  });

  clonedWorkskin.querySelectorAll("[srcset]").forEach((element) => {
    const rewritten = element
      .getAttribute("srcset")
      .split(",")
      .map((candidate) => {
        const [candidateUrl, descriptor] = candidate.trim().split(/\s+/, 2);
        return [absolutizeUrl(candidateUrl, sourceUrl), descriptor].filter(Boolean).join(" ");
      })
      .join(", ");
    element.setAttribute("srcset", rewritten);
  });

  clonedWorkskin.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.setAttribute("href", absolutizeUrl(anchor.getAttribute("href"), sourceUrl));
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });

  const inlineStyles = [...documentNode.querySelectorAll("style")]
    .map((style) => style.textContent || "")
    .filter((css) => css.trim().length > 0)
    .join("\n\n");

  return {
    title,
    author,
    workHtml: clonedWorkskin.outerHTML,
    inlineStyles,
  };
}

function buildReaderDocument(story) {
  const escapedBase = story.sourceUrl.replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <base href="${escapedBase}">
  <style>
    html { min-height: 100%; background: #fff; }
    body { min-height: 100%; margin: 0; padding: 18px 14px 50px; color: #111; background: #fff; }
    #workskin { max-width: 100%; margin: 0 auto; }
    img, video, svg, canvas { max-width: 100%; }
    pre { max-width: 100%; overflow-x: auto; }
    @media (min-width: 720px) { body { padding-inline: 7vw; } }
  </style>
  <style>${story.inlineStyles || ""}</style>
</head>
<body>${story.workHtml}</body>
</html>`;
}

async function importAO3Work(value) {
  const { workId, url } = normalizeAO3Url(value);
  importButton.disabled = true;
  urlInput.disabled = true;
  setFooter("IMPORTING");
  setStatus("busy", "CONTACTING AO3", "valid work link detected.", true);
  setStatus("busy", "CONTACTING AO3", `requesting work ${workId}...`);

  let response;
  try {
    response = await fetch(`/api/import?url=${encodeURIComponent(url)}`, {
      headers: { Accept: "text/html, application/json" },
    });
  } catch {
    throw new Error("The import endpoint could not be reached. Deploy this repository on Cloudflare Pages to enable /api/import.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = `Import failed with HTTP ${response.status}.`;
    if (contentType.includes("application/json")) {
      const payload = await response.json().catch(() => null);
      if (payload?.error) message = payload.error;
    } else {
      const text = await response.text().catch(() => "");
      if (text.trim()) message = text.trim().slice(0, 280);
    }
    throw new Error(message);
  }

  setStatus("busy", "READING WORK", "page received; locating #workskin...");
  const responseHtml = await response.text();
  const extracted = extractWork(responseHtml, url, workId);
  setStatus("busy", "PRESERVING FORMAT", "captured work HTML and inline CSS.");

  const story = {
    id: `ao3-${workId}`,
    source: "AO3",
    sourceUrl: url,
    workId,
    title: extracted.title,
    author: extracted.author,
    workHtml: extracted.workHtml,
    inlineStyles: extracted.inlineStyles,
    importedAt: new Date().toISOString(),
  };

  await saveStory(story);
  setStatus("success", "IMPORT COMPLETE", `saved “${story.title}” locally.`);
  setFooter("READY");
  await refreshLibrary();
  return story;
}

async function refreshLibrary() {
  let stories = [];
  try {
    stories = await getAllStories();
  } catch (error) {
    setFooter("STORAGE ERROR");
    console.error(error);
  }

  stories.sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
  bookList.replaceChildren();
  bookCount.textContent = `${stories.length} ${stories.length === 1 ? "FILE" : "FILES"}`;
  emptyLibrary.hidden = stories.length > 0;
  bookList.hidden = stories.length === 0;

  stories.forEach((story) => {
    const fragment = bookTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".book-open");
    fragment.querySelector(".book-source").textContent = story.source || "LOCAL";
    fragment.querySelector(".book-title").textContent = story.title;
    fragment.querySelector(".book-author").textContent = story.author ? `by ${story.author}` : "author unknown";
    button.addEventListener("click", () => openReader(story.id));
    bookList.append(fragment);
  });
}

async function openReader(id) {
  const story = await getStory(id);
  if (!story) return;

  activeStoryId = story.id;
  readerTitle.textContent = story.title;
  readerAuthor.textContent = story.author ? `${story.source} // ${story.author}` : story.source;
  readerFrame.srcdoc = buildReaderDocument(story);
  setFooter(`OPEN: ${story.title}`);
  showView("reader");
}

async function deleteActiveStory() {
  if (!activeStoryId) return;
  const story = await getStory(activeStoryId);
  if (!story) return;

  const confirmed = window.confirm(`Delete “${story.title}” from this device?`);
  if (!confirmed) return;

  await removeStory(activeStoryId);
  activeStoryId = null;
  readerFrame.srcdoc = "";
  await refreshLibrary();
  setFooter("DELETED");
  showView("library");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    if (tab.dataset.view === "import") resetStatus();
    showView(tab.dataset.view);
  });
});

document.querySelectorAll("[data-go-import]").forEach((button) => {
  button.addEventListener("click", () => {
    resetStatus();
    showView("import");
    setTimeout(() => urlInput.focus(), 100);
  });
});

document.querySelector("#reader-back").addEventListener("click", () => {
  activeStoryId = null;
  readerFrame.srcdoc = "";
  setFooter("READY");
  showView("library");
});

readerDelete.addEventListener("click", deleteActiveStory);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resetStatus();

  try {
    const story = await importAO3Work(urlInput.value);
    setTimeout(() => openReader(story.id), 450);
  } catch (error) {
    console.error(error);
    setStatus("error", "IMPORT FAILED", error instanceof Error ? error.message : "Unknown import error.");
    setFooter("ERROR");
  } finally {
    importButton.disabled = false;
    urlInput.disabled = false;
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

refreshLibrary();
