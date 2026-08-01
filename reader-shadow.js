const frame = document.querySelector("#reader-frame");
const frameWrap = document.querySelector(".reader-frame-wrap");
const readerView = document.querySelector("#reader-view");
const deleteButton = document.querySelector("#reader-delete");

if (!frame || !frameWrap || !readerView) {
  console.warn("Homeslop shadow reader could not find the reader shell.");
} else {
  const host = document.createElement("div");
  host.id = "reader-shadow";
  host.setAttribute("aria-label", "Imported story chapter");
  frameWrap.prepend(host);

  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;

  const shadow = host.attachShadow({ mode: "open" });
  const THEME_KEY = "homeslop-reader-theme";
  let theme = localStorage.getItem(THEME_KEY) || "dark";

  const shellStyle = document.createElement("style");
  shellStyle.textContent = `
    #reader-frame {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      min-height: 0 !important;
    }

    #reader-shadow {
      display: block;
      width: 100%;
      min-width: 0;
      background: #fff;
    }

    html[data-homeslop-theme="dark"],
    html[data-homeslop-theme="dark"] body.reader-mode,
    html[data-homeslop-theme="dark"] .reader-view,
    html[data-homeslop-theme="dark"] .reader-frame-wrap,
    html[data-homeslop-theme="dark"] #reader-shadow {
      background: #111;
      color: #ddd;
    }

    html[data-homeslop-theme="dark"] .reader-topbar {
      background: rgba(24, 24, 24, .98);
      border-bottom-color: #444;
    }

    html[data-homeslop-theme="dark"] .reader-heading h1,
    html[data-homeslop-theme="dark"] .reader-heading p {
      color: #e5e5e5;
    }

    html[data-homeslop-theme="dark"] .reader-action,
    html[data-homeslop-theme="dark"] .chapter-button,
    html[data-homeslop-theme="dark"] .chapter-picker,
    html[data-homeslop-theme="dark"] .chapter-picker select {
      color: #e6e6e6;
      background: #242424;
      border-color: #555;
    }

    html[data-homeslop-theme="dark"] .reader-action.danger {
      color: #ff9bac;
    }

    html[data-homeslop-theme="dark"] .chapter-toolbar,
    html[data-homeslop-theme="dark"] .chapter-footer {
      color: #ddd;
      background: #151515;
      border-color: #333;
    }

    .reader-topbar {
      grid-template-columns: 44px minmax(0, 1fr) auto auto !important;
    }

    .theme-toggle {
      font-size: 1rem;
      line-height: 1;
    }
  `;
  document.head.append(shellStyle);

  const themeButton = document.createElement("button");
  themeButton.className = "reader-action theme-toggle";
  themeButton.type = "button";
  deleteButton?.before(themeButton);

  function rewriteRelativeCssUrls(css, baseUrl) {
    if (!baseUrl) return css;
    return css.replace(/url\(\s*(["']?)(?!data:|blob:|https?:|\/\/|#)([^"')]+)\1\s*\)/gi, (_match, quote, value) => {
      try {
        return `url(${quote}${new URL(value.trim(), baseUrl).toString()}${quote})`;
      } catch {
        return _match;
      }
    });
  }

  function baseReaderCss() {
    return `
      :host {
        --reader-bg: #fff;
        --reader-text: #222;
        --reader-muted: #666;
        --reader-link: #5e147d;
        display: block;
        width: 100%;
        min-width: 0;
        overflow: hidden;
        color: var(--reader-text);
        background: var(--reader-bg);
        color-scheme: light;
      }

      :host([data-theme="dark"]) {
        --reader-bg: #111;
        --reader-text: #d8d8d8;
        --reader-muted: #aaa;
        --reader-link: #c58bdd;
        color-scheme: dark;
      }

      .reader-document {
        width: 100%;
        max-width: 54rem;
        min-width: 0;
        margin: 0 auto;
        padding: 1rem clamp(.9rem, 4vw, 2rem) 4.5rem;
        overflow-x: hidden;
        color: var(--reader-text);
        background: var(--reader-bg);
        font-family: "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, Arial, sans-serif;
        font-size: 16px;
        line-height: 1.55;
        text-rendering: optimizeLegibility;
        -webkit-text-size-adjust: 100%;
      }

      :where(#workskin, #chapters, .chapter, .userstuff, .userstuff.module) {
        width: auto;
        max-width: 100%;
        min-width: 0;
      }

      :where(#workskin) {
        margin: 0 auto;
        color: inherit;
      }

      :where(#workskin .userstuff) {
        color: inherit;
        font-family: inherit;
        font-size: 1rem;
        line-height: 1.55;
        overflow-wrap: break-word;
        word-break: normal;
      }

      :where(#workskin .userstuff > p) {
        max-width: 100%;
        margin: 0 0 1.15em;
        overflow-wrap: break-word;
      }

      :where(#workskin .userstuff > div,
             #workskin .userstuff > section,
             #workskin .userstuff > article,
             #workskin .userstuff > table,
             #workskin .userstuff > pre,
             #workskin .userstuff > blockquote) {
        max-width: 100%;
      }

      :where(#workskin .preface) {
        max-width: 100%;
        margin: 0 0 1.6rem;
      }

      :where(#workskin .preface .title) {
        margin: .2rem 0 .7rem;
        color: inherit;
        font-size: clamp(1.35rem, 6vw, 1.9rem);
        line-height: 1.2;
        text-align: center;
      }

      :where(#workskin .preface .byline) {
        margin: .35rem 0 1rem;
        color: var(--reader-muted);
        font-size: .95rem;
        text-align: center;
      }

      :where(#workskin img, #workskin video, #workskin svg, #workskin canvas) {
        max-width: 100%;
        height: auto;
      }

      :where(#workskin pre, #workskin table) {
        max-width: 100%;
        overflow-x: auto;
      }

      :where(#workskin a) {
        color: var(--reader-link);
      }

      @media (max-width: 520px) {
        .reader-document {
          padding: .9rem .95rem 4rem;
        }
      }
    `;
  }

  function applyTheme(nextTheme, { save = true } = {}) {
    theme = nextTheme === "light" ? "light" : "dark";
    document.documentElement.dataset.homeslopTheme = theme;
    host.dataset.theme = theme;
    themeButton.textContent = theme === "dark" ? "☀" : "☾";
    themeButton.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
    );
    themeButton.title = theme === "dark" ? "Light mode" : "Dark mode";
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#111111" : "#f7b500",
    );
    if (save) localStorage.setItem(THEME_KEY, theme);
    renderFromFrame();
  }

  function renderFromFrame() {
    const frameDocument = frame.contentDocument;
    if (!frameDocument) return;

    const workskin = frameDocument.querySelector("#workskin");
    if (!workskin) return;

    const baseHref = frameDocument.querySelector("base")?.href || "";
    const styles = [...frameDocument.querySelectorAll("style")];
    const authorCss = styles
      .slice(1)
      .map((style) => style.textContent || "")
      .join("\n\n");

    shadow.replaceChildren();

    const defaults = document.createElement("style");
    defaults.textContent = baseReaderCss();
    shadow.append(defaults);

    if (authorCss.trim()) {
      const authorStyle = document.createElement("style");
      authorStyle.textContent = rewriteRelativeCssUrls(authorCss, baseHref);
      shadow.append(authorStyle);
    }

    const documentShell = document.createElement("article");
    documentShell.className = "reader-document";
    documentShell.append(workskin.cloneNode(true));
    shadow.append(documentShell);
  }

  themeButton.addEventListener("click", () => {
    applyTheme(theme === "dark" ? "light" : "dark");
  });

  frame.addEventListener("load", () => {
    requestAnimationFrame(renderFromFrame);
  });

  new MutationObserver(() => {
    if (!readerView.classList.contains("is-visible")) {
      shadow.replaceChildren();
    }
  }).observe(readerView, { attributes: true, attributeFilter: ["class"] });

  applyTheme(theme, { save: false });
}
