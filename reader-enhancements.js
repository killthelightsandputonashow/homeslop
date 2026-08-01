const readerView = document.querySelector("#reader-view");
const readerFrame = document.querySelector("#reader-frame");

let frameResizeObserver = null;
let pendingResize = 0;

const AO3ISH_READER_CSS = `
  :where(*, *::before, *::after) { box-sizing: border-box; }

  :where(html) {
    width: 100%;
    min-height: 0;
    margin: 0;
    overflow-x: hidden;
    overflow-y: hidden;
    background: #fff;
    color-scheme: light;
  }

  :where(body) {
    width: 100%;
    max-width: 46rem;
    min-height: 0;
    margin: 0 auto;
    padding: 1rem 1rem 5rem;
    overflow-x: hidden;
    overflow-y: hidden;
    color: #2a2a2a;
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.45;
    text-rendering: optimizeLegibility;
    -webkit-text-size-adjust: 100%;
  }

  :where(#workskin) {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    margin: 0 auto;
  }

  :where(#workskin .preface) {
    margin: 0 0 1.6rem;
    padding: 0.35rem 0 1.1rem;
    border-bottom: 1px solid #d7d7d7;
  }

  :where(#workskin .preface .title) {
    margin: 0.4rem 0 0.6rem;
    color: #222;
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(1.55rem, 7vw, 2.15rem);
    line-height: 1.15;
    text-align: center;
  }

  :where(#workskin .preface .byline) {
    margin: 0.35rem 0 1.25rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.35;
    text-align: center;
  }

  :where(#workskin .preface .summary, #workskin .preface .notes) {
    width: min(100%, 40rem);
    margin: 1.25rem auto 0;
    padding: 0;
  }

  :where(#workskin .preface .summary h3, #workskin .preface .notes h3) {
    margin: 0 0 0.45rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 1rem;
    line-height: 1.3;
  }

  :where(#workskin .userstuff) {
    max-width: 100%;
    color: #222;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 1.02rem;
    line-height: 1.58;
    overflow-wrap: break-word;
  }

  :where(#workskin .userstuff p) {
    margin: 0 0 1.15em;
  }

  :where(#workskin .userstuff h1, #workskin .userstuff h2, #workskin .userstuff h3,
         #workskin .userstuff h4, #workskin .userstuff h5, #workskin .userstuff h6) {
    margin: 1.5em 0 0.65em;
    line-height: 1.22;
  }

  :where(#workskin .userstuff blockquote) {
    margin: 1.25em 1.5em;
  }

  :where(#workskin img, #workskin video, #workskin svg, #workskin canvas) {
    max-width: 100%;
    height: auto;
  }

  :where(#workskin pre, #workskin table) {
    max-width: 100%;
    overflow-x: auto;
  }

  :where(#workskin hr) {
    margin: 2rem 0;
    border: 0;
    border-top: 1px solid #999;
  }

  :where(#workskin a) {
    color: #5e147d;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.12em;
  }

  @media (max-width: 520px) {
    :where(body) {
      padding: 0.9rem 1rem 4rem;
    }

    :where(#workskin .userstuff) {
      font-size: 1rem;
      line-height: 1.56;
    }

    :where(#workskin .userstuff blockquote) {
      margin-inline: 0.85rem;
    }
  }
`;

function updateReaderMode() {
  const isOpen = readerView?.classList.contains("is-visible") ?? false;
  document.body.classList.toggle("reader-mode", isOpen);

  if (isOpen) {
    window.setTimeout(resizeReaderFrame, 0);
    window.setTimeout(resizeReaderFrame, 120);
  }
}

function disconnectFrameObservers() {
  if (frameResizeObserver) {
    frameResizeObserver.disconnect();
    frameResizeObserver = null;
  }

  if (pendingResize) {
    cancelAnimationFrame(pendingResize);
    pendingResize = 0;
  }
}

function resizeReaderFrame() {
  if (!readerFrame || !readerView?.classList.contains("is-visible")) return;

  const frameDocument = readerFrame.contentDocument;
  if (!frameDocument?.documentElement || !frameDocument.body) return;

  if (pendingResize) cancelAnimationFrame(pendingResize);

  pendingResize = requestAnimationFrame(() => {
    pendingResize = 0;
    const html = frameDocument.documentElement;
    const body = frameDocument.body;
    const height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.scrollHeight,
      html.offsetHeight,
      1,
    );

    readerFrame.style.height = `${Math.ceil(height)}px`;
  });
}

function prepareReaderDocument() {
  disconnectFrameObservers();

  const frameDocument = readerFrame?.contentDocument;
  if (!frameDocument?.head || !frameDocument.body) return;

  const previousStyle = frameDocument.querySelector("#homeslop-reader-defaults");
  previousStyle?.remove();

  const style = frameDocument.createElement("style");
  style.id = "homeslop-reader-defaults";
  style.textContent = AO3ISH_READER_CSS;
  frameDocument.head.append(style);

  readerFrame.setAttribute("scrolling", "no");
  readerFrame.style.height = "1px";

  if ("ResizeObserver" in window) {
    frameResizeObserver = new ResizeObserver(resizeReaderFrame);
    frameResizeObserver.observe(frameDocument.documentElement);
    frameResizeObserver.observe(frameDocument.body);
  }

  frameDocument.fonts?.ready.then(resizeReaderFrame).catch(() => {});

  frameDocument.querySelectorAll("img, video, audio").forEach((asset) => {
    asset.addEventListener("load", resizeReaderFrame, { once: true });
    asset.addEventListener("error", resizeReaderFrame, { once: true });
  });

  resizeReaderFrame();
  window.setTimeout(resizeReaderFrame, 80);
  window.setTimeout(resizeReaderFrame, 350);
}

if (readerView) {
  new MutationObserver(updateReaderMode).observe(readerView, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

readerFrame?.addEventListener("load", prepareReaderDocument);
window.addEventListener("resize", resizeReaderFrame);
window.addEventListener("orientationchange", () => window.setTimeout(resizeReaderFrame, 150));

updateReaderMode();
