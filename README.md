# Homeslop

A phone-first reader for unusually formatted AO3 works.

Homeslop preserves the author’s work HTML and CSS instead of flattening everything into generic ebook text. The current build includes:

- a retro Homestuck-adjacent mobile UI
- AO3 URL import through a separate Vercel bridge
- local IndexedDB storage
- an offline-capable library shell
- isolated `iframe` rendering for imported work HTML

## Hosting layout

Homeslop itself runs on Cloudflare Workers at:

`https://homeslop.insane-but-smart.workers.dev`

AO3 imports are fetched by a separate Vercel function so the request does not use Cloudflare’s broken AO3 route:

`https://homeslop-importer-killthelightsandputonashow.vercel.app/api/import`

The Cloudflare endpoint at `/api/import` relays requests to that Vercel function. Imported works remain stored only in the browser on the reader’s device.

## Deploy the Vercel importer

1. Create a new Vercel project from `killthelightsandputonashow/homeslop`.
2. Name the project exactly `homeslop-importer-killthelightsandputonashow`.
3. Keep the root directory as the repository root.
4. Leave the framework preset as `Other` or `None`.
5. Leave build and output settings at their defaults.
6. Deploy.

Vercel automatically exposes `api/import.js` as `/api/import`.

## Cloudflare deployment

Cloudflare uses `wrangler.jsonc`, `worker.js`, and `functions/api/import.js`. Its relay defaults to the Vercel URL above. The upstream can also be overridden with a Cloudflare environment variable named `UPSTREAM_IMPORTER_URL`.

## Offline status

The application shell and imported work HTML are local. External images and fonts may still require internet until the asset-downloader milestone is finished.

## Privacy

Imported works are stored in the browser on your device. Neither the Cloudflare relay nor the Vercel importer keeps a library or account database.
