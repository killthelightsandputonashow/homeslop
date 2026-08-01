const MOBILE_LAYOUT_MAX = 720;
const STACK_ATTR = "data-homeslop-mobile-stack";
const PANEL_ATTR = "data-homeslop-mobile-panel";
const POSITIONED_ATTR = "data-homeslop-mobile-positioned";

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
    }
  `;
  shadow.append(style);
  return style;
}

function clearMobileLayoutMarkers(root) {
  root.querySelectorAll(`[${STACK_ATTR}]`).forEach((element) => element.removeAttribute(STACK_ATTR));
  root.querySelectorAll(`[${PANEL_ATTR}]`).forEach((element) => element.removeAttribute(PANEL_ATTR));
  root.querySelectorAll(`[${POSITIONED_ATTR}]`).forEach((element) => element.removeAttribute(POSITIONED_ATTR));
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
