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
const readerChapterSelect = document.querySelector("#reader-chapter-select");
const readerChapterName = document.querySelector("#reader-chapter-name");
const readerChapterProgress = document.querySelector("#reader-chapter-progress");
const readerPrevButtons = [...document.querySelectorAll("[data-reader-prev]")];
const readerNextButtons = [...document.querySelectorAll("[data-reader-next]")];

let activeStory = null;
let activeChapterIndex = 0;
let frameResizeObserver = null;
let pendingFrameResize = 0;
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

  document.body.classList.toggle("reader-mode", name === "reader");
  if (name !== "reader") disconnectFrameResize();
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

function readableError(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value || "Unknown import error.");
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

function sanitizeWorkskin(workskin, sourceUrl) {
  const clone = workskin.cloneNode(true);
  clone
    .querySelectorAll("script, iframe, object, embed, base, meta[http-equiv='refresh']")
    .forEach((element) => element.remove());

  clone.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (["src", "href", "poster", "action", "xlink:href"].includes(name)) {
        if (/^\s*javascript:/i.test(value) || /^\s*data:text\/html/i.test(value)) {
          element.removeAttribute(attribute.name);
          return;
        }

        if (name === "action") {
          element.removeAttribute(attribute.name);
          return;
        }

        const resolved = absolutizeUrl(value, sourceUrl);
        element.setAttribute(attribute.name, resolved);
      }
    });
  });

  clone.querySelectorAll("[srcset]").forEach((element) => {
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

  clone.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });

  return clone;
}

function chapterTitleFromNode(node, index) {
  const title = node.querySelector(
    ".chapter.preface .title, .preface .title, h2.title, h3.title",
  )?.textContent?.replace(/\s+/g, " ").trim();

  return title || `Chapter ${index + 1}`;
}

function splitWorkskinIntoChapters(workskin) {
  const chaptersContainer = workskin.querySelector("#chapters");
  let chapterNodes = [];

  if (chaptersContainer) {
    chapterNodes = [...chaptersContainer.children].filter((child) =>
      child.classList?.contains("chapter"),
    );

    if (chapterNodes.length === 0) {
      chapterNodes = [...chaptersContainer.querySelectorAll(":scope > .chapter")];
    }
  }

  if (chapterNodes.length > 0) {
    return chapterNodes.map((chapterNode, index) => {
      const shell = workskin.cloneNode(false);
      const chapterShell = chaptersContainer.cloneNode(false);
      chapterShell.append(chapterNode.cloneNode(true));
      shell.append(chapterShell);

      return {
        id: chapterNode.id || `chapter-${index + 1}`,
        title: chapterTitleFromNode(chapterNode, index),
        html: shell.outerHTML,
      };
    });
  }

  if (chaptersContainer) {
    const shell = workskin.cloneNode(false);
    shell.append(chaptersContainer.cloneNode(true));
    return [
      {
        id: "chapter-1",
        title: chapterTitleFromNode(chaptersContainer, 0),
        html: shell.outerHTML,
      },
    ];
  }

  return [
    {
      id: "chapter-1",
      title: chapterTitleFromNode(workskin, 0),
      html: workskin.outerHTML,
    },
  ];
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
    documentNode.querySelector("h2.title.heading")?.textContent?.replace(/\s+/g, " ").trim() ||
    documentNode.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    `AO3 Work ${workId}`;

  const authorLinks = [
    ...documentNode.querySelectorAll("h3.byline.heading a[rel='author'], h3.byline.heading a"),
  ];
  const author = authorLinks.map((link) => link.textContent.trim()).filter(Boolean).join(", ") || "Anonymous";

  const cleanWorkskin = sanitizeWorkskin(workskin, sourceUrl);
  const inlineStyles = [...documentNode.querySelectorAll("style")]
    .map((style) => style.textContent || "")
    .filter((css) => css.trim().length > 0)
    .join("\n\n");
  const chapters = splitWorkskinIntoChapters(cleanWorkskin);

  return {
    title,
    author,
    workHtml: cleanWorkskin.outerHTML,
    inlineStyles,
    chapters,
  };
}

function ensureStoryChapters(story) {
  if (Array.isArray(story.chapters) && story.chapters.length > 0) return story;

  const parser = new DOMParser();
  const documentNode = parser.parseFromString(story.workHtml || "", "text/html");
  const workskin = documentNode.querySelector("#workskin") || documentNode.body.firstElementChild;

  if (!workskin) {
    story.chapters = [
      {
        id: "chapter-1",
        title: "Chapter 1",
        html: story.workHtml || "<div id=\"workskin\"><p>Story body unavailable.</p></div>",
      },
    ];
  } else {
    story.chapters = splitWorkskinIntoChapters(workskin);
  }

  story.lastChapterIndex = Math.min(story.lastChapterIndex || 0, story.chapters.length - 1);
  return story;
}

function escapeAttribute(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function buildReaderDocument(story, chapter) {
  const escapedBase = escapeAttribute(story.sourceUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <base href="${escapedBase}">
  <style>
    :where(*, *::before, *::after) { box-sizing: border-box; }
    :where(html) {
      width: 100%;
      min-height: 0;
      margin: 0;
      overflow-x: clip;
      background: #fff;
      color-scheme: light;
      -webkit-text-size-adjust: 100%;
    }
    :where(body) {
      width: min(100%, 54rem);
      min-height: 0;
      margin: 0 auto;
      padding: 1.05rem 1rem 4rem;
      overflow-x: clip;
      color: #222;
      background: #fff;
      font-family: "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.55;
      text-rendering: optimizeLegibility;
    }
    :where(#workskin) {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      margin: 0 auto;
    }
    :where(#workskin .userstuff) {
      max-width: 100%;
      color: inherit;
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    :where(#workskin .userstuff p) { margin: 0 0 1.15em; }
    :where(#workskin .preface) { margin: 0 0 1.6rem; }
    :where(#workskin .preface .title) {
      margin: 0.2rem 0 0.7rem;
      font-family: inherit;
      font-size: clamp(1.35rem, 6vw, 1.9rem);
      line-height: 1.2;
      text-align: center;
    }
    :where(#workskin .preface .byline) {
      margin: 0.35rem 0 1rem;
      font-size: 0.95rem;
      text-align: center;
    }
    :where(#workskin img, #workskin video, #workskin svg, #workskin canvas) {
      max-width: 100%;
      height: auto;
    }
    :where(#workskin pre, #workskin table) {
      max-width: 100%;
      overflow-x: auto;
    }
    :where(#workskin blockquote) { margin-inline: 1.25rem; }
    :where(#workskin a) { color: #5e147d; }
    @media (max-width: 520px) {
      :where(body) { padding: 0.9rem 0.95rem 3.5rem; }
      :where(#workskin blockquote) { margin-inline: 0.75rem; }
    }
  </style>
  <style>${story.inlineStyles || ""}</style>
</head>
<body>${chapter.html}</body>
</html>`;
}

function disconnectFrameResize() {
  if (frameResizeObserver) {
    frameResizeObserver.disconnect();
    frameResizeObserver = null;
  }
  if (pendingFrameResize) {
    cancelAnimationFrame(pendingFrameResize);
    pendingFrameResize = 0;
  }
}

function resizeReaderFrame() {
  if (!readerFrame || !views.reader.classList.contains("is-visible")) return;
  const frameDocument = readerFrame.contentDocument;
  if (!frameDocument?.documentElement || !frameDocument.body) return;

  if (pendingFrameResize) cancelAnimationFrame(pendingFrameResize);
  pendingFrameResize = requestAnimationFrame(() => {
    pendingFrameResize = 0;
    const html = frameDocument.documentElement;
    const body = frameDocument.body;
    const height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.scrollHeight,
      html.offsetHeight,
      1,
    );
    readerFrame.style.height = `${Math.ceil(height)}px`;
  });
}

function prepareReaderFrame() {
  disconnectFrameResize();
  const frameDocument = readerFrame.contentDocument;
  if (!frameDocument?.documentElement || !frameDocument.body) return;

  readerFrame.setAttribute("scrolling", "no");
  readerFrame.style.height = "1px";
  frameDocument.documentElement.style.overflowY = "hidden";
  frameDocument.body.style.overflowY = "hidden";

  if ("ResizeObserver" in window) {
    frameResizeObserver = new ResizeObserver(resizeReaderFrame);
    frameResizeObserver.observe(frameDocument.documentElement);
    frameResizeObserver.observe(frameDocument.body);
  }

  frameDocument.fonts?.ready.then(resizeReaderFrame).catch(() => {});
  frameDocument.querySelectorAll("img, video, audio").forEach((asset) => {
    asset.addEventListener("load", resizeReaderFrame, { once: true });
    asset.addEventListener("error", resizeReaderFrame, { once: true });
  });

  resizeReaderFrame();
  setTimeout(resizeReaderFrame, 100);
  setTimeout(resizeReaderFrame, 450);
}

function populateChapterSelect(story) {
  readerChapterSelect.replaceChildren();
  story.chapters.forEach((chapter, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index + 1}. ${chapter.title}`;
    readerChapterSelect.append(option);
  });
}

function syncChapterControls() {
  if (!activeStory) return;
  const chapterCount = activeStory.chapters.length;
  const chapter = activeStory.chapters[activeChapterIndex];
  const atStart = activeChapterIndex === 0;
  const atEnd = activeChapterIndex === chapterCount - 1;

  readerPrevButtons.forEach((button) => {
    button.disabled = atStart;
  });
  readerNextButtons.forEach((button) => {
    button.disabled = atEnd;
  });

  readerChapterSelect.value = String(activeChapterIndex);
  readerChapterName.textContent = chapter.title;
  readerChapterProgress.textContent = `Chapter ${activeChapterIndex + 1} of ${chapterCount}`;
  readerAuthor.textContent = `${activeStory.author} · ${readerChapterProgress.textContent}`;
}

async function renderChapter(index, { scrollToTop = true } = {}) {
  if (!activeStory) return;
  activeChapterIndex = Math.max(0, Math.min(index, activeStory.chapters.length - 1));
  const chapter = activeStory.chapters[activeChapterIndex];

  disconnectFrameResize();
  readerFrame.style.height = "1px";
  readerFrame.srcdoc = buildReaderDocument(activeStory, chapter);
  syncChapterControls();

  activeStory.lastChapterIndex = activeChapterIndex;
  saveStory(activeStory).catch((error) => console.warn("Could not save chapter position", error));
  document.title = `${chapter.title} · ${activeStory.title} · Homeslop`;
  setFooter(`CHAPTER ${activeChapterIndex + 1}/${activeStory.chapters.length}`);

  if (scrollToTop) {
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }
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
    throw new Error("The import endpoint could not be reached.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = `Import failed with HTTP ${response.status}.`;
    if (contentType.includes("application/json")) {
      const payload = await response.json().catch(() => null);
      if (payload?.error) message = readableError(payload.error);
    } else {
      const text = await response.text().catch(() => "");
      if (text.trim()) message = text.trim().slice(0, 500);
    }
    throw new Error(message);
  }

  setStatus("busy", "READING WORK", "page received; locating chapters...");
  const responseHtml = await response.text();
  const extracted = extractWork(responseHtml, url, workId);
  setStatus(
    "busy",
    "PRESERVING FORMAT",
    `captured HTML, workskin CSS, and ${extracted.chapters.length} ${
      extracted.chapters.length === 1 ? "chapter" : "chapters"
    }.`,
  );

  const existing = await getStory(`ao3-${workId}`).catch(() => null);
  const story = {
    id: `ao3-${workId}`,
    source: "AO3",
    sourceUrl: url,
    workId,
    title: extracted.title,
    author: extracted.author,
    workHtml: extracted.workHtml,
    inlineStyles: extracted.inlineStyles,
    chapters: extracted.chapters,
    lastChapterIndex: Math.min(existing?.lastChapterIndex || 0, extracted.chapters.length - 1),
    importedAt: existing?.importedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveStory(story);
  setStatus("success", "IMPORT COMPLETE", `saved “${story.title}” chapter by chapter.`);
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

  stories.sort((a, b) => new Date(b.updatedAt || b.importedAt) - new Date(a.updatedAt || a.importedAt));
  bookList.replaceChildren();
  bookCount.textContent = `${stories.length} ${stories.length === 1 ? "FILE" : "FILES"}`;
  emptyLibrary.hidden = stories.length > 0;
  bookList.hidden = stories.length === 0;

  stories.forEach((storedStory) => {
    const story = ensureStoryChapters(storedStory);
    const fragment = bookTemplate.content.cloneNode(true);
    const button = fragment.querySelector(".book-open");
    const chapterCount = story.chapters.length;
    fragment.querySelector(".book-source").textContent = story.source || "LOCAL";
    fragment.querySelector(".book-title").textContent = story.title;
    fragment.querySelector(".book-author").textContent = `by ${story.author || "Unknown"} · ${chapterCount} ${
      chapterCount === 1 ? "chapter" : "chapters"
    }`;
    button.addEventListener("click", () => openReader(story.id));
    bookList.append(fragment);
  });
}

async function openReader(id) {
  const storedStory = await getStory(id);
  if (!storedStory) return;

  activeStory = ensureStoryChapters(storedStory);
  activeChapterIndex = Math.min(activeStory.lastChapterIndex || 0, activeStory.chapters.length - 1);
  readerTitle.textContent = activeStory.title;
  populateChapterSelect(activeStory);
  showView("reader");
  await saveStory(activeStory).catch(() => {});
  await renderChapter(activeChapterIndex, { scrollToTop: true });
}

async function deleteActiveStory() {
  if (!activeStory) return;
  const confirmed = window.confirm(`Delete “${activeStory.title}” from this device?`);
  if (!confirmed) return;

  await removeStory(activeStory.id);
  activeStory = null;
  activeChapterIndex = 0;
  readerFrame.srcdoc = "";
  document.title = "Homeslop";
  await refreshLibrary();
  setFooter("DELETED");
  showView("library");
}

function changeChapter(delta) {
  if (!activeStory) return;
  const nextIndex = activeChapterIndex + delta;
  if (nextIndex < 0 || nextIndex >= activeStory.chapters.length) return;
  renderChapter(nextIndex, { scrollToTop: true });
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
  activeStory = null;
  activeChapterIndex = 0;
  readerFrame.srcdoc = "";
  document.title = "Homeslop";
  setFooter("READY");
  showView("library");
});

readerDelete.addEventListener("click", deleteActiveStory);
readerPrevButtons.forEach((button) => button.addEventListener("click", () => changeChapter(-1)));
readerNextButtons.forEach((button) => button.addEventListener("click", () => changeChapter(1)));
readerChapterSelect.addEventListener("change", () => {
  renderChapter(Number(readerChapterSelect.value), { scrollToTop: true });
});
readerFrame.addEventListener("load", prepareReaderFrame);
window.addEventListener("resize", resizeReaderFrame);
window.addEventListener("orientationchange", () => setTimeout(resizeReaderFrame, 150));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resetStatus();

  try {
    const story = await importAO3Work(urlInput.value);
    setTimeout(() => openReader(story.id), 350);
  } catch (error) {
    console.error(error);
    setStatus("error", "IMPORT FAILED", error instanceof Error ? error.message : readableError(error));
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
