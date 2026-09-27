import assert from "node:assert/strict";
import { test } from "node:test";

import { shrinkReasons } from "../scripts/shrink-reasons.ts";
import type { Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

function posting(overrides: Partial<Posting> & Pick<Posting, "key" | "company">): Posting {
  return {
    platform: "greenhouse",
    board: "board",
    title: "Senior Backend Engineer",
    url: null,
    location: null,
    comp_low: null,
    comp_high: 250_000,
    posted_at: null,
    first_seen: "2020-01-01T00:00:00.000Z",
    last_seen: "2020-01-01T00:00:00.000Z",
    live: null,
    body: null,
    kept: null,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    ...overrides,
  };
}

const OLD_REASONS = [
  { criterion: "role", verdict: "in", detail: "title matches a role word" },
  { criterion: "comp", verdict: "out", detail: "comp_high below the floor" },
  { criterion: "level", verdict: "out", detail: "title carries no level word" },
];

// Breaks if the script does not trim an old-shape row's reasons to just the
// out criteria's names, in the order fullJudgment produced them.
test("shrinkReasons: an old-shape row not kept or acted on converts to out criteria only, evidence emptied", async () => {
  const store = memoryStore({
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        kept: false,
        status: null,
        reasons: OLD_REASONS,
        evidence: {
          role: "title matches a role word",
          comp: "comp_high below the floor",
          level: "title carries no level word",
        },
      }),
    ],
  });

  const result = await shrinkReasons(store);

  assert.deepEqual(result, { converted: 1 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.deepEqual(row?.reasons, ["comp", "level"]);
  assert.deepEqual(row?.evidence, {});
});

// Breaks if the script clears evidence for a posting James acted on, which
// judge()'s own "kept || acted" rule would have kept.
test("shrinkReasons: an old-shape row acted on keeps its existing evidence", async () => {
  const evidence = {
    role: "title matches a role word",
    comp: "comp_high below the floor",
    level: "title carries no level word",
  };
  const store = memoryStore({
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        kept: false,
        status: "applied",
        reasons: OLD_REASONS,
        evidence,
      }),
    ],
  });

  const result = await shrinkReasons(store);

  assert.deepEqual(result, { converted: 1 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.deepEqual(row?.reasons, ["comp", "level"]);
  assert.deepEqual(row?.evidence, evidence);
});

// Breaks if the script re-touches a row already in the new shape (a
// string[]), which the first-element type check is supposed to skip.
test("shrinkReasons: a row already in the new shape is left alone", async () => {
  const store = memoryStore({
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        kept: false,
        status: null,
        reasons: ["comp", "level"],
        evidence: {},
      }),
    ],
  });

  const result = await shrinkReasons(store);

  assert.deepEqual(result, { converted: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.deepEqual(row?.reasons, ["comp", "level"]);
});

// Breaks if the script mishandles a row whose reasons array is empty (a
// kept posting under either shape): `isOldShape` must not treat an empty
// array as old-shape and touch it.
test("shrinkReasons: a row with an empty reasons array is left alone", async () => {
  const store = memoryStore({
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        kept: true,
        status: null,
        reasons: [],
        evidence: { role: "title matches a role word" },
      }),
    ],
  });

  const result = await shrinkReasons(store);

  assert.deepEqual(result, { converted: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.deepEqual(row?.evidence, { role: "title matches a role word" });
});
