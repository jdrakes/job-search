import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadSettings } from "../src/settings.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "job-search-settings-"));
}

test("loadSettings: a missing config.json returns an empty settings object", () => {
  const dir = tempDir();
  assert.deepEqual(loadSettings(dir), {});
});

test("loadSettings: a valid config.json returns its parsed values", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      userAgent: "my-bot (+https://example.com)",
      discoverySources: ["hackernews", "weworkremotely"],
      extraSourcePath: "./sources/mine.ts",
    }),
  );

  assert.deepEqual(loadSettings(dir), {
    userAgent: "my-bot (+https://example.com)",
    discoverySources: ["hackernews", "weworkremotely"],
    extraSourcePath: "./sources/mine.ts",
  });
});

test("loadSettings: a config.json naming only one field leaves the others absent", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ userAgent: "solo-bot" }));

  const settings = loadSettings(dir);
  assert.equal(settings.userAgent, "solo-bot");
  assert.equal("discoverySources" in settings, false);
  assert.equal("extraSourcePath" in settings, false);
});

test("loadSettings: an unknown key is ignored rather than rejected", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ userAgent: "solo-bot", futureField: "some-newer-value" }),
  );

  assert.deepEqual(loadSettings(dir), { userAgent: "solo-bot" });
});

test("loadSettings: unparsable JSON throws naming the path", () => {
  const dir = tempDir();
  const path = join(dir, "config.json");
  writeFileSync(path, "{ not valid json");

  assert.throws(
    () => loadSettings(dir),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path));
      return true;
    },
  );
});

test("loadSettings: a config.json that is not a JSON object throws naming the path", () => {
  const dir = tempDir();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(["not", "an", "object"]));

  assert.throws(
    () => loadSettings(dir),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path));
      return true;
    },
  );
});

test("loadSettings: a userAgent of the wrong type throws naming the field", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ userAgent: 12345 }));

  assert.throws(() => loadSettings(dir), /userAgent/);
});

test("loadSettings: a discoverySources entry of the wrong type throws naming the field", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ discoverySources: ["hackernews", 7] }));

  assert.throws(() => loadSettings(dir), /discoverySources/);
});
