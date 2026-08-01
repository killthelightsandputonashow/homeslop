const STATE_DB_NAME = "homeslop-library";
const STATE_DB_VERSION = 1;
const STATE_STORE_NAME = "stories";
const PROGRESS_STORAGE_KEY = "homeslop-reading-progress-v1";
const WORD_STORAGE_KEY = "homeslop-word-stats-v1";

const readerView = document.querySelector("#reader-view");
const readerTitle = document.querySelector("#reader-title");
const readerAuthor = document.querySelector("#reader-author");
const chapterSelect = document.querySelector("#reader-chapter-select");
const readerTopbar = document.querySelector(".reader-topbar");
const bookList = document.querySelector("#book-list");

let activeStory = null;
let activeChapterIndex = 0;
let activeStoryId = null;
let activeRenderKey = "";
let resolveTimer = 0;
let libraryTimer = 0;
let saveTimer = 0;
let scrollFrame = 0;
let restoringScroll = false;

function loadStoredObject(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const progressStore = loadStoredObject(PROGRESS_STORAGE_KEY);
const wordStore = loadStoredObject(WORD_STORAGE_KEY);

function persistStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Homeslop could not persist ${key}`, error);
  }
}

function openStateDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STATE_DB_NAME, STATE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STATE_STORE_NAME)) {
        const store = db.createObjectStore(STATE_STORE_NAME, { keyPath: "id" });
        store.createIndex("importedAt", "importedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllStoredStories() {
  const db = await openStateDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE_NAME, "readonly");
    const request = tx.objectStore(STATE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function mergeStoryState(storyId, patch) {
  try {
    const db = await openStateDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE_NAME, "readwrite");
      const store = tx.objectStore(STATE_STORE_NAME);
      const getRequest = store.get(storyId);

      getRequest.onsuccess = () => {
        const story = getRequest.result;
        if (!story) return;
        store.put({ ...story, ...patch });
      };
      getRequest.onerror = () => reject(getRequest.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("Homeslop could not merge reading state into IndexedDB", error);
  }
}

function storySignature(story) {
  const chapters = Array.isArray(story.chapters) ? story.chapters : [];
  return `${chapters.length}:${chapters.map((chapter) => String(chapter.html || "").length).join(":")}`;
}

function countWordsInHtml(html) {
  const documentNode = new DOMParser().parseFromString(String(html || ""), "text/html");
  documentNode.querySelectorAll("style, script, noscript").forEach((element) => element.remove());
  const text = (documentNode.body.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return 0;

  try {
    return text.match(/[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu)?.length || 0;
  } catch {
    return text.split(" ").filter(Boolean).length;
  }
}

function ensureWordStats(story) {
  const signature = storySignature(story);
  const cached = wordStore[story.id];
  if (cached?.signature === signature && Array.isArray(cached.chapterWords)) return cached;

  const chapters = Array.isArray(story.chapters) ? story.chapters : [];
  const chapterWords = chapters.map((chapter) => countWordsInHtml(chapter.html));
  const stats = {
    signature,
    chapterWords,
    totalWords: chapterWords.reduce((total, count) => total + count, 0),
  };
  wordStore[story.id] = stats;
  persistStore(WORD_STORAGE_KEY, wordStore);

  mergeStoryState(story.id, {
    chapterWordCounts: chapterWords,
    totalWordCount: stats.totalWords,
  });
  return stats;
}

function progressForStory(story) {
  const chapterCount = Math.max(1, story.chapters?.length || 1);
  const stored = progressStore[story.id] || {};
  const lastChapterIndex = Math.max(
    0,
    Math.min(
      Number.isFinite(stored.lastChapterIndex) ? stored.lastChapterIndex : story.lastChapterIndex || 0,
      chapterCount - 1,
    ),
  );

  return {
    lastChapterIndex,
    chapterProgress:
      stored.chapterProgress && typeof stored.chapterProgress === "object"
        ? stored.chapterProgress
        : {},
    lastReadAt: stored.lastReadAt || null,
  };
}

function saveProgressState(storyId, state) {
  progressStore[storyId] = state;
  persistStore(PROGRESS_STORAGE_KEY, progressStore);
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function overallProgress(story, state) {
  const chapterCount = Math.max(1, story.chapters?.length || 1);
  const chapterProgress = clamp(Number(state.chapterProgress?.[state.lastChapterIndex]) || 0);
  return clamp((state.lastChapterIndex + chapterProgress) / chapterCount);
}

function formatWords(value) {
  return `${new Intl.NumberFormat().format(value || 0)} words`;
}

function installStateStyles() {
  if (document.querySelector("#homeslop-reader-state-style")) return;

  const style = document.createElement("style");
  style.id = "homeslop-reader-state-style";
  style.textContent = `
    .reader-topbar {
      overflow: visible !important;
    }

    .homeslop-reader-progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: -4px;
      z-index: 20;
      height: 4px;
      overflow: hidden;
      background: rgba(127, 127, 127, .28);
      pointer-events: none;
    }

    .homeslop-reader-progress > span {
      display: block;
      width: 0;
      height: 100%;
      background: #f7b500;
      transition: width 120ms linear;
    }

    .homeslop-book-details {
      display: block;
      margin-top: .28rem;
      color: #555;
      font-family: "Courier New", Courier, monospace;
      font-size: .78rem;
      line-height: 1.35;
    }

    .homeslop-book-resume {
      display: block;
      margin-top: .15rem;
      font-weight: 700;
      color: #333;
    }

    .homeslop-book-progress {
      display: block;
      width: 100%;
      height: 6px;
      margin-top: .48rem;
      overflow: hidden;
      border: 1px solid #333;
      background: #eee;
    }

    .homeslop-book-progress > span {
      display: block;
      height: 100%;
      background: #f7b500;
    }

    html[data-homeslop-theme="dark"] .homeslop-book-details {
      color: #aaa;
    }

    html[data-homeslop-theme="dark"] .homeslop-book-resume {
      color: #ddd;
    }

    html[data-homeslop-theme="dark"] .homeslop-book-progress {
      border-color: #666;
      background: #222;
    }
  `;
  document.head.append(style);
}

installStateStyles();

let readerProgressFill = null;
function ensureReaderProgressBar() {
  if (!readerTopbar) return null;
  let track = readerTopbar.querySelector(".homeslop-reader-progress");
  if (!track) {
    track = document.createElement("div");
    track.className = "homeslop-reader-progress";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Overall reading progress");
    const fill = document.createElement("span");
    track.append(fill);
    readerTopbar.append(track);
  }
  readerProgressFill = track.firstElementChild;
  return track;
}

function updateReaderProgressBar(value) {
  const track = ensureReaderProgressBar();
  if (!track || !readerProgressFill) return;
  const percent = Math.round(clamp(value) * 100);
  readerProgressFill.style.width = `${percent}%`;
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(percent));
  track.title = `${percent}% read`;
}

async function decorateLibrary() {
  libraryTimer = 0;
  if (!bookList || bookList.hidden) return;

  let stories = [];
  try {
    stories = await getAllStoredStories();
  } catch (error) {
    console.warn("Homeslop could not read story metadata", error);
    return;
  }

  const storiesByTitle = new Map();
  stories.forEach((story) => {
    if (!storiesByTitle.has(story.title)) storiesByTitle.set(story.title, []);
    storiesByTitle.get(story.title).push(story);
  });

  bookList.querySelectorAll(".book-row").forEach((row) => {
    const title = row.querySelector(".book-title")?.textContent?.trim();
    const authorLine = row.querySelector(".book-author")?.textContent || "";
    const candidates = storiesByTitle.get(title) || [];
    const story = candidates.find((candidate) => authorLine.includes(candidate.author)) || candidates[0];
    if (!story) return;

    const stats = ensureWordStats(story);
    const state = progressForStory(story);
    const chapterCount = Math.max(1, story.chapters?.length || 1);
    const chapterProgress = clamp(Number(state.chapterProgress?.[state.lastChapterIndex]) || 0);
    const overall = overallProgress(story, state);

    let details = row.querySelector(".homeslop-book-details");
    if (!details) {
      details = document.createElement("span");
      details.className = "homeslop-book-details";
      row.querySelector(".book-meta")?.append(details);
    }

    details.replaceChildren();
    const summary = document.createElement("span");
    summary.textContent = `${chapterCount} ${chapterCount === 1 ? "chapter" : "chapters"} · ${formatWords(stats.totalWords)}`;

    const resume = document.createElement("span");
    resume.className = "homeslop-book-resume";
    resume.textContent = `Left off: Chapter ${state.lastChapterIndex + 1} · ${Math.round(chapterProgress * 100)}%`;

    const track = document.createElement("span");
    track.className = "homeslop-book-progress";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `Reading progress for ${story.title}`);
    track.setAttribute("aria-valuenow", String(Math.round(overall * 100)));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.style.width = `${Math.round(overall * 100)}%`;
    track.append(fill);

    details.append(summary, resume, track);
  });
}

function scheduleLibraryDecoration() {
  if (libraryTimer) clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(decorateLibrary, 40);
}

function visibleReader() {
  return Boolean(readerView?.classList.contains("is-visible"));
}

function readerDocumentMetrics() {
  const host = document.querySelector("#reader-shadow");
  if (!host || !host.shadowRoot?.querySelector(".reader-document")) return null;

  const rect = host.getBoundingClientRect();
  const start = rect.top + window.scrollY;
  const readableHeight = Math.max(1, host.offsetHeight - window.innerHeight + 24);
  return { host, start, readableHeight };
}

function scheduleDbSave(story, state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    mergeStoryState(story.id, {
      lastChapterIndex: state.lastChapterIndex,
      chapterProgress: state.chapterProgress,
      lastReadAt: state.lastReadAt,
    });
  }, 700);
}

function currentProgressFromScroll() {
  if (!activeStory || !visibleReader() || restoringScroll) return;
  const metrics = readerDocumentMetrics();
  if (!metrics) return;

  const chapterProgress = clamp((window.scrollY - metrics.start) / metrics.readableHeight);
  const state = progressForStory(activeStory);
  state.lastChapterIndex = activeChapterIndex;
  state.chapterProgress[String(activeChapterIndex)] = chapterProgress;
  state.lastReadAt = new Date().toISOString();
  saveProgressState(activeStory.id, state);
  scheduleDbSave(activeStory, state);
  updateReaderProgressBar(overallProgress(activeStory, state));
}

function handleScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    currentProgressFromScroll();
  });
}

function restoreChapterPosition(story, chapterIndex) {
  const metrics = readerDocumentMetrics();
  if (!metrics) return false;

  const state = progressForStory(story);
  const saved = clamp(Number(state.chapterProgress?.[chapterIndex]) || 0);
  restoringScroll = true;
  const target = metrics.start + saved * metrics.readableHeight;
  window.scrollTo({ top: target, behavior: "instant" });
  requestAnimationFrame(() => {
    restoringScroll = false;
    updateReaderProgressBar(overallProgress(story, state));
  });
  return true;
}

function scheduleRestore(story, chapterIndex) {
  let attempts = 0;
  const tryRestore = () => {
    attempts += 1;
    if (restoreChapterPosition(story, chapterIndex) || attempts >= 8) return;
    window.setTimeout(tryRestore, 90);
  };
  window.setTimeout(tryRestore, 100);
}

async function resolveActiveReader() {
  resolveTimer = 0;

  if (!visibleReader()) {
    activeStory = null;
    activeStoryId = null;
    activeRenderKey = "";
    scheduleLibraryDecoration();
    return;
  }

  const title = readerTitle?.textContent?.trim();
  const authorLine = readerAuthor?.textContent || "";
  if (!title || !chapterSelect?.options.length) return;

  let stories = [];
  try {
    stories = await getAllStoredStories();
  } catch {
    return;
  }

  const story =
    stories.find((candidate) => candidate.title === title && authorLine.includes(candidate.author)) ||
    stories.find((candidate) => candidate.title === title);
  if (!story) return;

  ensureWordStats(story);
  const state = progressForStory(story);
  const currentIndex = clamp(Number(chapterSelect.value) || 0, 0, Math.max(0, story.chapters.length - 1));
  const isNewStoryOpen = activeStoryId !== story.id;

  activeStory = story;
  activeStoryId = story.id;

  if (isNewStoryOpen && state.lastChapterIndex !== currentIndex) {
    chapterSelect.value = String(state.lastChapterIndex);
    chapterSelect.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  activeChapterIndex = currentIndex;
  state.lastChapterIndex = currentIndex;
  state.lastReadAt = new Date().toISOString();
  saveProgressState(story.id, state);

  const renderKey = `${story.id}:${currentIndex}`;
  if (renderKey !== activeRenderKey) {
    activeRenderKey = renderKey;
    scheduleRestore(story, currentIndex);
  } else {
    updateReaderProgressBar(overallProgress(story, state));
  }
}

function scheduleResolveReader() {
  if (resolveTimer) clearTimeout(resolveTimer);
  resolveTimer = window.setTimeout(resolveActiveReader, 45);
}

bookList?.addEventListener("click", scheduleResolveReader);
chapterSelect?.addEventListener("change", scheduleResolveReader);
window.addEventListener("scroll", handleScroll, { passive: true });
window.addEventListener("resize", scheduleResolveReader);
window.addEventListener("pagehide", currentProgressFromScroll);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") currentProgressFromScroll();
});

if (bookList) {
  new MutationObserver(scheduleLibraryDecoration).observe(bookList, {
    childList: true,
  });
}

if (readerView) {
  new MutationObserver(scheduleResolveReader).observe(readerView, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
    characterData: true,
  });
}

const shadowHostObserver = new MutationObserver(scheduleResolveReader);
shadowHostObserver.observe(document.body, { childList: true, subtree: true });

ensureReaderProgressBar();
scheduleLibraryDecoration();
scheduleResolveReader();
