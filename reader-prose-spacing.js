const PROSE_MAX_WIDTH = 720;
const PROSE_ATTR = "data-homeslop-prose";

let pendingProsePass = 0;
let proseObserver = null;

function looksLikeChatSignature(element) {
  const signature = `${element.id || ""} ${element.className || ""}`;
  return /(^|[\s_-])(pester|troll|chat|plog|tlog|memo|log|terminal|conversation)([\s_-]|$)/i.test(
    signature,
  );
}

function paragraphIsPlainProse(paragraph, userstuff) {
  const text = (paragraph.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  if (/^(?:--|[A-Z]{1,4}:\s)/.test(text)) return false;
  if (paragraph.closest("pre, code, table, blockquote")) return false;

  const paragraphStyle = getComputedStyle(paragraph);
  if (/(?:mono|courier|consolas|menlo)/i.test(paragraphStyle.fontFamily)) return false;
  if (/^pre/.test(paragraphStyle.whiteSpace)) return false;

  let current = paragraph.parentElement;
  while (current && current !== userstuff) {
    if (looksLikeChatSignature(current)) return false;
    current = current.parentElement;
  }

  return true;
}

function ensureProseStyle(shadow) {
  let style = shadow.querySelector("#homeslop-prose-spacing");
  if (style) return;

  style = document.createElement("style");
  style.id = "homeslop-prose-spacing";
  style.textContent = `
    @media (max-width: ${PROSE_MAX_WIDTH}px) {
      [${PROSE_ATTR}] {
        max-width: 100%;
        margin: 0 0 1.05em !important;
        line-height: 1.5 !important;
      }

      [${PROSE_ATTR}]:last-child {
        margin-bottom: 0 !important;
      }
    }
  `;
  shadow.append(style);
}

function classifyProse() {
  pendingProsePass = 0;

  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return;

  ensureProseStyle(shadow);
  shadow.querySelectorAll(`[${PROSE_ATTR}]`).forEach((element) => {
    element.removeAttribute(PROSE_ATTR);
  });

  shadow.querySelectorAll("#workskin .userstuff").forEach((userstuff) => {
    userstuff.querySelectorAll("p").forEach((paragraph) => {
      if (paragraphIsPlainProse(paragraph, userstuff)) {
        paragraph.setAttribute(PROSE_ATTR, "");
      }
    });
  });
}

function scheduleProsePass() {
  if (pendingProsePass) cancelAnimationFrame(pendingProsePass);
  pendingProsePass = requestAnimationFrame(classifyProse);
}

function connectProseObserver() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  proseObserver?.disconnect();
  proseObserver = new MutationObserver(scheduleProsePass);
  proseObserver.observe(shadow, { childList: true, subtree: true });
  scheduleProsePass();
  return true;
}

if (!connectProseObserver()) {
  const shellObserver = new MutationObserver(() => {
    if (connectProseObserver()) shellObserver.disconnect();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
}
