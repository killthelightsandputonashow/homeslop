const FALLBACK_ATTR = "data-homeslop-fallback-log";
const GENERATED_ATTR = "data-homeslop-generated-log";
const CONTRAST_ATTR = "data-homeslop-safe-color";

let observer = null;
let scheduled = 0;
let applying = false;

function normalize(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function markerCount(value) {
  const text = normalize(value);
  if (!text) return 0;
  const abbreviations = text.match(/(?:^|\s)[A-Z]{1,5}\s*:/g)?.length || 0;
  const transitions = text.match(/\b(?:began|ceased|started|stopped)\s+(?:trolling|pestering)\b/gi)?.length || 0;
  const notices = text.match(/\b(?:Pinned note|added|removed|joined|left|came ONLINE|went OFFLINE)\b/gi)?.length || 0;
  return abbreviations + transitions + notices;
}

function classSignal(element) {
  const signature = `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
  return /(^|[\s_-])(pester|troll|chat|plog|tlog|memo|terminal|conversation|dialogue|logbox|board)([\s_-]|$)/i.test(signature);
}

function parseRgb(color) {
  const match = String(color || "").match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isTransparent(color) {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

function colorDistance(first, second) {
  const a = parseRgb(first);
  const b = parseRgb(second);
  if (!a || !b) return first === second ? 0 : 999;
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function borderTotal(style) {
  return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
}

function alreadyReadablePanel(element, userstuff, readerBackground) {
  let current = element;
  while (current && current !== userstuff.parentElement) {
    const style = getComputedStyle(current);
    const rect = current.getBoundingClientRect();
    const userRect = userstuff.getBoundingClientRect();
    const distinctBackground =
      !isTransparent(style.backgroundColor) && colorDistance(style.backgroundColor, readerBackground) > 42;
    const panelGeometry =
      borderTotal(style) > 2 ||
      (style.boxShadow && style.boxShadow !== "none") ||
      (style.backgroundImage && style.backgroundImage !== "none") ||
      Math.max(
        Number.parseFloat(style.borderTopLeftRadius) || 0,
        Number.parseFloat(style.borderTopRightRadius) || 0,
        Number.parseFloat(style.borderBottomLeftRadius) || 0,
        Number.parseFloat(style.borderBottomRightRadius) || 0,
      ) > 3;
    const inset = rect.width < userRect.width * 0.94;

    if (panelGeometry) return true;
    if (distinctBackground && (inset || classSignal(current))) return true;
    if (current === userstuff) break;
    current = current.parentElement;
  }
  return false;
}

function ensureStyle(shadow) {
  if (shadow.querySelector("#homeslop-fallback-format-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-fallback-format-style";
  style.textContent = `
    [${FALLBACK_ATTR}] {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      margin: 1.35rem auto !important;
      padding: 1rem clamp(.85rem, 4vw, 1.3rem) !important;
      box-sizing: border-box !important;
      overflow-wrap: anywhere !important;
      color: #171717 !important;
      background: #f7f7f7 !important;
      border: 3px solid #666 !important;
      border-radius: 4px !important;
      box-shadow: 5px 5px 0 rgba(0, 0, 0, .28) !important;
      font-family: "Courier New", Courier, monospace !important;
      font-size: clamp(.92rem, 3.8vw, 1rem) !important;
      line-height: 1.48 !important;
    }
    [${FALLBACK_ATTR}] p,
    [${FALLBACK_ATTR}] li,
    [${FALLBACK_ATTR}] > div,
    [${FALLBACK_ATTR}] > span {
      margin-top: .48rem !important;
      margin-bottom: .48rem !important;
      line-height: 1.48 !important;
    }
    [${FALLBACK_ATTR}] [${CONTRAST_ATTR}] { color: var(--homeslop-safe-color) !important; }
  `;
  shadow.append(style);
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(linearChannel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first, second) {
  const bright = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (bright + 0.05) / (dark + 0.05);
}

function safeColor(rgb) {
  let result = [...rgb];
  for (let attempt = 0; attempt < 18 && contrast(result, [247, 247, 247]) < 4.3; attempt += 1) {
    result = result.map((value) => Math.max(0, Math.round(value * 0.84)));
  }
  return result;
}

function repairContrast(container) {
  [container, ...container.querySelectorAll("*")].forEach((element) => {
    element.removeAttribute(CONTRAST_ATTR);
    element.style.removeProperty("--homeslop-safe-color");
    const hasText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
    );
    if (!hasText) return;
    const rgb = parseRgb(getComputedStyle(element).color);
    if (!rgb || contrast(rgb, [247, 247, 247]) >= 4.3) return;
    const [r, g, b] = safeColor(rgb);
    element.style.setProperty("--homeslop-safe-color", `rgb(${r} ${g} ${b})`);
    element.setAttribute(CONTRAST_ATTR, "");
  });
}

function unwrapGenerated(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  element.remove();
}

function enforceSingleFallbackLayer(root) {
  const fallbacks = [...root.querySelectorAll(`[${FALLBACK_ATTR}]`)];

  fallbacks.forEach((outer) => {
    if (!outer.querySelector(`[${FALLBACK_ATTR}]`)) return;

    outer.removeAttribute(FALLBACK_ATTR);
    outer.removeAttribute(CONTRAST_ATTR);
    outer.style.removeProperty("--homeslop-safe-color");

    if (outer.hasAttribute(GENERATED_ATTR)) {
      unwrapGenerated(outer);
    }
  });
}

function deepestDenseCandidates(userstuff) {
  const all = [userstuff, ...userstuff.querySelectorAll("p, div, section, article, blockquote, li")];
  const dense = all.filter((element) => {
    const markers = markerCount(element.textContent);
    if (markers < 3) return false;
    const words = normalize(element.textContent).split(" ").filter(Boolean).length;
    return markers / Math.max(1, words) >= 0.035 || markers >= 6;
  });

  return dense.filter((candidate) =>
    !dense.some((other) => other !== candidate && candidate.contains(other)),
  );
}

function lineLike(element) {
  return markerCount(element.textContent) > 0 || classSignal(element);
}

function siblingRuns(parent) {
  const children = [...parent.children].filter((child) => {
    const style = getComputedStyle(child);
    return !child.hasAttribute(GENERATED_ATTR) && style.display !== "none" && child.getBoundingClientRect().height > 0;
  });
  const runs = [];
  let start = -1;
  let lastHit = -1;
  let hits = 0;

  const finish = () => {
    if (start >= 0 && hits >= 3 && lastHit >= start) runs.push({ children, start, end: lastHit });
    start = -1;
    lastHit = -1;
    hits = 0;
  };

  children.forEach((child, index) => {
    if (lineLike(child)) {
      if (start < 0) start = index;
      lastHit = index;
      hits += 1;
      return;
    }
    const shortGap = start >= 0 && normalize(child.textContent).length < 100 && index - lastHit <= 2;
    if (!shortGap) finish();
  });
  finish();
  return runs;
}

function elementsInRun(run) {
  return run.children.slice(run.start, run.end + 1);
}

function wrapRun(parent, run, userstuff, readerBackground) {
  const first = run.children[run.start];
  const last = run.children[run.end];
  if (!first || !last || first.parentElement !== parent || last.parentElement !== parent) return null;

  const range = elementsInRun(run);
  const overlapsFallback = range.some(
    (element) => element.matches(`[${FALLBACK_ATTR}]`) || element.querySelector(`[${FALLBACK_ATTR}]`),
  );
  if (overlapsFallback || first.closest(`[${FALLBACK_ATTR}]`)) return null;
  if (alreadyReadablePanel(parent, userstuff, readerBackground)) return null;

  const wrapper = document.createElement("div");
  wrapper.setAttribute(FALLBACK_ATTR, "");
  wrapper.setAttribute(GENERATED_ATTR, "");
  wrapper.setAttribute("aria-label", "Chat log");
  parent.insertBefore(wrapper, first);

  let current = first;
  while (current) {
    const next = current.nextElementSibling;
    wrapper.append(current);
    if (current === last) break;
    current = next;
  }
  return wrapper;
}

function applyFormatting() {
  scheduled = 0;
  if (applying) return;
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  applying = true;
  ensureStyle(shadow);
  const readerBackground = getComputedStyle(shadow.querySelector(".reader-document") || workskin).backgroundColor;

  try {
    enforceSingleFallbackLayer(workskin);

    shadow.querySelectorAll("#workskin .userstuff").forEach((userstuff) => {
      deepestDenseCandidates(userstuff).forEach((candidate) => {
        if (candidate.closest(`[${FALLBACK_ATTR}]`)) return;
        if (candidate.querySelector(`[${FALLBACK_ATTR}]`)) return;
        if (alreadyReadablePanel(candidate, userstuff, readerBackground)) return;
        candidate.setAttribute(FALLBACK_ATTR, "");
      });

      const parents = [userstuff, ...userstuff.querySelectorAll("div, section, article")]
        .filter((parent) => !parent.closest(`[${GENERATED_ATTR}]`));
      parents.forEach((parent) => {
        [...siblingRuns(parent)].reverse().forEach((run) => {
          wrapRun(parent, run, userstuff, readerBackground);
        });
      });
    });

    enforceSingleFallbackLayer(workskin);
    workskin.querySelectorAll(`[${FALLBACK_ATTR}]`).forEach(repairContrast);
  } finally {
    applying = false;
  }
}

function scheduleFormatting() {
  if (scheduled) cancelAnimationFrame(scheduled);
  scheduled = requestAnimationFrame(applyFormatting);
}

function connect() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;
  observer?.disconnect();
  observer = new MutationObserver(scheduleFormatting);
  observer.observe(shadow, { childList: true, subtree: true });
  scheduleFormatting();
  return true;
}

if (!connect()) {
  const shellObserver = new MutationObserver(() => {
    if (connect()) shellObserver.disconnect();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
}