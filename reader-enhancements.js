const readerView = document.querySelector("#reader-view");
const readerFrame = document.querySelector("#reader-frame");

let pendingRepair = 0;

const SAFE_READER_CSS = `
  html {
    width: 100%;
    min-height: 0;
    margin: 0;
    overflow-x: hidden;
    background: #fff;
    color-scheme: light;
    -webkit-text-size-adjust: 100%;
  }

  body {
    width: min(100%, 54rem);
    min-height: 0;
    margin: 0 auto;
    padding: 1.05rem 1rem 4rem;
    overflow-x: hidden;
    color: #222;
    background: #fff;
    font-family: "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.55;
    text-rendering: optimizeLegibility;
  }

  #workskin {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    margin: 0 auto;
  }

  #workskin .userstuff {
    max-width: 100%;
  }

  /* Only touch ordinary, top-level prose. Nested styled blocks are author territory. */
  #workskin .userstuff > p,
  #workskin .userstuff > ul,
  #workskin .userstuff > ol,
  #workskin .userstuff > blockquote {
    overflow-wrap: break-word;
  }

  #workskin .userstuff > p {
    margin: 0 0 1.15em;
  }

  #workskin .userstuff > blockquote {
    margin: 1.2em 1.25rem;
  }

  #workskin .userstuff > img,
  #workskin .userstuff > video,
  #workskin .userstuff > svg,
  #workskin .userstuff > canvas,
  #workskin .userstuff > p > img,
  #workskin .userstuff > p > video {
    max-width: 100%;
    height: auto;
  }

  #workskin .userstuff > pre,
  #workskin .userstuff > table {
    max-width: 100%;
    overflow-x: auto;
  }

  #workskin .preface {
    margin: 0 0 1.6rem;
  }

  #workskin .preface .title {
    margin: 0.2rem 0 0.7rem;
    font-size: clamp(1.35rem, 6vw, 1.9rem);
    line-height: 1.2;
    text-align: center;
  }

  #workskin .preface .byline {
    margin: 0.35rem 0 1rem;
    font-size: 0.95rem;
    text-align: center;
  }

  @media (max-width: 520px) {
    body {
      padding: 0.9rem 0.95rem 3.5rem;
    }

    #workskin .userstuff > blockquote {
      margin-inline: 0.75rem;
    }
  }
`;

function repairReaderDocument() {
  const frameDocument = readerFrame?.contentDocument;
  if (!frameDocument?.head || !frameDocument.body) return;

  if (pendingRepair) cancelAnimationFrame(pendingRepair);
  pendingRepair = requestAnimationFrame(() => {
    pendingRepair = 0;

    /* Remove Homeslop's earlier blanket stylesheet, not the author's workskin. */
    [...frameDocument.head.querySelectorAll("style")].forEach((style) => {
      const css = style.textContent || "";
      const isOldHomeslopDefaults =
        css.includes(":where(*, *::before, *::after)") &&
        css.includes("#workskin .userstuff p") &&
        css.includes("text-rendering: optimizeLegibility");

      if (isOldHomeslopDefaults) style.remove();
    });

    frameDocument.querySelector("#homeslop-safe-reader-defaults")?.remove();
    const safeStyle = frameDocument.createElement("style");
    safeStyle.id = "homeslop-safe-reader-defaults";
    safeStyle.textContent = SAFE_READER_CSS;

    /* Put our gentle defaults before author CSS so the workskin always wins. */
    const firstStyle = frameDocument.head.querySelector("style");
    if (firstStyle) {
      frameDocument.head.insertBefore(safeStyle, firstStyle);
    } else {
      frameDocument.head.append(safeStyle);
    }

    readerFrame.dispatchEvent(new Event("homeslop-reader-repaired"));
  });
}

function updateReaderMode() {
  const isOpen = readerView?.classList.contains("is-visible") ?? false;
  document.body.classList.toggle("reader-mode", isOpen);
  if (isOpen) window.setTimeout(repairReaderDocument, 0);
}

readerFrame?.addEventListener("load", () => {
  repairReaderDocument();
  window.setTimeout(repairReaderDocument, 80);
});

if (readerView) {
  new MutationObserver(updateReaderMode).observe(readerView, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

updateReaderMode();
