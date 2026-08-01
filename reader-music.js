const MUSIC_LINK_ATTR = "data-homeslop-music-link";
const PLAYER_ID = "homeslop-music-player";
const PLAYER_STYLE_ID = "homeslop-music-player-style";

let shadowObserver = null;
let shellObserver = null;
let musicFrame = null;
let musicAudio = null;
let musicTitle = null;
let musicProvider = null;
let musicOpenLink = null;

function installPlayerStyles() {
  if (document.getElementById(PLAYER_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = PLAYER_STYLE_ID;
  style.textContent = `
    #${PLAYER_ID} {
      position: fixed;
      left: max(.7rem, env(safe-area-inset-left));
      right: max(.7rem, env(safe-area-inset-right));
      bottom: calc(.7rem + env(safe-area-inset-bottom));
      z-index: 10000;
      display: none;
      max-width: 42rem;
      margin-inline: auto;
      overflow: hidden;
      border: 2px solid #777;
      border-radius: 8px;
      background: #181818;
      color: #eee;
      box-shadow: 0 10px 35px rgba(0, 0, 0, .5);
      font-family: "Lucida Grande", "Lucida Sans Unicode", Verdana, Helvetica, Arial, sans-serif;
    }

    #${PLAYER_ID}[data-open="true"] { display: block; }

    #${PLAYER_ID} .homeslop-music-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: .55rem;
      align-items: center;
      padding: .55rem .65rem;
      border-bottom: 1px solid #444;
      background: #242424;
    }

    #${PLAYER_ID} .homeslop-music-copy { min-width: 0; }
    #${PLAYER_ID} .homeslop-music-title,
    #${PLAYER_ID} .homeslop-music-provider {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${PLAYER_ID} .homeslop-music-title {
      font-size: .92rem;
      font-weight: 700;
    }

    #${PLAYER_ID} .homeslop-music-provider {
      margin-top: .12rem;
      color: #aaa;
      font-size: .72rem;
      text-transform: uppercase;
      letter-spacing: .08em;
    }

    #${PLAYER_ID} .homeslop-music-open,
    #${PLAYER_ID} .homeslop-music-close {
      display: inline-grid;
      place-items: center;
      min-width: 2.5rem;
      min-height: 2.35rem;
      padding: .3rem .55rem;
      border: 1px solid #666;
      border-radius: 4px;
      color: #eee;
      background: #303030;
      font: inherit;
      font-size: .78rem;
      font-weight: 700;
      text-decoration: none;
    }

    #${PLAYER_ID} .homeslop-music-close { font-size: 1.05rem; }

    #${PLAYER_ID} .homeslop-music-body {
      min-height: 0;
      background: #111;
    }

    #${PLAYER_ID} iframe {
      display: block;
      width: 100%;
      height: 152px;
      border: 0;
      background: #111;
    }

    #${PLAYER_ID} audio {
      display: block;
      width: calc(100% - 1rem);
      margin: .5rem;
    }

    @media (max-width: 520px) {
      #${PLAYER_ID} iframe { height: 152px; }
      #${PLAYER_ID} .homeslop-music-open { font-size: 0; }
      #${PLAYER_ID} .homeslop-music-open::after { content: "↗"; font-size: 1rem; }
    }
  `;
  document.head.append(style);
}

function ensurePlayer() {
  let player = document.getElementById(PLAYER_ID);
  if (player) return player;

  installPlayerStyles();
  player = document.createElement("aside");
  player.id = PLAYER_ID;
  player.dataset.open = "false";
  player.setAttribute("aria-label", "Music player");

  const head = document.createElement("div");
  head.className = "homeslop-music-head";

  const copy = document.createElement("div");
  copy.className = "homeslop-music-copy";
  musicTitle = document.createElement("strong");
  musicTitle.className = "homeslop-music-title";
  musicProvider = document.createElement("span");
  musicProvider.className = "homeslop-music-provider";
  copy.append(musicTitle, musicProvider);

  musicOpenLink = document.createElement("a");
  musicOpenLink.className = "homeslop-music-open";
  musicOpenLink.target = "_blank";
  musicOpenLink.rel = "noopener noreferrer";
  musicOpenLink.textContent = "OPEN";

  const closeButton = document.createElement("button");
  closeButton.className = "homeslop-music-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close music player");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closePlayer);

  const body = document.createElement("div");
  body.className = "homeslop-music-body";

  musicFrame = document.createElement("iframe");
  musicFrame.title = "Embedded music player";
  musicFrame.allow = "autoplay; encrypted-media; picture-in-picture";
  musicFrame.referrerPolicy = "strict-origin-when-cross-origin";
  musicFrame.loading = "eager";

  musicAudio = document.createElement("audio");
  musicAudio.controls = true;
  musicAudio.preload = "metadata";

  body.append(musicFrame, musicAudio);
  head.append(copy, musicOpenLink, closeButton);
  player.append(head, body);
  document.body.append(player);
  return player;
}

function closePlayer() {
  const player = document.getElementById(PLAYER_ID);
  if (!player) return;
  player.dataset.open = "false";
  musicFrame?.removeAttribute("src");
  if (musicAudio) {
    musicAudio.pause();
    musicAudio.removeAttribute("src");
    musicAudio.load();
  }
}

function youtubeId(url) {
  if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const parts = url.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || null;
  return null;
}

function classifyMusicUrl(rawHref) {
  let url;
  try {
    url = new URL(rawHref, window.location.href);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol)) return null;

  const videoId = youtubeId(url);
  if (videoId && /^[\w-]{6,20}$/.test(videoId)) {
    return {
      provider: "YouTube",
      sourceUrl: url.href,
      type: "iframe",
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1`,
    };
  }

  if (url.hostname === "open.spotify.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const offset = parts[0]?.startsWith("intl-") ? 1 : 0;
    const kind = parts[offset];
    const id = parts[offset + 1];
    if (["track", "album", "playlist", "episode", "show"].includes(kind) && id) {
      return {
        provider: "Spotify",
        sourceUrl: url.href,
        type: "iframe",
        embedUrl: `https://open.spotify.com/embed/${kind}/${encodeURIComponent(id)}?utm_source=generator&theme=0`,
      };
    }
  }

  if (url.hostname === "music.apple.com") {
    return {
      provider: "Apple Music",
      sourceUrl: url.href,
      type: "iframe",
      embedUrl: url.href.replace("https://music.apple.com", "https://embed.music.apple.com"),
    };
  }

  if (/(^|\.)soundcloud\.com$/.test(url.hostname)) {
    return {
      provider: "SoundCloud",
      sourceUrl: url.href,
      type: "iframe",
      embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}&auto_play=true&hide_related=true&show_comments=false`,
    };
  }

  if (/\.(?:mp3|m4a|aac|ogg|oga|wav)(?:$|[?#])/i.test(url.href)) {
    return {
      provider: "Audio",
      sourceUrl: url.href,
      type: "audio",
      embedUrl: url.href,
    };
  }

  return null;
}

function openPlayer(info, label) {
  const player = ensurePlayer();
  musicTitle.textContent = label || "Linked song";
  musicProvider.textContent = info.provider;
  musicOpenLink.href = info.sourceUrl;

  if (info.type === "audio") {
    musicFrame.hidden = true;
    musicFrame.removeAttribute("src");
    musicAudio.hidden = false;
    musicAudio.src = info.embedUrl;
    musicAudio.play().catch(() => {});
  } else {
    musicAudio.hidden = true;
    musicAudio.pause();
    musicAudio.removeAttribute("src");
    musicFrame.hidden = false;
    musicFrame.src = info.embedUrl;
  }

  player.dataset.open = "true";
}

function installShadowStyle(shadow) {
  if (shadow.querySelector("#homeslop-music-link-style")) return;
  const style = document.createElement("style");
  style.id = "homeslop-music-link-style";
  style.textContent = `
    .homeslop-music-button {
      display: inline-grid;
      place-items: center;
      min-width: 1.8em;
      min-height: 1.8em;
      margin-left: .35em;
      padding: 0 .35em;
      vertical-align: .08em;
      border: 1px solid currentColor;
      border-radius: 999px;
      color: inherit;
      background: color-mix(in srgb, currentColor 10%, transparent);
      font: inherit;
      font-size: .82em;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
    }

    .homeslop-music-button:focus-visible {
      outline: 2px solid #f7b500;
      outline-offset: 2px;
    }
  `;
  shadow.append(style);
}

function decorateMusicLinks() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  const workskin = shadow?.querySelector("#workskin");
  if (!shadow || !workskin) return;

  installShadowStyle(shadow);
  workskin.querySelectorAll(`a[href]:not([${MUSIC_LINK_ATTR}])`).forEach((link) => {
    const rawHref = link.getAttribute("href") || link.href;
    const info = classifyMusicUrl(rawHref);
    link.setAttribute(MUSIC_LINK_ATTR, info ? "playable" : "checked");
    if (!info) return;

    const button = document.createElement("button");
    button.className = "homeslop-music-button";
    button.type = "button";
    button.textContent = "♪";
    button.title = `Play with ${info.provider}`;
    button.setAttribute("aria-label", `Play ${link.textContent.trim() || "linked song"} with ${info.provider}`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPlayer(info, link.textContent.trim());
    });
    link.after(button);
  });
}

function connectMusicObserver() {
  const shadow = document.querySelector("#reader-shadow")?.shadowRoot;
  if (!shadow) return false;

  shadowObserver?.disconnect();
  shadowObserver = new MutationObserver(decorateMusicLinks);
  shadowObserver.observe(shadow, { childList: true, subtree: true });
  decorateMusicLinks();
  return true;
}

function connectWhenReady() {
  if (connectMusicObserver()) {
    shellObserver?.disconnect();
    shellObserver = null;
    return;
  }

  if (shellObserver) return;
  shellObserver = new MutationObserver(connectWhenReady);
  shellObserver.observe(document.body, { childList: true, subtree: true });
}

connectWhenReady();

document.querySelector("#reader-back")?.addEventListener("click", closePlayer);
document.querySelector("#reader-delete")?.addEventListener("click", closePlayer);
