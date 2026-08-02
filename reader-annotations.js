const ANNOTATION_KEY = "homeslop-annotations-v1";
const HIGHLIGHT_ATTR = "data-homeslop-highlight-id";
const NOTE_PIN_ATTR = "data-homeslop-note-pin";
const TOOLBAR_ID = "homeslop-selection-toolbar";
const EDITOR_ID = "homeslop-annotation-editor";

let annotations = loadAnnotations();
let pendingAnchor = null;
let activeAnnotationId = null;
let shadowObserver = null;
let shellObserver = null;
let renderFrame = 0;
let selectionTimer = 0;
let currentShadow = null;
let lastClickedStoryId = null;

function loadAnnotations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANNOTATION_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistAnnotations() {
  localStorage.setItem(ANNOTATION_KEY, JSON.stringify(annotations));
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function storyKey() {
  const readerView = document.querySelector("#reader-view");
  if (readerView?.dataset.storyId) return readerView.dataset.storyId;
  if (lastClickedStoryId) return lastClickedStoryId;

  const title = normalize(document.querySelector("#reader-title")?.textContent);
  const author = normalize(document.querySelector("#reader-author")?.textContent)
    .replace(/\s*·\s*Chapter\s+\d+.*$/i, "");
  return `fallback:${title}|${author}`;
}

function chapterIndex() {
  return Math.max(0, Number(document.querySelector("#reader-chapter-select")?.value) || 0);
}

function chapterAnnotations() {
  const key = storyKey();
  const chapter = chapterIndex();
  return annotations.filter(
    (annotation) => annotation.storyKey === key && Number(annotation.chapterIndex) === chapter,
  );
}

function shouldIgnoreTextNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue) return true;
  return Boolean(
    parent.closest(
      "script, style, noscript, button, select, textarea, input, [aria-hidden='true'], .homeslop-song-hidden-link",
    ),
  );
}

function flatten(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldIgnoreTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let text = "";
  let node;
  while ((node = walker.nextNode())) {
    const start = text.length;
    text += node.nodeValue;
    nodes.push({ node, start, end: text.length });
  }
  return { text, nodes };
}

function rangeOffset(flat, container, offset) {
  if (container?.nodeType !== Node.TEXT_NODE) return null;
  const entry = flat.nodes.find((item) => item.node === container);
  if (!entry) return null;
  return entry.start + Math.min(offset, container.nodeValue.length);
}

function selectionTouchesExistingHighlight(range, shadow) {
  return [...shadow.querySelectorAll(`mark[${HIGHLIGHT_ATTR}]`)].some((mark) => {
    try {
      return range.intersectsNode(mark);
    } catch {
      return false;
    }
  });
}

function anchorFromSelection(range, workskin, shadow) {
  const quote = range.toString();
  if (!normalize(quote) || quote.length > 1800) return null;
  if (selectionTouchesExistingHighlight(range, shadow)) return null;

  const flat = flatten(workskin);
  let start = rangeOffset(flat, range.startContainer, range.startOffset);
  let end = rangeOffset(flat, range.endContainer, range.endOffset);

  if (start == null || end == null || end <= start || flat.text.slice(start, end) !== quote) {
    start = flat.text.indexOf(quote);
    if (start < 0) return null;
    end = start + quote.length;
  }

  const matchesBefore = flat.text.slice(0, start).split(quote).length - 1;
  return {
    quote,
    prefix: flat.text.slice(Math.max(0, start - 48), start),
    suffix: flat.text.slice(end, end + 48),
    occurrence: Math.max(0, matchesBefore),
  };
}

function findQuote(text, annotation) {
  const quote = String(annotation.quote || "");
  if (!quote) return -1;

  const matches = [];
  let cursor = 0;
  while (cursor <= text.length - quote.length) {
    const index = text.indexOf(quote, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(1, quote.length);
  }
  if (!matches.length) return -1;

  let best = matches[Math.min(annotation.occurrence || 0, matches.length - 1)];
  let bestScore = -1;
  matches.forEach((index) => {
    const left = text.slice(Math.max(0, index - annotation.prefix.length), index);
    const right = text.slice(index + quote.length, index + quote.length + annotation.suffix.length);
    let score = 0;

    for (let i = 1; i <= Math.min(left.length, annotation.prefix.length); i += 1) {
      if (left.at(-i) !== annotation.prefix.at(-i)) break;
      score += 1;
    }
    for (let i = 0; i < Math.min(right.length, annotation.suffix.length); i += 1) {
      if (right[i] !== annotation.suffix[i]) break;
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

function unwrapHighlights(workskin) {
  workskin.querySelectorAll(`mark[${HIGHLIGHT_ATTR}]`).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  workskin.normalize();
}

function wrapInterval(flat, start, end, annotation) {
  flat.nodes
    .filter((entry) => entry.end > start && entry.start < end)
    .reverse()
    .forEach((entry) => {
      if (!entry.node.parentNode) return;
      const from = Math.max(0, start - entry.start);
      const to = Math.min(entry.node.nodeValue.length, end - entry.start);
      if (to <= from) return;

      const range = document.createRange();
      range.setStart(entry.node, from);
      range.setEnd(entry.node, to);
      const mark = document.createElement("mark");
      mark.setAttribute(HIGHLIGHT_ATTR, annotation.id);
      try {
        range.surroundContents(mark);
      } catch {
        return;
      }
    });
}

function installShadowStyles(shadow) {
  if (shadow.querySelector("#homeslop-annotation-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-annotation-style";
  style.textContent = `
    mark[${HIGHLIGHT_ATTR}] {
      padding: .04em .02em;
      border-radius: .12em;
      color: inherit !important;
      background: rgba(255, 214, 10, .38) !important;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      cursor: pointer;
    }
    :host(:not([data-theme="dark"])) mark[${HIGHLIGHT_ATTR}] {
      background: rgba(255, 218, 52, .5) !important;
    }
    mark[${NOTE_PIN_ATTR}]::after {
      content: "✎";
      display: inline-grid;
      place-items: center;
      width: 1.35em;
      height: 1.35em;
      margin-left: .18em;
      border: 1px solid currentColor;
      border-radius: 50%;
      color: #171717;
      background: #ffd83d;
      font: 700 .72em/1 "Courier New", monospace;
      vertical-align: .28em;
      box-shadow: 1px 1px 0 rgba(0,0,0,.3);
    }
  `;
  shadow.append(style);
}

function observeShadow(shadow) {
  shadowObserver?.disconnect();
  shadowObserver = new MutationObserver(scheduleRender);
  shadowObserver.observe(shadow, { childList: true, subtree: true });
}

function renderAnnotations() {
  renderFrame = 0;
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  shadowObserver?.disconnect();
  try {
    installShadowStyles(shadow);
    unwrapHighlights(workskin);
    const flat = flatten(workskin);
    const located = chapterAnnotations()
      .map((annotation) => {
        const start = findQuote(flat.text, annotation);
        return start < 0 ? null : { annotation, start, end: start + annotation.quote.length };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const accepted = [];
    let occupiedUntil = -1;
    located.forEach((item) => {
      if (item.start < occupiedUntil) return;
      accepted.push(item);
      occupiedUntil = item.end;
    });

    [...accepted].reverse().forEach((item) => {
      wrapInterval(flat, item.start, item.end, item.annotation);
    });

    accepted.forEach(({ annotation }) => {
      if (!annotation.note) return;
      const fragments = workskin.querySelectorAll(
        `mark[${HIGHLIGHT_ATTR}="${CSS.escape(annotation.id)}"]`,
      );
      fragments[fragments.length - 1]?.setAttribute(NOTE_PIN_ATTR, "");
    });
  } finally {
    observeShadow(shadow);
  }
}

function scheduleRender() {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(renderAnnotations);
}

function installMainStyles() {
  if (document.querySelector("#homeslop-annotation-main-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-annotation-main-style";
  style.textContent = `
    #${TOOLBAR_ID} {
      position: fixed;
      left: 50%;
      bottom: calc(.8rem + env(safe-area-inset-bottom));
      z-index: 10030;
      display: none;
      transform: translateX(-50%);
      gap: .35rem;
      padding: .42rem;
      border: 2px solid #777;
      border-radius: 7px;
      background: #1c1c1c;
      box-shadow: 0 10px 30px rgba(0,0,0,.55);
    }
    #${TOOLBAR_ID}[data-open="true"] { display: flex; }
    #${TOOLBAR_ID} button,
    #${EDITOR_ID} button {
      min-height: 2.35rem;
      padding: .42rem .65rem;
      border: 1px solid #666;
      border-radius: 4px;
      color: #eee;
      background: #303030;
      font: 700 .72rem/1 "Courier New", monospace;
    }
    #${TOOLBAR_ID} .annotation-primary,
    #${EDITOR_ID} .annotation-save {
      color: #171717;
      background: #ffd83d;
      border-color: #c8a500;
    }
    #${EDITOR_ID} {
      position: fixed;
      left: max(.6rem, env(safe-area-inset-left));
      right: max(.6rem, env(safe-area-inset-right));
      bottom: calc(.6rem + env(safe-area-inset-bottom));
      z-index: 10040;
      display: none;
      max-width: 40rem;
      margin-inline: auto;
      padding: .8rem;
      border: 2px solid #777;
      border-radius: 8px;
      color: #eee;
      background: #181818;
      box-shadow: 0 14px 40px rgba(0,0,0,.65);
      font-family: "Lucida Grande", Verdana, sans-serif;
    }
    #${EDITOR_ID}[data-open="true"] { display: block; }
    #${EDITOR_ID} .annotation-quote {
      max-height: 6rem;
      margin: 0 0 .65rem;
      padding: .55rem;
      overflow: auto;
      border-left: 4px solid #ffd83d;
      color: #bbb;
      background: #101010;
      font-size: .78rem;
      line-height: 1.45;
    }
    #${EDITOR_ID} textarea {
      width: 100%;
      min-height: 7rem;
      padding: .65rem;
      box-sizing: border-box;
      resize: vertical;
      border: 1px solid #666;
      border-radius: 4px;
      color: #eee;
      background: #0e0e0e;
      font: 1rem/1.45 "Lucida Grande", Verdana, sans-serif;
    }
    #${EDITOR_ID} .annotation-actions { display: flex; gap: .4rem; margin-top: .55rem; }
    #${EDITOR_ID} .annotation-delete { margin-left: auto; color: #ff9bac; }
  `;
  document.head.append(style);
}

function ensureToolbar() {
  let toolbar = document.getElementById(TOOLBAR_ID);
  if (toolbar) return toolbar;
  installMainStyles();
  toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.dataset.open = "false";
  toolbar.innerHTML = `
    <button class="annotation-primary" type="button" data-action="highlight">HIGHLIGHT</button>
    <button type="button" data-action="note">ADD NOTE</button>
    <button type="button" data-action="cancel" aria-label="Cancel">×</button>
  `;
  document.body.append(toolbar);
  toolbar.querySelector('[data-action="highlight"]').addEventListener("click", () => createAnnotation(false));
  toolbar.querySelector('[data-action="note"]').addEventListener("click", () => createAnnotation(true));
  toolbar.querySelector('[data-action="cancel"]').addEventListener("click", hideToolbar);
  return toolbar;
}

function ensureEditor() {
  let editor = document.getElementById(EDITOR_ID);
  if (editor) return editor;
  installMainStyles();
  editor = document.createElement("aside");
  editor.id = EDITOR_ID;
  editor.dataset.open = "false";
  editor.innerHTML = `
    <p class="annotation-quote"></p>
    <textarea aria-label="Annotation" placeholder="Write in the margin…"></textarea>
    <div class="annotation-actions">
      <button class="annotation-save" type="button">SAVE NOTE</button>
      <button class="annotation-close" type="button">CLOSE</button>
      <button class="annotation-delete" type="button">DELETE</button>
    </div>
  `;
  document.body.append(editor);
  editor.querySelector(".annotation-save").addEventListener("click", saveNote);
  editor.querySelector(".annotation-close").addEventListener("click", closeEditor);
  editor.querySelector(".annotation-delete").addEventListener("click", deleteAnnotation);
  return editor;
}

function hideToolbar() {
  document.getElementById(TOOLBAR_ID)?.setAttribute("data-open", "false");
  pendingAnchor = null;
}

function clearSelection() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const selection = shadow?.getSelection?.() || document.getSelection();
  selection?.removeAllRanges();
}

function createAnnotation(withNote) {
  if (!pendingAnchor) return;
  const annotation = {
    id: crypto.randomUUID(),
    storyKey: storyKey(),
    chapterIndex: chapterIndex(),
    ...pendingAnchor,
    note: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  annotations.push(annotation);
  persistAnnotations();
  hideToolbar();
  clearSelection();
  scheduleRender();
  if (withNote) setTimeout(() => openEditor(annotation.id), 80);
}

function openEditor(id) {
  const annotation = annotations.find((item) => item.id === id);
  if (!annotation) return;
  const editor = ensureEditor();
  activeAnnotationId = id;
  editor.querySelector(".annotation-quote").textContent = annotation.quote;
  editor.querySelector("textarea").value = annotation.note || "";
  editor.dataset.open = "true";
  setTimeout(() => editor.querySelector("textarea").focus(), 80);
}

function closeEditor() {
  const editor = document.getElementById(EDITOR_ID);
  if (editor) editor.dataset.open = "false";
  activeAnnotationId = null;
}

function saveNote() {
  const editor = document.getElementById(EDITOR_ID);
  const annotation = annotations.find((item) => item.id === activeAnnotationId);
  if (!editor || !annotation) return;
  annotation.note = editor.querySelector("textarea").value.trim();
  annotation.updatedAt = new Date().toISOString();
  persistAnnotations();
  closeEditor();
  scheduleRender();
}

function deleteAnnotation() {
  if (!activeAnnotationId) return;
  if (!window.confirm("Delete this highlight and its note?")) return;
  annotations = annotations.filter((item) => item.id !== activeAnnotationId);
  persistAnnotations();
  closeEditor();
  scheduleRender();
}

function inspectSelection() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  const selection = shadow.getSelection?.()?.rangeCount
    ? shadow.getSelection()
    : document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !normalize(selection.toString())) {
    hideToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  if (range.commonAncestorContainer.getRootNode() !== shadow) return;
  const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!workskin.contains(container)) return;

  const anchor = anchorFromSelection(range, workskin, shadow);
  if (!anchor) {
    hideToolbar();
    return;
  }

  pendingAnchor = anchor;
  ensureToolbar().dataset.open = "true";
}

function scheduleSelectionInspection(delay = 280) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(inspectSelection, delay);
}

function connectToShadow() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;
  if (currentShadow === shadow) {
    scheduleRender();
    return true;
  }

  currentShadow = shadow;
  installShadowStyles(shadow);
  observeShadow(shadow);
  shadow.addEventListener("pointerup", () => scheduleSelectionInspection(300));
  shadow.addEventListener("keyup", () => scheduleSelectionInspection(80));
  shadow.addEventListener("click", (event) => {
    const mark = event.target.closest?.(`mark[${HIGHLIGHT_ATTR}]`);
    if (mark) openEditor(mark.getAttribute(HIGHLIGHT_ATTR));
  });
  scheduleRender();
  return true;
}

function connectWhenReady() {
  if (connectToShadow()) {
    shellObserver?.disconnect();
    shellObserver = null;
    return;
  }
  if (shellObserver) return;
  shellObserver = new MutationObserver(connectWhenReady);
  shellObserver.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener("selectionchange", () => scheduleSelectionInspection(320));
document.addEventListener(
  "click",
  (event) => {
    const row = event.target.closest?.(".book-row");
    if (row?.dataset.storyId) lastClickedStoryId = row.dataset.storyId;
  },
  true,
);
document.querySelector("#reader-chapter-select")?.addEventListener("change", () => {
  hideToolbar();
  closeEditor();
  setTimeout(scheduleRender, 120);
});
document.querySelector("#reader-back")?.addEventListener("click", () => {
  hideToolbar();
  closeEditor();
});

connectWhenReady();
