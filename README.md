# Homeslop

A phone-first reader for unusually formatted AO3 works.

Homeslop preserves the author’s work HTML and CSS instead of flattening everything into generic ebook text. The first build includes:

- a retro Homestuck-adjacent mobile UI
- AO3 URL import through a same-site serverless endpoint
- local IndexedDB storage
- an offline-capable library shell
- isolated `iframe` rendering for imported work HTML

## Local preview

Open `index.html` through a local static server. The interface itself works without a build step.

## AO3 import endpoint

`functions/api/import.js` is written for Cloudflare Pages Functions. Deploy the repository as a Cloudflare Pages project to enable `/api/import`.

The importer currently saves the full-work HTML and inline workskin CSS. Downloading and rewriting every external image/font asset for complete offline fidelity is a later milestone.

## Privacy

Imported works are stored in the browser on your device. The serverless function only proxies the AO3 page requested by the user and does not keep a library or account database.
