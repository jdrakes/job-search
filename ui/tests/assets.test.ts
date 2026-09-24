import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { UI_ASSETS } from "../../scripts/write-ui-config.ts";

const UI = join(import.meta.dirname, "..");

/**
 * The two paths index.html asks for that the build emits rather than copies
 * out of `ui/`: Vue is vendored by its own copyFileSync, and `ui/src/app.js`
 * is what tsc compiles `ui/src/app.ts` into.
 */
const BUILT = ["./vendor/", "./ui/src/"];

function referencedByThePage(): string[] {
  const html = readFileSync(join(UI, "index.html"), "utf8");
  return [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * The bug this exists for: favicon.svg was linked from index.html on
 * 2026-09-16 and never added to the copy list, so `/favicon.svg` 404'd in
 * production for seven days. A missing icon fails silently — nothing
 * throws, no test went red, the page just had no icon.
 */
test("every local file index.html asks for is one the build puts in dist", () => {
  const unshipped = referencedByThePage().filter(
    (path) =>
      !BUILT.some((prefix) => path.startsWith(prefix)) && !UI_ASSETS.includes(path.slice(2)),
  );
  assert.deepEqual(unshipped, []);
});

test("every asset the build copies is really in ui/", () => {
  const absent = UI_ASSETS.filter((asset) => !existsSync(join(UI, asset)));
  assert.deepEqual(absent, []);
});
