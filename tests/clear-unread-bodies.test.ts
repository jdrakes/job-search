import assert from "node:assert/strict";
import { test } from "node:test";

import { clearUnreadBodies } from "../scripts/clear-unread-bodies.ts";
import type { Criteria, Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    id: 1,
    level_words: ["staff", "senior staff", "principal", "distinguished", "architect", "lead"],
    role_words: ["backend", "full stack", "platform"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: ["Wyoming"],
    missing_languages: ["cobol", "fortran", "delphi"],
    comp_floor: 120000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

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
    body: "This is a fully remote position open to candidates anywhere in the US.",
    kept: null,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: "deadbeef",
    workplace: null,
    ...overrides,
  };
}

// The same listing every field above satisfies today's rule for, dropped
// only by the criterion added per test: title carries "backend" (a role
// word), a comp figure above the floor, no excluded state, no missing
// language.
const EXCLUDES_SENIOR = criteria({ excluded_title_words: ["senior"] });

// Breaks if a listing-criterion "out" no longer clears the body.
test("clearUnreadBodies: an unread posting out on a listing criterion has its body cleared", async () => {
  const store = memoryStore({
    criteria: [EXCLUDES_SENIOR],
    postings: [posting({ key: "acme::1", company: "Acme" })],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 1, listingKept: 0, workplaceScored: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(row?.body, null);
  assert.equal(row?.body_hash, null);
});

test("clearUnreadBodies: a posting acted on keeps its body even when judged out", async () => {
  const store = memoryStore({
    criteria: [EXCLUDES_SENIOR],
    postings: [posting({ key: "acme::1", company: "Acme", status: "applied" })],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 0, listingKept: 0, workplaceScored: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(row?.body, "This is a fully remote position open to candidates anywhere in the US.");
  assert.equal(row?.body_hash, "deadbeef");
});

test("clearUnreadBodies: a posting the listing criteria still keep is left alone", async () => {
  const store = memoryStore({
    criteria: [criteria()],
    postings: [posting({ key: "acme::1", company: "Acme" })],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 0, listingKept: 1, workplaceScored: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(row?.body, "This is a fully remote position open to candidates anywhere in the US.");
  assert.equal(row?.body_hash, "deadbeef");
});

// Breaks if the backfill decides with the full `judge()`: the body would
// go on its text, and a later re-judge with no relist would judge the
// empty text back in.
test("clearUnreadBodies: a posting out only on a text criterion keeps its body", async () => {
  const store = memoryStore({
    criteria: [criteria()],
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        body: "5+ years of production Delphi required.",
      }),
    ],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 0, listingKept: 1, workplaceScored: 0 });
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(row?.body, "5+ years of production Delphi required.");
  assert.equal(row?.body_hash, "deadbeef");
});

// Breaks if the backfill clears a body `scripts/score-remote.ts` reads.
test("clearUnreadBodies: a judged-out posting whose board states remote keeps its body, counted apart", async () => {
  const store = memoryStore({
    criteria: [EXCLUDES_SENIOR],
    postings: [
      posting({ key: "acme::1", company: "Acme", workplace: "remote" }),
      posting({ key: "acme::2", company: "Acme" }),
    ],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 1, listingKept: 0, workplaceScored: 1 });
  const [scored] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(
    scored?.body,
    "This is a fully remote position open to candidates anywhere in the US.",
  );
  assert.equal(scored?.body_hash, "deadbeef");
  const [cleared] = await store.select<Posting>("postings", { key: "acme::2" });
  assert.equal(cleared?.body, null);
});

// Breaks if the backfill judges age against `judged_with` instead of now:
// a row judged long ago, before it aged past the max, would stay kept.
test("clearUnreadBodies: age is judged against the current time, not judged_with", async () => {
  const store = memoryStore({
    criteria: [criteria({ max_age_days: 30 })],
    postings: [
      posting({
        key: "acme::1",
        company: "Acme",
        posted_at: "2020-01-01T00:00:00.000Z",
        judged_with: "2020-01-02T00:00:00.000Z",
      }),
    ],
  });

  const result = await clearUnreadBodies(store);

  assert.deepEqual(result, { ok: true, cleared: 1, listingKept: 0, workplaceScored: 0 });
});

test("clearUnreadBodies: no criteria row refuses, naming the reason", async () => {
  const store = memoryStore({
    postings: [posting({ key: "acme::1", company: "Acme" })],
  });

  const result = await clearUnreadBodies(store);

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /no row with id 1/);
  const [row] = await store.select<Posting>("postings", { key: "acme::1" });
  assert.equal(row?.body, "This is a fully remote position open to candidates anywhere in the US.");
});
