import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const files = [
  "index.html",
  "styles.css",
  "visibility-fix.css",
  "app.js",
  "reader-shadow.js",
  "reader-mobile-layout.js",
  "reader-prose-spacing.js",
  "reader-fallback-format.js",
  "reader-state.js",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg",
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  await copyFile(join(root, file), join(dist, file));
}

console.log(`Built Homeslop into ${dist}`);
