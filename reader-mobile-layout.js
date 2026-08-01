const MOBILE_LAYOUT_MAX = 720;
const STACK_ATTR = "data-homeslop-mobile-stack";
const PANEL_ATTR = "data-homeslop-mobile-panel";
const POSITIONED_ATTR = "data-homeslop-mobile-positioned";
const GAP_BEFORE_ATTR = "data-homeslop-gap-before";
const GAP_AFTER_ATTR = "data-homeslop-gap-after";
const SPACER_ATTR = "data-homeslop-empty-spacer";

let mobileLayoutObserver = null;
let pendingMobileLayout = 0;
let delayedMobileLayout = 0;

function visibleElementChildren(element) {
  return [...element.children].filter((child) => {
    const rect = child.getBoundingClientRect();
    const style = getComputedStyle(child);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8;
  });
}

function verticalOverlap(a, b) {
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function hasHorizontalPair(children) {
  const rects = children.map((child) => child.getBoundingClientRect());

  for (let first = 0; first < rects.length; first += 1) {
    for (let second = first + 1; second < rects.length; second += 1) {
      const a = rects[first];
      const b = rects[second];
      const overlap = verticalOverlap(a, b);
      const minimumHeight = Math.min(a.height, b.height);
      const horizontallySeparated = Math.abs(a.left - b.left) > Math.min(a.width, b.width) * 0.35;

      if (minimumHeight > 0 && overlap > minimumHeight * 0.35 && horizontallySeparated) {
        return true;
      }
    }
  }

  return false;
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

function looksLikeChatBlock(element) {
  const signature = `${element.id || ""} ${element.className || ""}`;
  if (/(^|[\s_-])(pester|troll|chat|plog|tlog|memo|log)([\s_-]|$)/i.test(signature)) return true;

  const text = (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 450);
  return /\bTrolling:|began (?:trolling|pestering)|started (?:trolling|pestering)/i.test(text);
}

function isTransparent(color) {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

function isHarmlessSpacer(element) {
  const text = (element.textContent || "").replace(/\u00a0/g, " ").trim();
  if (text) return false;
  if (element.querySelector("img, picture, svg, video, audio, canvas, hr, table, pre")) return false;

  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (rect.height < 18 || rect.height > 240) return false;

  const border = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .some((value) => Number.parseFloat(value) > 0);

  return !border && isTransparent(style.backgroundColor);
}

function ensureMobileLayoutStyle(shadow) {
  let style = shadow.querySelector("#homeslop-mobile-layout");
  if (style) return style;

  style = document.createElement("style");
  style.id = "homeslop-mobile-layout";
  style.textContent = `
    @media (max-width: ${MOBILE_LAYOUT_MAX}px) {
      [${STACK_ATTR}] {
        display: flex !important;
        flex-direction: column !important;
        flex-wrap: nowrap !important;
        align-items: stretch !important;
        grid-template-columns: minmax(0, 1fr) !important;
        grid-auto-flow: row !important;
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        overflow: visible !important;
      }

      [${STACK_ATTR}] > [${PANEL_ATTR}] {
        display: block !important;
        float: none !important;
        clear: both !important;
        flex: 0 0 auto !important;
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      [${STACK_ATTR}] > [${POSITIONED_ATTR}] {
        position: relative !important;
        inset: auto !important;
      }

      [${GAP_BEFORE_ATTR}] {
        margin-top: 1.15rem !important;
      }

      [${GAP_AFTER_ATTR}] {
        margin-bottom: 1.15rem !important;
      }

      [${SPACER_ATTR}] {
        display: none !important;
      }
    }
  `;
  shadow.append(style);
  return style;
}

function clearMobileLayoutMarkers(root) {
  [STACK_ATTR, PANEL_ATTR, POSITIONED_ATTR, GAP_BEFORE_ATTR, GAP_AFTER_ATTR, SPACER_ATTR]
    .forEach((attribute) => {
      root.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute));
    });
}

function normalizeSequentialGaps(workskin) {
  [workskin, ...workskin.querySelectorAll("*")].forEach((parent) => {
    const children = [...parent.children].filter((child) => {
      const style = getComputedStyle(child);
      return style.display !== "none" && style.visibility !== "hidden";
    });

    if (children.length < 2) return;

    children.forEach((child, index) => {
      if (!isHarmlessSpacer(child)) return;
      const previous = children[index - 1];
      const next = children[index + 1];
      if (previous && next && (looksLikeChatBlock(previous) || looksLikeChatBlock(next))) {
        child.setAttribute(SPACER_ATTR, "");
      }
    });

    const visible = children.filter((child) => !child.hasAttribute(SPACER_ATTR));
    for (let index = 1; index < visible.length; index += 1) {
      const previous = visible[index - 1];
      const next = visible[index];
      if (!looksLikeChatBlock(previous) && !looksLikeChatBlock(next)) continue;

      const previousRect = previous.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      const gap = nextRect.top - previousRect.bottom;

      if (gap > 42) {
        previous.setAttribute(GAP_AFTER_ATTR, "");
        next.setAttribute(GAP_BEFORE_ATTR, "");
      }
    }
  });
}

function applyMobileLayout() {
  pendingMobileLayout = 0;

  const host = document.querySelector("#reader-shadow");
  const shadow = host?.shadowRoot;
  const readerDocument = shadow?.querySelector(".reader-document");
  const workskin = shadow?.querySelector("#workskin");

  if (!shadow || !readerDocument || !workskin) return;

  ensureMobileLayoutStyle(shadow);
  clearMobileLayoutMarkers(readerDocument);

  if (window.innerWidth > MOBILE_LAYOUT_MAX) return;

  const readerRect = readerDocument.getBoundingClientRect();
  const disallowedParents = new Set(["TABLE", "TBODY", "THEAD", "TFOOT", "TR"]);
  const candidates = [];

  [workskin, ...workskin.querySelectorAll("*")].forEach((parent) => {
    if (disallowedParents.has(parent.tagName)) return;

    const children = visibleElementChildren(parent);
    if (children.length < 2 || !hasHorizontalPair(children)) return;

    const parentRect = parent.getBoundingClientRect();
    if (parentRect.width < 80 || parentRect.height < 20) return;

    const childRects = children.map((child) => child.getBoundingClientRect());
    const furthestRight = Math.max(...childRects.map((rect) => rect.right));
    const furthestLeft = Math.min(...childRects.map((rect) => rect.left));
    const overflowAmount = Math.max(
      0,
      parent.scrollWidth - parent.clientWidth,
      furthestRight - readerRect.right,
      readerRect.left - furthestLeft,
    );

    if (overflowAmount < 6) return;

    candidates.push({
      element: parent,
      children,
      depth: depthWithin(workskin, parent),
      overflowAmount,
    });
  });

  candidates
    .sort((a, b) => a.depth - b.depth || b.overflowAmount - a.overflowAmount)
    .forEach(({ element, children }) => {
      if (element.closest(`[${STACK_ATTR}]`)) return;

      element.setAttribute(STACK_ATTR, "");
      children.forEach((child) => {
        child.setAttribute(PANEL_ATTR, "");
        const position = getComputedStyle(child).position;
        if (position === "absolute" || position === "fixed") {
          child.setAttribute(POSITIONED_ATTR, "");
        }
      });
    });

  normalizeSequentialGaps(workskin);
}

function scheduleMobileLayout() {
  if (pendingMobileLayout) cancelAnimationFrame(pendingMobileLayout);
  if (delayedMobileLayout) clearTimeout(delayedMobileLayout);

  pendingMobileLayout = requestAnimationFrame(applyMobileLayout);
  delayedMobileLayout = window.setTimeout(applyMobileLayout, 180);
}

function connectMobileLayoutObserver() {
  const host = document.querySelector("#reader-shadow");
  const shadow = host?.shadowRoot;
  if (!shadow) return false;

  mobileLayoutObserver?.disconnect();
  mobileLayoutObserver = new MutationObserver(scheduleMobileLayout);
  mobileLayoutObserver.observe(shadow, { childList: true, subtree: true });
  scheduleMobileLayout();
  return true;
}

if (!connectMobileLayoutObserver()) {
  const shellObserver = new MutationObserver(() => {
    if (connectMobileLayoutObserver()) shellObserver.disconnect();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
}

window.addEventListener("resize", scheduleMobileLayout);
window.addEventListener("orientationchange", () => window.setTimeout(scheduleMobileLayout, 120));
