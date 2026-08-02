const MUSIC_SCAN_ATTR = "data-homeslop-music-scan";
const MUSIC_MAP_KEY = "homeslop-music-mappings-v1";
const RESOLVER_ID = "homeslop-song-resolver";

let detectorObserver = null;
let detectorShellObserver = null;
let detectorFrame = 0;
let activeMention = null;

function loadMusicMappings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MUSIC_MAP_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const musicMappings = loadMusicMappings();

function saveMusicMappings() {
  try {
    localStorage.setItem(MUSIC_MAP_KEY, JSON.stringify(musicMappings));
  } catch (error) {
    console.warn("Homeslop could not save music mappings", error);
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cleanPart(value) {
  return normalizeText(value)
    .replace(/^[♪♫♬\s]+/, "")
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

function splitSongArtist(value) {
  const text = cleanPart(value);
  const by = text.match(/^(.{2,100}?)\s+by\s+(.{2,80})$/i);
  if (by) return { title: cleanPart(by[1]), artist: cleanPart(by[2]) };

  const dash = text.match(/^(.{2,100}?)\s+[–—-]\s+(.{2,80})$/);
  if (dash) return { title: cleanPart(dash[1]), artist: cleanPart(dash[2]) };

  return { title: text, artist: "" };
}

function detectMention(textValue) {
  const text = normalizeText(textValue);
  if (text.length < 3 || text.length > 240) return null;

  const quoted = text.match(/["“]([^"”]{2,100})["”]\s+by\s+([^,;.!?]{2,80})/i);
  if (quoted) {
    return { title: cleanPart(quoted[1]), artist: cleanPart(quoted[2]), confidence: "high" };
  }

  const label = text.match(
    /^(?:now playing|currently playing|listening to|listen to|song|music|soundtrack)\s*[:：–—-]\s*(.+)$/i,
  );
  if (label) {
    const parts = splitSongArtist(label[1]);
    return { ...parts, confidence: parts.artist ? "high" : "medium" };
  }

  const musical = text.match(/^[♪♫♬]\s*(.+)$/);
  if (musical) {
    const parts = splitSongArtist(musical[1]);
    return { ...parts, confidence: parts.artist ? "high" : "medium" };
  }

  const wholeBy = text.match(/^([A-Z0-9][^\n]{1,100}?)\s+by\s+([A-Z0-9][^\n,;.!?]{1,80})$/i);
  if (wholeBy && !/[.!?]\s/.test(text)) {
    return { title: cleanPart(wholeBy[1]), artist: cleanPart(wholeBy[2]), confidence: "high" };
  }

  const wholeDash = text.match(/^([^:\n]{2,100}?)\s+[–—-]\s+([^:\n]{2,80})$/);
  if (wholeDash && text.length <= 150 && !/[.!?]\s/.test(text)) {
    return { title: cleanPart(wholeDash[1]), artist: cleanPart(wholeDash[2]), confidence: "medium" };
  }

  return null;
}

function mappingKey(mention) {
  return `${mention.title.toLowerCase()}|${(mention.artist || "").toLowerCase()}`;
}

function searchQuery(mention) {
  return [mention.title, mention.artist].filter(Boolean).join(" ");
}

function ensureDetectorStyles(shadow) {
  if (!shadow.querySelector("#homeslop-song-detector-style")) {
    const style = document.createElement("style");
    style.id = "homeslop-song-detector-style";
    style.textContent = `
      .homeslop-song-detect-button {
        display: inline-grid;
        place-items: center;
        min-width: 1.8em;
        min-height: 1.8em;
        margin-left: .35em;
        padding: 0 .38em;
        vertical-align: .08em;
        border: 1px dashed currentColor;
        border-radius: 999px;
        color: inherit;
        background: color-mix(in srgb, currentColor 8%, transparent);
        font: inherit;
        font-size: .82em;
        font-weight: 700;
        line-height: 1;
      }
      .homeslop-song-detect-button[data-linked="true"] { border-style: solid; }
      .homeslop-song-hidden-link {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
        clip: rect(0 0 0 0) !important;
        white-space: nowrap !important;
      }
    `;
    shadow.append(style);
  }
}

function installResolverStyles() {
  if (document.querySelector("#homeslop-song-resolver-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-song-resolver-style";
  style.textContent = `
    #${RESOLVER_ID} {
      position: fixed;
      inset: auto max(.6rem, env(safe-area-inset-right)) calc(.6rem + env(safe-area-inset-bottom)) max(.6rem, env(safe-area-inset-left));
      z-index: 10020;
      display: none;
      max-width: 38rem;
      margin-inline: auto;
      padding: .85rem;
      border: 2px solid #777;
      border-radius: 8px;
      color: #eee;
      background: #181818;
      box-shadow: 0 14px 40px rgba(0,0,0,.6);
      font-family: "Lucida Grande", Verdana, sans-serif;
    }
    #${RESOLVER_ID}[data-open="true"] { display: block; }
    #${RESOLVER_ID} h2 { margin: 0 2rem .2rem 0; font-size: 1rem; }
    #${RESOLVER_ID} p { margin: .15rem 0 .7rem; color: #aaa; font-size: .8rem; }
    #${RESOLVER_ID} .resolver-close {
      position: absolute; top: .45rem; right: .45rem; width: 2rem; height: 2rem;
      border: 1px solid #666; border-radius: 4px; color: #eee; background: #303030;
    }
    #${RESOLVER_ID} .resolver-searches { display: grid; grid-template-columns: repeat(3, 1fr); gap: .4rem; margin-bottom: .7rem; }
    #${RESOLVER_ID} a, #${RESOLVER_ID} button { font: inherit; }
    #${RESOLVER_ID} .resolver-searches a,
    #${RESOLVER_ID} .resolver-save {
      display: grid; place-items: center; min-height: 2.4rem; padding: .4rem;
      border: 1px solid #666; border-radius: 4px; color: #eee; background: #303030;
      text-decoration: none; font-size: .72rem; font-weight: 700; text-align: center;
    }
    #${RESOLVER_ID} label { display: block; margin-bottom: .3rem; color: #ccc; font-size: .72rem; font-weight: 700; }
    #${RESOLVER_ID} input {
      width: 100%; min-height: 2.6rem; padding: .5rem .6rem; box-sizing: border-box;
      border: 1px solid #666; border-radius: 4px; color: #eee; background: #0f0f0f; font: inherit;
    }
    #${RESOLVER_ID} .resolver-save { width: 100%; margin-top: .45rem; background: #574800; border-color: #b99800; }
    #${RESOLVER_ID} .resolver-error { min-height: 1em; color: #ff9bac; }
  `;
  document.head.append(style);
}

function closeResolver() {
  const resolver = document.getElementById(RESOLVER_ID);
  if (resolver) resolver.dataset.open = "false";
  activeMention = null;
}

function ensureResolver() {
  let resolver = document.getElementById(RESOLVER_ID);
  if (resolver) return resolver;

  installResolverStyles();
  resolver = document.createElement("aside");
  resolver.id = RESOLVER_ID;
  resolver.dataset.open = "false";
  resolver.innerHTML = `
    <button class="resolver-close" type="button" aria-label="Close">×</button>
    <h2></h2>
    <p class="resolver-artist"></p>
    <div class="resolver-searches">
      <a data-search="youtube" target="_blank" rel="noopener noreferrer">YOUTUBE</a>
      <a data-search="spotify" target="_blank" rel="noopener noreferrer">SPOTIFY</a>
      <a data-search="apple" target="_blank" rel="noopener noreferrer">APPLE MUSIC</a>
    </div>
    <label for="homeslop-song-url">Paste the exact song link here to save it</label>
    <input id="homeslop-song-url" type="url" inputmode="url" placeholder="https://youtu.be/..." autocomplete="off">
    <button class="resolver-save" type="button">SAVE + ADD PLAY BUTTON</button>
    <p class="resolver-error" aria-live="polite"></p>
  `;
  document.body.append(resolver);

  resolver.querySelector(".resolver-close").addEventListener("click", closeResolver);
  resolver.querySelector(".resolver-save").addEventListener("click", () => {
    if (!activeMention) return;
    const input = resolver.querySelector("input");
    const error = resolver.querySelector(".resolver-error");
    let url;
    try {
      url = new URL(input.value.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      error.textContent = "Paste a complete YouTube, Spotify, Apple Music, SoundCloud, Bandcamp, or audio URL.";
      return;
    }

    musicMappings[mappingKey(activeMention.mention)] = url.href;
    saveMusicMappings();
    attachMappedLink(activeMention.element, activeMention.mention, url.href);
    closeResolver();
  });

  return resolver;
}

function openResolver(element, mention) {
  const resolver = ensureResolver();
  activeMention = { element, mention };
  resolver.querySelector("h2").textContent = mention.title;
  resolver.querySelector(".resolver-artist").textContent = mention.artist || "Artist not specified";
  resolver.querySelector("input").value = musicMappings[mappingKey(mention)] || "";
  resolver.querySelector(".resolver-error").textContent = "";

  const query = encodeURIComponent(searchQuery(mention));
  resolver.querySelector('[data-search="youtube"]').href = `https://www.youtube.com/results?search_query=${query}`;
  resolver.querySelector('[data-search="spotify"]').href = `https://open.spotify.com/search/${query}`;
  resolver.querySelector('[data-search="apple"]').href = `https://music.apple.com/us/search?term=${query}`;
  resolver.dataset.open = "true";
}

function attachMappedLink(element, mention, url) {
  const oldButton = element.nextElementSibling?.classList?.contains("homeslop-song-detect-button")
    ? element.nextElementSibling
    : null;
  oldButton?.remove();

  const existing = element.parentElement?.querySelector(
    `.homeslop-song-hidden-link[data-song-key="${CSS.escape(mappingKey(mention))}"]`,
  );
  if (existing) return;

  const link = document.createElement("a");
  link.className = "homeslop-song-hidden-link";
  link.href = url;
  link.textContent = `${mention.title}${mention.artist ? ` by ${mention.artist}` : ""}`;
  link.dataset.songKey = mappingKey(mention);
  element.after(link);
}

function decorateSongMentions() {
  detectorFrame = 0;
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  ensureDetectorStyles(shadow);
  const selector = "p, li, h2, h3, h4, figcaption, blockquote";
  workskin.querySelectorAll(`${selector}:not([${MUSIC_SCAN_ATTR}])`).forEach((element) => {
    element.setAttribute(MUSIC_SCAN_ATTR, "checked");
    if (element.closest("pre, code, [data-homeslop-fallback-log]")) return;
    if (element.querySelector("a[href]")) return;

    const mention = detectMention(element.textContent);
    if (!mention?.title) return;
    element.setAttribute(MUSIC_SCAN_ATTR, mention.confidence);

    const saved = musicMappings[mappingKey(mention)];
    if (saved) {
      attachMappedLink(element, mention, saved);
      return;
    }

    const button = document.createElement("button");
    button.className = "homeslop-song-detect-button";
    button.type = "button";
    button.textContent = "♪?";
    button.title = `Find ${mention.title}`;
    button.setAttribute("aria-label", `Find song ${mention.title}${mention.artist ? ` by ${mention.artist}` : ""}`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openResolver(element, mention);
    });
    element.after(button);
  });
}

function scheduleSongDetection() {
  if (detectorFrame) cancelAnimationFrame(detectorFrame);
  detectorFrame = requestAnimationFrame(decorateSongMentions);
}

function connectDetector() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  detectorObserver?.disconnect();
  detectorObserver = new MutationObserver(scheduleSongDetection);
  detectorObserver.observe(shadow, { childList: true, subtree: true });
  scheduleSongDetection();
  return true;
}

function connectDetectorWhenReady() {
  if (connectDetector()) {
    detectorShellObserver?.disconnect();
    detectorShellObserver = null;
    return;
  }

  if (detectorShellObserver) return;
  detectorShellObserver = new MutationObserver(connectDetectorWhenReady);
  detectorShellObserver.observe(document.body, { childList: true, subtree: true });
}

connectDetectorWhenReady();
document.querySelector("#reader-back")?.addEventListener("click", closeResolver);
