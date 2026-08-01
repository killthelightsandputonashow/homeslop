const FALLBACK_ATTR = "data-homeslop-fallback-log";
const CONTRAST_ATTR = "data-homeslop-safe-color";

let fallbackObserver = null;
let fallbackFrame = 0;

function isTransparent(color) {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

function classSignature(element) {
  return `${element.id || ""} ${typeof element.className === "string" ? element.className : ""}`;
}

function looksLikeAuthoredChatShell(element) {
  return /(^|[\s_-])(pester|troll|chat|plog|tlog|memo|terminal|conversation|dialogue|logbox)([\s_-]|$)/i.test(
    classSignature(element),
  );
}

function looksLikeChatLine(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return false;

  return (
    /^(?:--\s*)?[A-Z]{1,5}\s*:/i.test(line) ||
    /^\[[^\]]*(?:began|ceased|started|stopped|added|removed|joined|left|online|offline)[^\]]*\]/i.test(line) ||
    /\b(?:began|ceased|started|stopped)\s+(?:trolling|pestering)\b/i.test(line) ||
    /^(?:Pinned note|[A-Za-z][\w-]+\s+(?:added|removed)\s+)/i.test(line)
  );
}

function visibleBorderWidth(style) {
  return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .map((value) => Number.parseFloat(value) || 0)
    .reduce((total, value) => total + value, 0);
}

function hasAuthoredPanel(candidate, userstuff) {
  let current = candidate;

  while (current && current !== userstuff.parentElement) {
    if (looksLikeAuthoredChatShell(current)) return true;

    const style = getComputedStyle(current);
    const backgroundImage = style.backgroundImage && style.backgroundImage !== "none";
    const backgroundColor = !isTransparent(style.backgroundColor);
    const border = visibleBorderWidth(style) > 1;
    const shadow = style.boxShadow && style.boxShadow !== "none";
    const padding =
      (Number.parseFloat(style.paddingTop) || 0) +
      (Number.parseFloat(style.paddingRight) || 0) +
      (Number.parseFloat(style.paddingBottom) || 0) +
      (Number.parseFloat(style.paddingLeft) || 0);

    if (backgroundImage || border || shadow || (backgroundColor && padding > 10)) return true;
    if (current === userstuff) break;
    current = current.parentElement;
  }

  return false;
}

function candidateChatScore(candidate) {
  const direct = [...candidate.children].filter((child) => {
    const tag = child.tagName;
    return tag === "P" || tag === "DIV" || tag === "LI" || tag === "SPAN";
  });

  const nodes = direct.length >= 4 ? direct : [...candidate.querySelectorAll("p")];
  if (nodes.length < 5) return null;

  const chatCount = nodes.reduce(
    (count, node) => count + (looksLikeChatLine(node.textContent) ? 1 : 0),
    0,
  );
  const ratio = chatCount / nodes.length;

  if (chatCount < 4 || ratio < 0.55) return null;
  return { chatCount, ratio, nodes };
}

function depthWithin(root, element) {
  let depth = 0;
  let current = element;
  while (current && current !== root) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
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
    [${FALLBACK_ATTR}] > div {
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

function parseRgb(color) {
  const match = String(color || "").match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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

function applyFallbackFormatting() {
  fallbackFrame = 0;

  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  ensureFallbackStyle(shadow);
  shadow.querySelectorAll(`[${FALLBACK_ATTR}]`).forEach((element) => {
    element.removeAttribute(FALLBACK_ATTR);
  });

  const candidates = [];

  shadow.querySelectorAll("#workskin .userstuff").forEach((userstuff) => {
    [userstuff, ...userstuff.querySelectorAll("div, section, article")].forEach((candidate) => {
      if (candidate.closest(`[${FALLBACK_ATTR}]`)) return;
      const score = candidateChatScore(candidate);
      if (!score || hasAuthoredPanel(candidate, userstuff)) return;

      candidates.push({
        candidate,
        depth: depthWithin(userstuff, candidate),
        score: score.chatCount + score.ratio,
      });
    });
  });

  candidates
    .sort((a, b) => b.depth - a.depth || b.score - a.score)
    .forEach(({ candidate }) => {
      if (candidate.closest(`[${FALLBACK_ATTR}]`) || candidate.querySelector(`[${FALLBACK_ATTR}]`)) return;
      candidate.setAttribute(FALLBACK_ATTR, "");
      requestAnimationFrame(() => repairFallbackContrast(candidate));
    });
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
