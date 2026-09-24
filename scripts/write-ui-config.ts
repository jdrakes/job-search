/**
 * The last step of `npm run build:ui`. Refuses to build without both
 * Supabase env vars (a page with an empty url fails silent and far from
 * here), vendors Vue from `node_modules` rather than a CDN (the page holds
 * a JWT), copies `ui/`'s own static files, and writes the config script tag
 * into `ui/dist/index.html`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STATUSES } from "../src/schema.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = join(ROOT, "ui");
const DIST_DIR = join(UI_DIR, "dist");

/**
 * Every file in `ui/` that index.html asks the browser for by name.
 *
 * Vercel serves `ui/dist` alone (`outputDirectory` in vercel.json), so a
 * file missing from this list 404s in production however present it is in
 * the repo. favicon.svg was linked from the page on 2026-09-16 and never
 * copied: the site ran seven days with no icon and nothing failed, because
 * a 404 on an icon is silent. `ui/tests/assets.test.ts` holds this list to
 * index.html's own references so the next one added cannot be forgotten.
 */
export const UI_ASSETS: readonly string[] = ["app.css", "favicon.svg", "apple-touch-icon.png"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`build:ui: ${name} is not set; refusing to build`);
    process.exit(1);
  }
  return value;
}

function build(): void {
  const url = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");

  mkdirSync(join(DIST_DIR, "vendor"), { recursive: true });
  copyFileSync(
    join(ROOT, "node_modules/vue/dist/vue.esm-browser.prod.js"),
    join(DIST_DIR, "vendor/vue.esm-browser.prod.js"),
  );
  for (const asset of UI_ASSETS) {
    copyFileSync(join(UI_DIR, asset), join(DIST_DIR, asset));
  }

  const config = JSON.stringify({ url, anonKey, statuses: [...STATUSES] });
  const html = readFileSync(join(UI_DIR, "index.html"), "utf8");
  const configured = html.replace(
    /<script type="application\/json" id="app-config">[^]*?<\/script>/,
    `<script type="application/json" id="app-config">\n      ${config}\n    </script>`,
  );
  if (configured === html) {
    console.error("build:ui: could not find the app-config script tag to write into");
    process.exit(1);
  }
  writeFileSync(join(DIST_DIR, "index.html"), configured);
}

// Importable by the test without building: only `node scripts/write-ui-config.ts` runs it.
if (import.meta.main) {
  build();
}
