const ANNOTATION_KEY = "homeslop-annotations-v1";
const HIGHLIGHT_ATTR = "data-homeslop-highlight-id";
const NOTE_PIN_ATTR = "data-homeslop-note-pin";
const TOOLBAR_ID = "homeslop-selection-toolbar";
const EDITOR_ID = "homeslop-annotation-editor";

let annotationStore = loadAnnotations();
let pendingAnchor = null;
let activeAnnotationId = null;
let annotationObserver = null;
let annotationShellObserver = null;
let annotationFrame = 0;
let selectionTimer = 0;
let renderingAnnotations = false;
let lastClickedStoryId = null;

function loadAnnotations() {
  try {
    const value = JSON.parse(localStorage.getItem(ANNOTATION_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveAnnotations() {
  try {
    localStorage.setItem(ANNOTATION_KEY, JSON.stringify(annotationStore));
  } catch (error) {
    console.warn("Homeslop could not save annotations", error);
  }
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function currentStoryKey() {
  const readerView = document.querySelector("#reader-view");
  const explicit = readerView?.dataset.storyId || lastClickedStoryId;
  if (explicit) return explicit;

  const title = normalize(document.querySelector("#reader-title")?.textContent);
  const author = normalize(document.querySelector("#reader-author")?.textContent).replace(/\s*·\s*Chapter\s+\d+.*$/i, "");
  return `fallback:${title}|${author}`;
}

function currentChapterIndex() {
  return Math.max(0, Number(document.querySelector("#reader-chapter-select")?.value) || 0);
}

function currentContext() {
  return {
    storyKey: currentStoryKey(),
    chapterIndex: currentChapterIndex(),
  };
}

function annotationsForCurrentChapter() {
  const context = currentContext();
  return annotationStore.filter(
    (annotation) =>
      annotation.storyKey === context.storyKey &&
      Number(annotation.chapterIndex) === context.chapterIndex,
  );
}

function isIgnoredTextNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue) return true;
  return Boolean(
    parent.closest(
      "script, style, noscript, button, select, textarea, input, [aria-hidden='true'], .homeslop-song-hidden-link",
    ),
  );
}

function flattenText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isIgnoredTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
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

function boundaryOffset(flat, container, offset, fallbackText, preferEnd = false) {
  if (container?.nodeType === Node.TEXT_NODE) {
    const entry = flat.nodes.find((item) => item.node === container);
    if (entry) return entry.start + Math.min(offset, container.nodeValue.length);
  }

  const quote = String(fallbackText || "");
  if (!quote) return 0;
  const index = preferEnd ? flat.text.lastIndexOf(quote) : flat.text.indexOf(quote);
  return index < 0 ? 0 : index + (preferEnd ? quote.length : 0);
}

function selectionIntersectsHighlight(range) {
  const root = range.commonAncestorContainer.getRootNode();
  if (!(root instanceof ShadowRoot)) return false;
  return [...root.querySelectorAll(`[${HIGHLIGHT_ATTR}]`)].some((mark) => {
    try {
      return range.intersectsNode(mark);
    } catch {
      return false;
    }
  });
}

function anchorFromRange(range, workskin) {
  const quote = range.toString();
  if (!normalize(quote) || quote.length > 1800) return null;
  if (selectionIntersectsHighlight(range)) return null;

  const flat = flattenText(workskin);
  let start = boundaryOffset(flat, range.startContainer, range.startOffset, quote, false);
  let end = boundaryOffset(flat, range.endContainer, range.endOffset, quote, true);

  if (end <= start || flat.text.slice(start, end) !== quote) {
    const direct = flat.text.indexOf(quote);
    if (direct < 0) return null;
    start = direct;
    end = direct + quote.length;
  }

  let occurrence = 0;
  let cursor = 0;
  while (cursor < start) {
    const found = flat.text.indexOf(quote, cursor);
    if (found < 0 || found >= start) break;
    occurrence += 1;
    cursor = found + Math.max(1, quote.length);
  }

  return {
    quote,
    prefix: flat.text.slice(Math.max(0, start - 48), start),
    suffix: flat.text.slice(end, end + 48),
    occurrence,
  };
}

function findAnchorIndex(text, annotation) {
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
    let score = 0;
    if (annotation.prefix) {
      const left = text.slice(Math.max(0, index - annotation.prefix.length), index);
      for (let i = 1; i <= Math.min(left.length, annotation.prefix.length); i += 1) {
        if (left.at(-i) !== annotation.prefix.at(-i)) break;
        score += 1;
      }
    }
    if (annotation.suffix) {
      const right = text.slice(index + quote.length, index + quote.length + annotation.suffix.length);
      for (let i = 0; i < Math.min(right.length, annotation.suffix.length); i += 1) {
        if (right[i] !== annotation.suffix[i]) break;
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

function unwrapGeneratedHighlights(root) {
  root.querySelectorAll(`mark[${HIGHLIGHT_ATTR}]`).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  root.normalize();
}

function wrapInterval(flat, start, end, annotation) {
  const overlapping = flat.nodes.filter((entry) => entry.end > start && entry.start < end).reverse();
  overlapping.forEach((entry) => {
    const from = Math.max(0, start - entry.start);
    const to = Math.min(entry.node.nodeValue.length, end - entry.start);
    if (to <= from || !entry.node.parentNode) return;

    const range = document.createRange();
    range.setStart(entry.node, from);
    range.setEnd(entry.node, to);
    const mark = document.createElement("mark");
    mark.setAttribute(HIGHLIGHT_ATTR, annotation.id);
    if (annotation.note) mark.dataset.homeslopHasNote = "true";
    try {
      range.surroundContents(mark);
    } catch {
      return;
    }
  });
}

function installAnnotationStyles(shadow) {
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

function renderAnnotations() {
  annotationFrame = 0;
  if (renderingAnnotations) return;
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  renderingAnnotations = true;
  try {
    installAnnotationStyles(shadow);
    unwrapGeneratedHighlights(workskin);
    const flat = flattenText(workskin);
    const intervals = annotationsForCurrentChapter()
      .map((annotation) => {
        const start = findAnchorIndex(flat.text, annotation);
        return start < 0 ? null : { annotation, start, end: start + annotation.quote.length };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const accepted = [];
    let occupiedUntil = -1;
    intervals.forEach((interval) => {
      if (interval.start < occupiedUntil) return;
      accepted.push(interval);
      occupiedUntil = interval.end;
    });

    [...accepted].reverse().forEach((interval) => {
      wrapInterval(flat, interval.start, interval.end, interval.annotation);
    });

    accepted.forEach(({ annotation }) => {
      const fragments = workskin.querySelectorAll(
        `mark[${HIGHLIGHT_ATTR}="${CSS.escape(annotation.id)}"]`,
      );
      if (annotation.note && fragments.length) {
        fragments[fragments.length - 1].setAttribute(NOTE_PIN_ATTR, "");
      }
    });
  } finally {
    renderingAnnotations = false;
  }
}

function scheduleAnnotationRender() {
  if (renderingAnnotations) return;
  if (annotationFrame) cancelAnimationFrame(annotationFrame);
  annotationFrame = requestAnimationFrame(renderAnnotations);
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
    #${TOOLBAR_ID} .annotation-primary { color: #171717; background: #ffd83d; border-color: #c8a500; }
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
    #${EDITOR_ID} .annotation-save { color: #171717; background: #ffd83d; border-color: #c8a500; }
    #${EDITOR_ID} .annotation-delete { margin-left: auto; color: #ff9bac; }
  `;
  document.head.append(style);
}

function ensureSelectionToolbar() {
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
  toolbar.querySelector('[data-action="cancel"]').addEventListener("click", hideSelectionToolbar);
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

  editor.querySelector(".annotation-save").addEventListener("click", saveEditorNote);
  editor.querySelector(".annotation-close").addEventListener("click", closeEditor);
  editor.querySelector(".annotation-delete").addEventListener("click", deleteActiveAnnotation);
  return editor;
}

function hideSelectionToolbar() {
  const toolbar = document.getElementById(TOOLBAR_ID);
  if (toolbar) toolbar.dataset.open = "false";
  pendingAnchor = null;
}

function clearSelection() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const selection = shadow?.getSelection?.() || document.getSelection();
  selection?.removeAllRanges();
}

function createAnnotation(withNote) {
  if (!pendingAnchor) return;
  const context = currentContext();
  const annotation = {
    id: crypto.randomUUID(),
    storyKey: context.storyKey,
    chapterIndex: context.chapterIndex,
    ...pendingAnchor,
    note: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  annotationStore.push(annotation);
  saveAnnotations();
  hideSelectionToolbar();
  clearSelection();
  scheduleAnnotationRender();
  if (withNote) window.setTimeout(() => openEditor(annotation.id), 80);
}

function openEditor(id) {
  const annotation = annotationStore.find((item) => item.id === id);
  if (!annotation) return;
  const editor = ensureEditor();
  activeAnnotationId = id;
  editor.querySelector(".annotation-quote").textContent = annotation.quote;
  editor.querySelector("textarea").value = annotation.note || "";
  editor.dataset.open = "true";
  window.setTimeout(() => editor.querySelector("textarea").focus(), 80);
}

function closeEditor() {
  const editor = document.getElementById(EDITOR_ID);
  if (editor) editor.dataset.open = "false";
  activeAnnotationId = null;
}

function saveEditorNote() {
  const annotation = annotationStore.find((item) => item.id === activeAnnotationId);
  const editor = document.getElementById(EDITOR_ID);
  if (!annotation || !editor) return;
  annotation.note = editor.querySelector("textarea").value.trim();
  annotation.updatedAt = new Date().toISOString();
  saveAnnotations();
  closeEditor();
  scheduleAnnotationRender();
}

function deleteActiveAnnotation() {
  const annotation = annotationStore.find((item) => item.id === activeAnnotationId);
  if (!annotation) return;
  if (!window.confirm("Delete this highlight and its note?")) return;
  annotationStore = annotationStore.filter((item) => item.id !== activeAnnotationId);
  saveAnnotations();
  closeEditor();
  scheduleAnnotationRender();
}

function selectionForShadow(shadow) {
  const shadowSelection = shadow.getSelection?.();
  if (shadowSelection?.rangeCount) return shadowSelection;
  const documentSelection = document.getSelection();
  return documentSelection?.rangeCount ? documentSelection : null;
}

function inspectSelection() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  const selection = selectionForShadow(shadow);
  if (!selection || selection.isCollapsed || !normalize(selection.toString())) {
    hideSelectionToolbar();
    return;
  }

  const range = selection.getRangeAt(0);
  if (range.commonAncestorContainer.getRootNode() !== shadow) return;
  if (!workskin.contains(range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement)) return;

  const anchor = anchorFromRange(range, workskin);
  if (!anchor) {
    hideSelectionToolbar();
    return;
  }
  pendingAnchor = anchor;
  ensureSelectionToolbar().dataset.open = "true";
}

function scheduleSelectionInspection(delay = 260) {
  clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(inspectSelection, delay);
}

function connectAnnotations() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  installAnnotationStyles(shadow);
  annotationObserver?.disconnect();
  annotationObserver = new MutationObserver(scheduleAnnotationRender);
  annotationObserver.observe(shadow, { childList: true, subtree: true });

  shadow.addEventListener("pointerup", () => scheduleSelectionInspection(300));
  shadow.addEventListener("keyup", () => scheduleSelectionInspection(80));
  shadow.addEventListener("click", (event) => {
    const mark = event.target.closest?.(`mark[${HIGHLIGHT_ATTR}]`);
    if (mark) openEditor(mark.getAttribute(HIGHLIGHT_ATTR));
  });
  scheduleAnnotationRender();
  return true;
}

function connectAnnotationsWhenReady() {
  if (connectAnnotations()) {
    annotationShellObserver?.disconnect();
    annotationShellObserver = null;
    return;
  }
  if (annotationShellObserver) return;
  annotationShellObserver = new MutationObserver(connectAnnotationsWhenReady);
  annotationShellObserver.observe(document.body, { childList: true, subtree: true });
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
  hideSelectionToolbar();
  closeEditor();
  window.setTimeout(scheduleAnnotationRender, 120);
});
document.querySelector("#reader-back")?.addEventListener("click", () => {
  hideSelectionToolbar();
  closeEditor();
});

connectAnnotationsWhenReady();
