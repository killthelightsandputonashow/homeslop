const STATE_DB_NAME = "homeslop-library";
const STATE_DB_VERSION = 1;
const STATE_STORE_NAME = "stories";
const PROGRESS_STORAGE_KEY = "homeslop-reading-progress-v2";
const LEGACY_PROGRESS_STORAGE_KEY = "homeslop-reading-progress-v1";
const WORD_STORAGE_KEY = "homeslop-word-stats-v1";

const readerView = document.querySelector("#reader-view");
const readerTitle = document.querySelector("#reader-title");
const readerAuthor = document.querySelector("#reader-author");
const chapterSelect = document.querySelector("#reader-chapter-select");
const readerTopbar = document.querySelector(".reader-topbar");
const bookList = document.querySelector("#book-list");

let activeStory = null;
let activeChapterIndex = 0;
let activeRenderKey = "";
let pendingStoryId = null;
let resolveTimer = 0;
let libraryTimer = 0;
let saveTimer = 0;
let scrollFrame = 0;
let restoringUntil = 0;

function loadObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const progressStore = {
  ...loadObject(LEGACY_PROGRESS_STORAGE_KEY),
  ...loadObject(PROGRESS_STORAGE_KEY),
};
const wordStore = loadObject(WORD_STORAGE_KEY);

function persist(key, value) {
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

async function getAllStories() {
  const db = await openStateDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STATE_STORE_NAME, "readonly");
    const request = tx.objectStore(STATE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

async function mergeStoryState(storyId, patch) {
  if (!storyId) return;
  try {
    const db = await openStateDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STATE_STORE_NAME, "readwrite");
      const store = tx.objectStore(STATE_STORE_NAME);
      const request = store.get(storyId);
      request.onsuccess = () => {
        const story = request.result;
        if (story) store.put({ ...story, ...patch });
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn("Homeslop could not save reading state", error);
  }
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function storySignature(story) {
  const chapters = Array.isArray(story.chapters) ? story.chapters : [];
  return `${chapters.length}:${chapters.map((chapter) => String(chapter.html || "").length).join(":")}`;
}

function countWords(html) {
  const documentNode = new DOMParser().parseFromString(String(html || ""), "text/html");
  documentNode.querySelectorAll("style, script, noscript").forEach((element) => element.remove());
  const text = normalized(documentNode.body.textContent);
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

  const chapterWords = (story.chapters || []).map((chapter) => countWords(chapter.html));
  const stats = {
    signature,
    chapterWords,
    totalWords: chapterWords.reduce((total, value) => total + value, 0),
  };
  wordStore[story.id] = stats;
  persist(WORD_STORAGE_KEY, wordStore);
  mergeStoryState(story.id, {
    chapterWordCounts: chapterWords,
    totalWordCount: stats.totalWords,
  });
  return stats;
}

function progressFor(story) {
  const chapterCount = Math.max(1, story.chapters?.length || 1);
  const stored = progressStore[story.id] || {};
  const lastChapterIndex = Math.max(
    0,
    Math.min(
      Number.isFinite(stored.lastChapterIndex)
        ? stored.lastChapterIndex
        : Number(story.lastChapterIndex) || 0,
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

function saveProgress(story, state) {
  progressStore[story.id] = state;
  persist(PROGRESS_STORAGE_KEY, progressStore);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    mergeStoryState(story.id, {
      lastChapterIndex: state.lastChapterIndex,
      chapterProgress: state.chapterProgress,
      lastReadAt: state.lastReadAt,
    });
  }, 450);
}

function overallProgress(story, state) {
  const chapterCount = Math.max(1, story.chapters?.length || 1);
  const withinChapter = clamp(state.chapterProgress?.[String(state.lastChapterIndex)]);
  return clamp((state.lastChapterIndex + withinChapter) / chapterCount);
}

function formatWords(value) {
  return `${new Intl.NumberFormat().format(value || 0)} words`;
}

function installStyles() {
  if (document.querySelector("#homeslop-reader-state-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-reader-state-style";
  style.textContent = `
    .reader-topbar { overflow: visible !important; }
    .homeslop-reader-progress {
      position: absolute;
      left: 0;
      right: 0;
      bottom: -4px;
      z-index: 20;
      height: 4px;
      overflow: hidden;
      background: rgba(127, 127, 127, .3);
      pointer-events: none;
    }
    .homeslop-reader-progress > span {
      display: block;
      width: 0;
      height: 100%;
      background: #f7b500;
      transition: width 100ms linear;
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
    .homeslop-book-progress > span { display: block; height: 100%; background: #f7b500; }
    html[data-homeslop-theme="dark"] .homeslop-book-details { color: #aaa; }
    html[data-homeslop-theme="dark"] .homeslop-book-resume { color: #ddd; }
    html[data-homeslop-theme="dark"] .homeslop-book-progress { border-color: #666; background: #222; }
  `;
  document.head.append(style);
}

let readerProgressFill = null;
function ensureReaderProgressBar() {
  if (!readerTopbar) return null;
  let track = readerTopbar.querySelector(".homeslop-reader-progress");
  if (!track) {
    track = document.createElement("div");
    track.className = "homeslop-reader-progress";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Current chapter progress");
    track.append(document.createElement("span"));
    readerTopbar.append(track);
  }
  readerProgressFill = track.firstElementChild;
  return track;
}

function updateChapterBar(value) {
  const track = ensureReaderProgressBar();
  if (!track || !readerProgressFill) return;
  const percent = Math.round(clamp(value) * 100);
  readerProgressFill.style.width = `${percent}%`;
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(percent));
  track.title = `Chapter ${percent}% read`;
}

async function decorateLibrary() {
  libraryTimer = 0;
  if (!bookList || bookList.hidden) return;

  let stories;
  try {
    stories = await getAllStories();
  } catch (error) {
    console.warn("Homeslop could not decorate the library", error);
    return;
  }

  const titleMap = new Map();
  stories.forEach((story) => {
    const key = normalized(story.title);
    if (!titleMap.has(key)) titleMap.set(key, []);
    titleMap.get(key).push(story);
  });

  bookList.querySelectorAll(".book-row").forEach((row) => {
    const title = normalized(row.querySelector(".book-title")?.textContent);
    const authorLine = normalized(row.querySelector(".book-author")?.textContent);
    const candidates = titleMap.get(title) || [];
    const story = candidates.find((item) => authorLine.includes(normalized(item.author))) || candidates[0];
    if (!story) return;

    row.dataset.storyId = story.id;
    const stats = ensureWordStats(story);
    const state = progressFor(story);
    const chapterCount = Math.max(1, story.chapters?.length || 1);
    const chapterProgress = clamp(state.chapterProgress?.[String(state.lastChapterIndex)]);
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
    track.setAttribute("aria-label", `Whole-fic progress for ${story.title}`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(overall * 100)));
    const fill = document.createElement("span");
    fill.style.width = `${Math.round(overall * 100)}%`;
    track.append(fill);
    details.append(summary, resume, track);
  });
}

function scheduleLibraryDecoration() {
  if (libraryTimer) clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(decorateLibrary, 60);
}

function visibleReader() {
  return Boolean(readerView?.classList.contains("is-visible"));
}

function readerMetrics() {
  const host = document.querySelector("#reader-shadow");
  const documentShell = host?.shadowRoot?.querySelector(".reader-document");
  if (!host || !documentShell || host.offsetHeight < 2) return null;

  const topbarHeight = readerTopbar?.offsetHeight || 0;
  const visibleHeight = Math.max(1, window.innerHeight - topbarHeight);
  const start = host.getBoundingClientRect().top + window.scrollY - topbarHeight;
  const distance = Math.max(1, host.offsetHeight - visibleHeight);
  return { start, distance };
}

function currentChapterProgress() {
  const metrics = readerMetrics();
  if (!metrics) return 0;
  return clamp((window.scrollY - metrics.start) / metrics.distance);
}

function saveCurrentScroll() {
  if (!activeStory || !visibleReader() || Date.now() < restoringUntil) return;
  const progress = currentChapterProgress();
  const state = progressFor(activeStory);
  state.lastChapterIndex = activeChapterIndex;
  state.chapterProgress[String(activeChapterIndex)] = progress;
  state.lastReadAt = new Date().toISOString();
  saveProgress(activeStory, state);
  updateChapterBar(progress);
}

function handleScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    saveCurrentScroll();
  });
}

function restorePosition(story, chapterIndex, attempt = 0) {
  const metrics = readerMetrics();
  if (!metrics) {
    if (attempt < 20) window.setTimeout(() => restorePosition(story, chapterIndex, attempt + 1), 80);
    return;
  }

  const state = progressFor(story);
  const saved = clamp(state.chapterProgress?.[String(chapterIndex)]);
  restoringUntil = Date.now() + 500;
  window.scrollTo({ top: metrics.start + saved * metrics.distance, behavior: "instant" });
  updateChapterBar(saved);
}

async function resolveStoryByIdOrHeader() {
  let stories;
  try {
    stories = await getAllStories();
  } catch {
    return null;
  }

  const explicitId = readerView?.dataset.storyId || pendingStoryId;
  if (explicitId) {
    const exact = stories.find((story) => story.id === explicitId);
    if (exact) return exact;
  }

  const title = normalized(readerTitle?.textContent);
  const authorLine = normalized(readerAuthor?.textContent);
  return (
    stories.find((story) => normalized(story.title) === title && authorLine.includes(normalized(story.author))) ||
    stories.find((story) => normalized(story.title) === title) ||
    null
  );
}

async function resolveActiveReader() {
  resolveTimer = 0;
  if (!visibleReader()) {
    activeStory = null;
    activeRenderKey = "";
    pendingStoryId = null;
    scheduleLibraryDecoration();
    return;
  }

  const story = await resolveStoryByIdOrHeader();
  if (!story || !chapterSelect?.options.length) return;

  const currentIndex = Math.max(
    0,
    Math.min(Number(chapterSelect.value) || 0, Math.max(0, (story.chapters?.length || 1) - 1)),
  );
  const isNewStory = activeStory?.id !== story.id;
  const state = progressFor(story);

  activeStory = story;
  readerView.dataset.storyId = story.id;

  if (isNewStory && state.lastChapterIndex !== currentIndex) {
    chapterSelect.value = String(state.lastChapterIndex);
    chapterSelect.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  activeChapterIndex = currentIndex;
  state.lastChapterIndex = currentIndex;
  state.lastReadAt = new Date().toISOString();
  progressStore[story.id] = state;
  persist(PROGRESS_STORAGE_KEY, progressStore);

  const renderKey = `${story.id}:${currentIndex}`;
  if (renderKey !== activeRenderKey) {
    activeRenderKey = renderKey;
    restorePosition(story, currentIndex);
  } else {
    updateChapterBar(clamp(state.chapterProgress?.[String(currentIndex)]));
  }
}

function scheduleResolve() {
  if (resolveTimer) clearTimeout(resolveTimer);
  resolveTimer = window.setTimeout(resolveActiveReader, 60);
}

installStyles();
ensureReaderProgressBar();

bookList?.addEventListener(
  "click",
  (event) => {
    const row = event.target.closest(".book-row");
    if (!row?.dataset.storyId) return;
    pendingStoryId = row.dataset.storyId;
    readerView.dataset.storyId = pendingStoryId;
  },
  true,
);

chapterSelect?.addEventListener("change", scheduleResolve);
window.addEventListener("scroll", handleScroll, { passive: true });
window.addEventListener("resize", scheduleResolve);
window.addEventListener("pagehide", saveCurrentScroll);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveCurrentScroll();
});

if (bookList) {
  new MutationObserver(scheduleLibraryDecoration).observe(bookList, { childList: true });
}

if (readerView) {
  new MutationObserver(scheduleResolve).observe(readerView, {
    attributes: true,
    attributeFilter: ["class", "data-story-id"],
    childList: true,
    subtree: true,
    characterData: true,
  });
}

new MutationObserver(scheduleResolve).observe(document.body, { childList: true, subtree: true });

scheduleLibraryDecoration();
scheduleResolve();