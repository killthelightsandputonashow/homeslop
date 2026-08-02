const ANNOTATION_STORAGE_KEY = "homeslop-annotations-v1";
const ANNOTATION_SEGMENT_ATTR = "data-homeslop-annotation-id";
const ANNOTATION_UI_ATTR = "data-homeslop-annotation-ui";
const ANNOTATIONS_HIDDEN_KEY = "homeslop-annotations-hidden";

const readerView = document.querySelector("#reader-view");
const readerTopbar = document.querySelector(".reader-topbar");
const readerDelete = document.querySelector("#reader-delete");

let shadowObserver = null;
let shellObserver = null;
let activeShadow = null;
let applying = false;
let applyFrame = 0;
let selectionTimer = 0;
let pendingSelection = null;
let activeEditorId = null;
let lastClickedStoryId = null;

function loadAnnotations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ANNOTATION_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let annotations = loadAnnotations();

function persistAnnotations() {
  try {
    localStorage.setItem(ANNOTATION_STORAGE_KEY, JSON.stringify(annotations));
  } catch (error) {
    console.warn("Homeslop could not save annotations", error);
  }
}

function annotationId() {
  return crypto.randomUUID?.() || `note-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentContext() {
  const explicitStoryId = readerView?.dataset.storyId || lastClickedStoryId || "";
  const fallbackTitle = String(document.querySelector("#reader-title")?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  const fallbackAuthor = String(document.querySelector("#reader-author")?.textContent || "")
    .replace(/\s*·\s*Chapter\s+\d+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const storyId = explicitStoryId || (fallbackTitle ? `fallback:${fallbackTitle}|${fallbackAuthor}` : "");
  const selectedChapter = Number(document.querySelector("#reader-chapter-select")?.value);
  const datasetChapter = Number(readerView?.dataset.chapterIndex);
  const chapterIndex = Number.isFinite(datasetChapter) ? datasetChapter : Math.max(0, selectedChapter || 0);
  if (!storyId || !Number.isFinite(chapterIndex)) return null;
  return { storyId, chapterIndex };
}

function currentAnnotations() {
  const context = currentContext();
  if (!context) return [];
  return annotations.filter(
    (annotation) =>
      annotation.storyId === context.storyId && annotation.chapterIndex === context.chapterIndex,
  );
}

function textNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.data) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`script, style, [${ANNOTATION_UI_ATTR}]`)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function offsetForBoundary(root, container, offset) {
  const nodes = textNodes(root);
  let total = 0;

  for (const node of nodes) {
    if (node === container) return total + Math.min(offset, node.data.length);
    total += node.data.length;
  }

  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function selectionInsideWorkskin(shadow) {
  const selection = shadow.getSelection?.() || window.getSelection();
  const workskin = shadow.querySelector("#workskin");
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !workskin) return null;

  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const commonElement = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
  if (!commonElement || !workskin.contains(commonElement)) return null;
  if (commonElement.closest(`[${ANNOTATION_UI_ATTR}]`)) return null;

  const start = offsetForBoundary(workskin, range.startContainer, range.startOffset);
  const end = offsetForBoundary(workskin, range.endContainer, range.endOffset);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const quote = range.toString().replace(/\s+/g, " ").trim();
  if (!quote || quote.length > 1200) return null;

  return { range, start, end, quote, selection };
}

function ensureShellStyles() {
  if (document.querySelector("#homeslop-annotation-shell-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-annotation-shell-style";
  style.textContent = `
    .reader-topbar {
      grid-template-columns: 44px minmax(0, 1fr) auto auto auto !important;
    }

    #homeslop-selection-tools {
      position: fixed;
      z-index: 11000;
      display: none;
      gap: .4rem;
      padding: .4rem;
      border: 1px solid #666;
      border-radius: 7px;
      background: #1d1d1d;
      box-shadow: 0 7px 24px rgba(0, 0, 0, .45);
    }

    #homeslop-selection-tools[data-open="true"] { display: flex; }

    #homeslop-selection-tools button,
    #homeslop-annotation-editor button,
    #homeslop-annotation-editor textarea {
      font: inherit;
    }

    #homeslop-selection-tools button {
      min-height: 2.2rem;
      padding: .35rem .65rem;
      border: 1px solid #777;
      border-radius: 4px;
      color: #eee;
      background: #303030;
      font-size: .76rem;
      font-weight: 700;
    }

    #homeslop-annotation-editor {
      position: fixed;
      inset: auto max(.65rem, env(safe-area-inset-right)) calc(.65rem + env(safe-area-inset-bottom)) max(.65rem, env(safe-area-inset-left));
      z-index: 11001;
      display: none;
      max-width: 42rem;
      max-height: min(70svh, 36rem);
      margin-inline: auto;
      overflow: auto;
      border: 2px solid #777;
      border-radius: 9px;
      background: #181818;
      color: #eee;
      box-shadow: 0 12px 42px rgba(0, 0, 0, .55);
      font-family: "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, Arial, sans-serif;
    }

    #homeslop-annotation-editor[data-open="true"] { display: block; }

    #homeslop-annotation-editor .annotation-editor-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      padding: .65rem .75rem;
      border-bottom: 1px solid #444;
      background: #242424;
    }

    #homeslop-annotation-editor .annotation-editor-body {
      display: grid;
      gap: .7rem;
      padding: .75rem;
    }

    #homeslop-annotation-editor .annotation-quote {
      margin: 0;
      padding: .55rem .65rem;
      border-left: 3px solid #f7b500;
      color: #cfcfcf;
      background: #202020;
      font-size: .84rem;
      line-height: 1.45;
    }

    #homeslop-annotation-editor textarea {
      width: 100%;
      min-height: 7rem;
      resize: vertical;
      padding: .65rem;
      border: 1px solid #666;
      border-radius: 5px;
      color: #eee;
      background: #111;
      font-size: 1rem;
      line-height: 1.45;
    }

    #homeslop-annotation-editor .annotation-palette,
    #homeslop-annotation-editor .annotation-actions {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem;
    }

    #homeslop-annotation-editor .annotation-color {
      width: 2.25rem;
      height: 2.25rem;
      border: 2px solid transparent;
      border-radius: 999px;
    }

    #homeslop-annotation-editor .annotation-color[aria-pressed="true"] {
      border-color: #fff;
      box-shadow: 0 0 0 2px #111;
    }

    #homeslop-annotation-editor .annotation-color[data-color="yellow"] { background: #ffe05d; }
    #homeslop-annotation-editor .annotation-color[data-color="pink"] { background: #ff8fb7; }
    #homeslop-annotation-editor .annotation-color[data-color="blue"] { background: #82c8ff; }
    #homeslop-annotation-editor .annotation-color[data-color="green"] { background: #8fdda4; }

    #homeslop-annotation-editor .annotation-actions button,
    #homeslop-annotation-editor .annotation-editor-close {
      min-height: 2.25rem;
      padding: .4rem .7rem;
      border: 1px solid #666;
      border-radius: 4px;
      color: #eee;
      background: #303030;
      font-weight: 700;
    }

    #homeslop-annotation-editor .annotation-save { background: #6a4a00; border-color: #f7b500; }
    #homeslop-annotation-editor .annotation-delete { color: #ffafbc; }
  `;
  document.head.append(style);
}

function ensureSelectionTools() {
  let tools = document.querySelector("#homeslop-selection-tools");
  if (tools) return tools;

  ensureShellStyles();
  tools = document.createElement("div");
  tools.id = "homeslop-selection-tools";
  tools.dataset.open = "false";
  tools.setAttribute(ANNOTATION_UI_ATTR, "");

  const highlight = document.createElement("button");
  highlight.type = "button";
  highlight.textContent = "HIGHLIGHT";
  highlight.addEventListener("pointerdown", (event) => event.preventDefault());
  highlight.addEventListener("click", () => createFromPending(false));

  const note = document.createElement("button");
  note.type = "button";
  note.textContent = "+ NOTE";
  note.addEventListener("pointerdown", (event) => event.preventDefault());
  note.addEventListener("click", () => createFromPending(true));

  tools.append(highlight, note);
  document.body.append(tools);
  return tools;
}

function hideSelectionTools() {
  const tools = document.querySelector("#homeslop-selection-tools");
  if (tools) tools.dataset.open = "false";
  pendingSelection = null;
}

function showSelectionTools() {
  if (!activeShadow || !readerView?.classList.contains("is-visible")) return;
  const selected = selectionInsideWorkskin(activeShadow);
  if (!selected) {
    hideSelectionTools();
    return;
  }

  const context = currentContext();
  if (!context) return;

  const rect = selected.range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;

  pendingSelection = {
    ...context,
    start: selected.start,
    end: selected.end,
    quote: selected.quote,
  };

  const tools = ensureSelectionTools();
  tools.dataset.open = "true";
  const width = tools.offsetWidth || 170;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const top = rect.top > 70 ? rect.top - 52 : rect.bottom + 10;
  tools.style.left = `${left}px`;
  tools.style.top = `${Math.max(8, top)}px`;
}

function scheduleSelectionTools(delay = 140) {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(showSelectionTools, delay);
}

function overlappingAnnotation(selection) {
  return annotations.find(
    (annotation) =>
      annotation.storyId === selection.storyId &&
      annotation.chapterIndex === selection.chapterIndex &&
      selection.start < annotation.end &&
      selection.end > annotation.start,
  );
}

function createFromPending(withNote) {
  if (!pendingSelection) return;
  const overlap = overlappingAnnotation(pendingSelection);
  if (overlap) {
    hideSelectionTools();
    openEditor(overlap.id);
    return;
  }

  const annotation = {
    id: annotationId(),
    storyId: pendingSelection.storyId,
    chapterIndex: pendingSelection.chapterIndex,
    start: pendingSelection.start,
    end: pendingSelection.end,
    quote: pendingSelection.quote,
    note: "",
    color: "yellow",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  annotations.push(annotation);
  persistAnnotations();
  window.getSelection()?.removeAllRanges();
  hideSelectionTools();
  applyAnnotations();
  if (withNote) openEditor(annotation.id, true);
}

function ensureEditor() {
  let editor = document.querySelector("#homeslop-annotation-editor");
  if (editor) return editor;

  ensureShellStyles();
  editor = document.createElement("aside");
  editor.id = "homeslop-annotation-editor";
  editor.dataset.open = "false";
  editor.setAttribute(ANNOTATION_UI_ATTR, "");
  editor.setAttribute("aria-label", "Annotation editor");
  editor.innerHTML = `
    <div class="annotation-editor-head">
      <strong>PAGE NOTE</strong>
      <button class="annotation-editor-close" type="button" aria-label="Close annotation editor">×</button>
    </div>
    <div class="annotation-editor-body">
      <blockquote class="annotation-quote"></blockquote>
      <textarea class="annotation-note" placeholder="Write a note…"></textarea>
      <div class="annotation-palette" aria-label="Highlight color">
        <button class="annotation-color" data-color="yellow" type="button" aria-label="Yellow highlight"></button>
        <button class="annotation-color" data-color="pink" type="button" aria-label="Pink highlight"></button>
        <button class="annotation-color" data-color="blue" type="button" aria-label="Blue highlight"></button>
        <button class="annotation-color" data-color="green" type="button" aria-label="Green highlight"></button>
      </div>
      <div class="annotation-actions">
        <button class="annotation-save" type="button">SAVE</button>
        <button class="annotation-delete" type="button">DELETE</button>
      </div>
    </div>
  `;

  editor.querySelector(".annotation-editor-close").addEventListener("click", closeEditor);
  editor.querySelector(".annotation-save").addEventListener("click", saveEditor);
  editor.querySelector(".annotation-delete").addEventListener("click", deleteEditorAnnotation);
  editor.querySelectorAll(".annotation-color").forEach((button) => {
    button.addEventListener("click", () => {
      editor.querySelectorAll(".annotation-color").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  });

  document.body.append(editor);
  return editor;
}

function openEditor(id, focusNote = false) {
  const annotation = annotations.find((item) => item.id === id);
  if (!annotation) return;

  hideSelectionTools();
  activeEditorId = id;
  const editor = ensureEditor();
  editor.querySelector(".annotation-quote").textContent = annotation.quote;
  editor.querySelector(".annotation-note").value = annotation.note || "";
  editor.querySelectorAll(".annotation-color").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.color === annotation.color));
  });
  editor.dataset.open = "true";
  if (focusNote) window.setTimeout(() => editor.querySelector(".annotation-note").focus(), 50);
}

function closeEditor() {
  const editor = document.querySelector("#homeslop-annotation-editor");
  if (editor) editor.dataset.open = "false";
  activeEditorId = null;
}

function saveEditor() {
  const editor = ensureEditor();
  const annotation = annotations.find((item) => item.id === activeEditorId);
  if (!annotation) return;

  annotation.note = editor.querySelector(".annotation-note").value.trim();
  annotation.color =
    editor.querySelector('.annotation-color[aria-pressed="true"]')?.dataset.color || "yellow";
  annotation.updatedAt = new Date().toISOString();
  persistAnnotations();
  closeEditor();
  applyAnnotations();
}

function deleteEditorAnnotation() {
  if (!activeEditorId) return;
  annotations = annotations.filter((annotation) => annotation.id !== activeEditorId);
  persistAnnotations();
  closeEditor();
  applyAnnotations();
}

function installShadowStyles(shadow) {
  if (shadow.querySelector("#homeslop-annotation-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-annotation-style";
  style.textContent = `
    [${ANNOTATION_SEGMENT_ATTR}] {
      border-radius: .14em;
      color: inherit;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      cursor: pointer;
    }

    [${ANNOTATION_SEGMENT_ATTR}][data-annotation-color="yellow"] { background: rgba(255, 224, 93, .48); }
    [${ANNOTATION_SEGMENT_ATTR}][data-annotation-color="pink"] { background: rgba(255, 143, 183, .44); }
    [${ANNOTATION_SEGMENT_ATTR}][data-annotation-color="blue"] { background: rgba(130, 200, 255, .42); }
    [${ANNOTATION_SEGMENT_ATTR}][data-annotation-color="green"] { background: rgba(143, 221, 164, .42); }

    .homeslop-annotation-pin {
      display: inline-grid;
      place-items: center;
      min-width: 1.65em;
      min-height: 1.65em;
      margin-left: .25em;
      padding: 0 .3em;
      vertical-align: .08em;
      border: 1px solid currentColor;
      border-radius: 999px;
      color: inherit;
      background: color-mix(in srgb, currentColor 11%, var(--reader-bg));
      font: inherit;
      font-size: .75em;
      line-height: 1;
      cursor: pointer;
    }

    :host([data-annotations-hidden="true"]) [${ANNOTATION_SEGMENT_ATTR}] {
      background: transparent !important;
    }

    :host([data-annotations-hidden="true"]) .homeslop-annotation-pin {
      display: none !important;
    }
  `;
  shadow.append(style);
}

function unwrapAnnotations(root) {
  root.querySelectorAll(`.homeslop-annotation-pin[${ANNOTATION_UI_ATTR}]`).forEach((pin) => pin.remove());
  root.querySelectorAll(`[${ANNOTATION_SEGMENT_ATTR}]`).forEach((segment) => {
    segment.replaceWith(...segment.childNodes);
  });
  root.normalize();
}

function applyAnnotation(root, annotation) {
  const nodes = textNodes(root);
  const segments = [];
  let cursor = 0;

  for (const node of nodes) {
    const nodeStart = cursor;
    const nodeEnd = cursor + node.data.length;
    cursor = nodeEnd;
    if (annotation.end <= nodeStart || annotation.start >= nodeEnd) continue;

    segments.push({
      node,
      start: Math.max(0, annotation.start - nodeStart),
      end: Math.min(node.data.length, annotation.end - nodeStart),
    });
  }

  const wrappers = [];
  [...segments].reverse().forEach(({ node, start, end }) => {
    let selectedNode = node;
    if (end < selectedNode.data.length) selectedNode.splitText(end);
    if (start > 0) selectedNode = selectedNode.splitText(start);
    if (!selectedNode.data) return;

    const wrapper = document.createElement("span");
    wrapper.setAttribute(ANNOTATION_SEGMENT_ATTR, annotation.id);
    wrapper.dataset.annotationColor = annotation.color || "yellow";
    wrapper.title = annotation.note || "Highlight";
    selectedNode.parentNode.insertBefore(wrapper, selectedNode);
    wrapper.append(selectedNode);
    wrappers.push(wrapper);
  });

  if (!wrappers.length || !annotation.note) return;
  const lastWrapper = wrappers[0];
  const pin = document.createElement("button");
  pin.className = "homeslop-annotation-pin";
  pin.type = "button";
  pin.textContent = "✎";
  pin.title = annotation.note;
  pin.setAttribute("aria-label", "Open annotation");
  pin.setAttribute(ANNOTATION_UI_ATTR, "");
  pin.dataset.annotationId = annotation.id;
  lastWrapper.after(pin);
}

function applyAnnotations() {
  applyFrame = 0;
  if (applying || !activeShadow) return;
  const workskin = activeShadow.querySelector("#workskin");
  if (!workskin) return;

  applying = true;
  shadowObserver?.disconnect();
  try {
    installShadowStyles(activeShadow);
    unwrapAnnotations(workskin);
    currentAnnotations()
      .filter((annotation) => annotation.end > annotation.start)
      .sort((a, b) => b.start - a.start)
      .forEach((annotation) => applyAnnotation(workskin, annotation));
  } finally {
    applying = false;
    if (shadowObserver && activeShadow) {
      shadowObserver.observe(activeShadow, { childList: true, subtree: true });
    }
  }
}

function scheduleApply() {
  if (applyFrame) cancelAnimationFrame(applyFrame);
  applyFrame = requestAnimationFrame(applyAnnotations);
}

function handleShadowClick(event) {
  const segment = event.target.closest?.(`[${ANNOTATION_SEGMENT_ATTR}]`);
  const pin = event.target.closest?.(".homeslop-annotation-pin");
  const id = segment?.getAttribute(ANNOTATION_SEGMENT_ATTR) || pin?.dataset.annotationId;
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  openEditor(id);
}

function ensureVisibilityToggle() {
  if (!readerTopbar || readerTopbar.querySelector(".homeslop-annotation-toggle")) return;
  const button = document.createElement("button");
  button.className = "reader-action homeslop-annotation-toggle";
  button.type = "button";
  button.textContent = "✎";
  button.addEventListener("click", () => {
    const hidden = localStorage.getItem(ANNOTATIONS_HIDDEN_KEY) !== "true";
    localStorage.setItem(ANNOTATIONS_HIDDEN_KEY, String(hidden));
    syncVisibility();
  });
  readerDelete?.before(button);
  syncVisibility();
}

function syncVisibility() {
  const host = document.querySelector("#reader-shadow");
  const hidden = localStorage.getItem(ANNOTATIONS_HIDDEN_KEY) === "true";
  if (host) host.dataset.annotationsHidden = String(hidden);
  const button = readerTopbar?.querySelector(".homeslop-annotation-toggle");
  if (button) {
    button.textContent = hidden ? "✎̸" : "✎";
    button.title = hidden ? "Show highlights and notes" : "Hide highlights and notes";
    button.setAttribute(
      "aria-label",
      hidden ? "Show highlights and annotations" : "Hide highlights and annotations",
    );
  }
}

function connectShadow() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  if (activeShadow !== shadow) {
    activeShadow?.removeEventListener("click", handleShadowClick);
    activeShadow = shadow;
    activeShadow.addEventListener("click", handleShadowClick);
    activeShadow.addEventListener("pointerup", () => scheduleSelectionTools(100));
    activeShadow.addEventListener("touchend", () => scheduleSelectionTools(220), { passive: true });
    activeShadow.addEventListener("keyup", () => scheduleSelectionTools(80));
  }

  shadowObserver?.disconnect();
  shadowObserver = new MutationObserver(() => {
    if (!applying) scheduleApply();
  });
  shadowObserver.observe(shadow, { childList: true, subtree: true });
  syncVisibility();
  scheduleApply();
  return true;
}

function connectWhenReady() {
  if (connectShadow()) {
    shellObserver?.disconnect();
    shellObserver = null;
    return;
  }

  if (shellObserver) return;
  shellObserver = new MutationObserver(connectWhenReady);
  shellObserver.observe(document.body, { childList: true, subtree: true });
}

ensureShellStyles();
ensureVisibilityToggle();
connectWhenReady();

new MutationObserver(() => {
  hideSelectionTools();
  closeEditor();
  scheduleApply();
}).observe(readerView, {
  attributes: true,
  attributeFilter: ["class", "data-story-id", "data-chapter-index"],
});

document.addEventListener("pointerdown", (event) => {
  const tools = document.querySelector("#homeslop-selection-tools");
  if (tools?.contains(event.target)) return;
  if (document.querySelector("#homeslop-annotation-editor")?.contains(event.target)) return;
  if (!event.composedPath().some((item) => item === document.querySelector("#reader-shadow"))) {
    hideSelectionTools();
  }
});

document.querySelector("#reader-back")?.addEventListener("click", () => {
  hideSelectionTools();
  closeEditor();
});
document.querySelector("#reader-delete")?.addEventListener("click", () => {
  hideSelectionTools();
  closeEditor();
});

document.addEventListener(
  "click",
  (event) => {
    const row = event.target.closest?.(".book-row");
    if (row?.dataset.storyId) lastClickedStoryId = row.dataset.storyId;
  },
  true,
);

document.addEventListener("selectionchange", () => {
  if (readerView?.classList.contains("is-visible")) scheduleSelectionTools(260);
});
