const PROSE_MAX_WIDTH = 720;

function installProseSpacing() {
  const host = document.querySelector("#reader-shadow");
  const shadow = host?.shadowRoot;
  if (!shadow) return false;

  let style = shadow.querySelector("#homeslop-prose-spacing");
  if (style) return true;

  style = document.createElement("style");
  style.id = "homeslop-prose-spacing";
  style.textContent = `
    @media (max-width: ${PROSE_MAX_WIDTH}px) {
      #workskin .userstuff > p {
        max-width: 100%;
        margin-block: 1.15em !important;
      }

      #workskin .userstuff > p:first-child {
        margin-top: 0 !important;
      }

      #workskin .userstuff > p:last-child {
        margin-bottom: 0 !important;
      }
    }
  `;
  shadow.append(style);
  return true;
}

function watchReaderShadow() {
  const host = document.querySelector("#reader-shadow");
  const shadow = host?.shadowRoot;

  if (!shadow) return false;

  installProseSpacing();

  const observer = new MutationObserver(() => {
    installProseSpacing();
  });
  observer.observe(shadow, { childList: true });
  return true;
}

if (!watchReaderShadow()) {
  const shellObserver = new MutationObserver(() => {
    if (watchReaderShadow()) shellObserver.disconnect();
  });
  shellObserver.observe(document.body, { childList: true, subtree: true });
}
