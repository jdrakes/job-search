import assert from "node:assert/strict";
import { test } from "node:test";
import { getJson } from "../src/net/http.ts";
import { phase } from "../src/phase.ts";
import { postgresStore } from "../src/store/postgres.ts";

const okJson: typeof fetch = async () =>
  new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
const noSleep = async () => {};

// http.ts requires a configured User-Agent now that it no longer carries a
// built-in one (src/net/http.ts); this test fakes the network entirely, so
// any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

test("phase reports its wall clock, its http and store requests, and each host it touched", async () => {
  const lines: string[] = [];
  const store = postgresStore({
    url: "postgres://never-dialled",
    queryImpl: async () => ({ rows: [], rowCount: 0 }),
  });

  const value = await phase(
    "sample",
    async () => {
      await getJson("http://phase-a.test/1", {
        fetchImpl: okJson,
        sleep: noSleep,
        userAgent: TEST_USER_AGENT,
      });
      await getJson("http://phase-a.test/2", {
        fetchImpl: okJson,
        sleep: noSleep,
        userAgent: TEST_USER_AGENT,
      });
      await getJson("http://phase-b.test/1", {
        fetchImpl: okJson,
        sleep: noSleep,
        userAgent: TEST_USER_AGENT,
      });
      await store.select("postings");
      return 7;
    },
    (line) => lines.push(line),
  );

  assert.equal(value, 7);
  assert.match(
    lines[0] ?? "",
    /^phase sample: \d+\.\d s wall; http 3 requests \d+\.\d s; store 1 requests \d+\.\d s$/,
  );
  const hosts = lines.slice(1).map((line) => line.trim());
  assert.equal(hosts.length, 2);
  assert.ok(
    hosts.some((line) => /^phase-a\.test: 2 requests \d+\.\d s$/.test(line)),
    hosts.join("|"),
  );
  assert.ok(
    hosts.some((line) => /^phase-b\.test: 1 requests \d+\.\d s$/.test(line)),
    hosts.join("|"),
  );
});

test("phase reports a phase that throws, then rethrows", async () => {
  const lines: string[] = [];
  await assert.rejects(
    phase(
      "broken",
      async () => {
        throw new Error("boom");
      },
      (line) => lines.push(line),
    ),
    /boom/,
  );
  assert.match(
    lines[0] ?? "",
    /^phase broken: \d+\.\d s wall; http 0 requests 0\.0 s; store 0 requests 0\.0 s$/,
  );
  assert.equal(lines.length, 1);
});
