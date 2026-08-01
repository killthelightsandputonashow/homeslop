const FALLBACK_ATTR = "data-homeslop-fallback-log";
const GENERATED_ATTR = "data-homeslop-generated-log";
const CONTRAST_ATTR = "data-homeslop-safe-color";

let fallbackObserver = null;
let fallbackFrame = 0;
let fallbackPassRunning = false;

function isTransparent(color) {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

function classSignature(element) {
  return `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
}

function looksLikeChatSignature(element) {
  return /(^|[\s_-])(pester|troll|chat|plog|tlog|memo|terminal|conversation|dialogue|logbox|board)([\s_-]|$)/i.test(
    classSignature(element),
  );
}

function normalizedText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeChatLine(text) {
  const line = normalizedText(text);
  if (!line) return false;

  return (
    /^(?:--\s*)?[A-Z]{1,5}\s*:/i.test(line) ||
    /^\[[^\]]*(?:began|ceased|started|stopped|added|removed|joined|left|online|offline)[^\]]*\]/i.test(line) ||
    /\b(?:began|ceased|started|stopped)\s+(?:trolling|pestering)\b/i.test(line) ||
    /^(?:Pinned note|[A-Za-z][\w-]+\s+(?:added|removed|joined|left)\s+)/i.test(line) ||
    /<\/?>(?:\s*)$/i.test(line)
  );
}

function elementLooksLikeChatLine(element) {
  if (looksLikeChatSignature(element)) return true;

  const text = normalizedText(element.textContent);
  if (!text) return false;
  if (looksLikeChatLine(text)) return true;

  const descendantLines = [...element.querySelectorAll(":scope > p, :scope > div, :scope > li, :scope > span")]
    .map((child) => normalizedText(child.textContent))
    .filter(Boolean);

  if (descendantLines.length < 2) return false;
  const hits = descendantLines.filter(looksLikeChatLine).length;
  return hits >= 2 && hits / descendantLines.length >= 0.5;
}

function visibleBorderWidth(style) {
  return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .map((value) => Number.parseFloat(value) || 0)
    .reduce((total, value) => total + value, 0);
}

function parseRgb(color) {
  const match = String(color || "").match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function colorsAreVisuallySame(first, second) {
  const a = parseRgb(first);
  const b = parseRgb(second);
  if (!a || !b) return first === second;

  const distance = Math.sqrt(
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2,
  );
  return distance < 28;
}

function hasStrongPanelStyling(candidate, userstuff, readerBackground) {
  const readerRect = userstuff.getBoundingClientRect();
  let current = candidate;

  while (current && current !== userstuff.parentElement) {
    const style = getComputedStyle(current);
    const rect = current.getBoundingClientRect();
    const backgroundImage = style.backgroundImage && style.backgroundImage !== "none";
    const border = visibleBorderWidth(style) > 1;
    const shadow = style.boxShadow && style.boxShadow !== "none";
    const radius = Math.max(
      Number.parseFloat(style.borderTopLeftRadius) || 0,
      Number.parseFloat(style.borderTopRightRadius) || 0,
      Number.parseFloat(style.borderBottomRightRadius) || 0,
      Number.parseFloat(style.borderBottomLeftRadius) || 0,
    );
    const padding =
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingRight) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0) +
      (Number.parseFloat(style.paddingLeft) || 0);

    const hasBackground = !isTransparent(style.backgroundColor);
    const backgroundIsDistinct =
      hasBackground && !colorsAreVisuallySame(style.backgroundColor, readerBackground);
    const nearlyFullReaderWidth = rect.width >= readerRect.width * 0.94;
    const classSignal = looksLikeChatSignature(current);

    if (backgroundImage || border || shadow) return true;
    if (backgroundIsDistinct && padding > 10 && (!nearlyFullReaderWidth || radius > 2 || classSignal)) {
      return true;
    }

    if (current === userstuff) break;
    current = current.parentElement;
  }

  return false;
}

function ensureFallbackStyle(shadow) {
  let style = shadow.querySelector("#homeslop-fallback-format-style");
  if (style) return;

  style = document.createElement("style");
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

    [${FALLBACK_ATTR}] [${CONTRAST_ATTR}] {
      color: var(--homeslop-safe-color) !important;
    }
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

function contrastRatio(first, second) {
  const bright = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (bright + 0.05) / (dark + 0.05);
}

function accessibleOnLight(rgb) {
  const background = [247, 247, 247];
  let adjusted = [...rgb];
  let attempts = 0;

  while (contrastRatio(adjusted, background) < 4.3 && attempts < 18) {
    adjusted = adjusted.map((value) => Math.max(0, Math.round(value * 0.84)));
    attempts += 1;
  }

  return adjusted;
}

function repairFallbackContrast(container) {
  const elements = [container, ...container.querySelectorAll("*")];

  elements.forEach((element) => {
    element.removeAttribute(CONTRAST_ATTR);
    element.style.removeProperty("--homeslop-safe-color");

    const hasOwnText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
    );
    if (!hasOwnText) return;

    const rgb = parseRgb(getComputedStyle(element).color);
    if (!rgb || contrastRatio(rgb, [247, 247, 247]) >= 4.3) return;

    const [r, g, b] = accessibleOnLight(rgb);
    element.style.setProperty("--homeslop-safe-color", `rgb(${r} ${g} ${b})`);
    element.setAttribute(CONTRAST_ATTR, "");
  });
}

function visibleDirectChildren(parent) {
  return [...parent.children].filter((child) => {
    if (child.hasAttribute(GENERATED_ATTR)) return false;
    const style = getComputedStyle(child);
    const rect = child.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.height > 0;
  });
}

function chatRunsForParent(parent) {
  const children = visibleDirectChildren(parent);
  if (children.length < 3) return [];

  const runs = [];
  let start = -1;
  let end = -1;
  let chatCount = 0;
  let gapCount = 0;

  const finishRun = () => {
    if (start >= 0 && chatCount >= 3 && end >= start) {
      const spanLength = end - start + 1;
      if (chatCount / spanLength >= 0.45) {
        runs.push({ start, end, chatCount, children });
      }
    }
    start = -1;
    end = -1;
    chatCount = 0;
    gapCount = 0;
  };

  children.forEach((child, index) => {
    const text = normalizedText(child.textContent);
    const isChat = elementLooksLikeChatLine(child);
    const hardBreak =
      !isChat &&
      (text.length > 220 || child.matches("hr, img, picture, figure, table, pre, blockquote"));

    if (isChat) {
      if (start < 0) start = index;
      end = index;
      chatCount += 1;
      gapCount = 0;
      return;
    }

    if (start < 0) return;

    if (!hardBreak && gapCount < 2 && text.length < 140) {
      end = index;
      gapCount += 1;
      return;
    }

    finishRun();
  });

  finishRun();
  return runs;
}

function wrapChatRun(parent, run, userstuff, readerBackground) {
  const first = run.children[run.start];
  const last = run.children[run.end];
  if (!first?.parentElement || first.parentElement !== parent || last.parentElement !== parent) return null;
  if (first.closest(`[${FALLBACK_ATTR}]`)) return null;
  if (hasStrongPanelStyling(parent, userstuff, readerBackground)) return null;

  const wrapper = document.createElement("div");
  wrapper.setAttribute(FALLBACK_ATTR, "");
  wrapper.setAttribute(GENERATED_ATTR, "");
  wrapper.setAttribute("role", "group");
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

function fallbackWholeContainer(candidate, userstuff, readerBackground) {
  if (candidate.hasAttribute(FALLBACK_ATTR) || candidate.closest(`[${FALLBACK_ATTR}]`)) return false;
  if (hasStrongPanelStyling(candidate, userstuff, readerBackground)) return false;

  const nodes = [...candidate.querySelectorAll(":scope > p, :scope > div, :scope > li, :scope > span")];
  if (nodes.length < 4) return false;
  const hits = nodes.filter(elementLooksLikeChatLine).length;
  if (hits < 4 || hits / nodes.length < 0.38) return false;

  candidate.setAttribute(FALLBACK_ATTR, "");
  return true;
}

function applyFallbackFormatting() {
  fallbackFrame = 0;
  if (fallbackPassRunning) return;

  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  fallbackPassRunning = true;
  ensureFallbackStyle(shadow);

  const readerBackground = getComputedStyle(
    shadow.querySelector(".reader-document") || workskin,
  ).backgroundColor;

  try {
    shadow.querySelectorAll(`[${FALLBACK_ATTR}]`).forEach(repairFallbackContrast);

    shadow.querySelectorAll("#workskin .userstuff").forEach((userstuff) => {
      const parents = [userstuff, ...userstuff.querySelectorAll("div, section, article")]
        .filter((parent) => !parent.closest(`[${GENERATED_ATTR}]`))
        .sort((a, b) => {
          const aDepth = a.querySelectorAll("*").length;
          const bDepth = b.querySelectorAll("*").length;
          return aDepth - bDepth;
        });

      parents.forEach((parent) => {
        const runs = chatRunsForParent(parent);
        [...runs].reverse().forEach((run) => {
          const wrapper = wrapChatRun(parent, run, userstuff, readerBackground);
          if (wrapper) requestAnimationFrame(() => repairFallbackContrast(wrapper));
        });
      });

      [userstuff, ...userstuff.querySelectorAll("div, section, article")].forEach((candidate) => {
        if (fallbackWholeContainer(candidate, userstuff, readerBackground)) {
          requestAnimationFrame(() => repairFallbackContrast(candidate));
        }
      });
    });
  } finally {
    fallbackPassRunning = false;
  }
}

function scheduleFallbackFormatting() {
  if (fallbackFrame) cancelAnimationFrame(fallbackFrame);
  fallbackFrame = requestAnimationFrame(applyFallbackFormatting);
}

function connectFallbackObserver() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  fallbackObserver?.disconnect();
  fallbackObserver = new MutationObserver(scheduleFallbackFormatting);
  fallbackObserver.observe(shadow, { childList: true, subtree: true });
  scheduleFallbackFormatting();
  return true;
}

if (!connectFallbackObserver()) {
  const shellObserver = new MutationObserver(() => {
    if (connectFallbackObserver()) shellObserver.disconnect();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
}
