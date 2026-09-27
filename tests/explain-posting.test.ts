import assert from "node:assert/strict";
import { test } from "node:test";

import { explainPosting } from "../scripts/explain-posting.ts";
import { fullJudgment } from "../src/judge/judge.ts";
import { boardIndex } from "../src/judge/listing.ts";
import type { Company, Criteria, Posting } from "../src/schema.ts";
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
    title: "Staff Backend Engineer",
    url: null,
    location: null,
    comp_low: null,
    comp_high: 250_000,
    posted_at: null,
    first_seen: "2020-01-01T00:00:00.000Z",
    // Matches the fixture company's board `last_read` below, so the `gone`
    // criterion reads "in": a `last_seen` before the last read would read
    // this posting as dropped from a board that has since been checked.
    last_seen: "2026-09-16T06:00:00.000Z",
    live: null,
    body: "This is a fully remote position.",
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

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "watched",
    boards: [{ platform: "greenhouse", id: "board", last_read: "2026-09-16T06:00:00.000Z" }],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00.000Z",
    last_seen: "2026-09-15T00:00:00.000Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

test("explainPosting: returns the same Reason[] a direct fullJudgment call reaches", async () => {
  const row = posting({ key: "acme::1", company: "Acme" });
  const testCriteria = criteria();
  const testCompany = company("Acme");
  const store = memoryStore({
    postings: [row],
    criteria: [testCriteria],
    companies: [testCompany],
  });

  const result = await explainPosting(store, "acme::1");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const boards = boardIndex([testCompany]);
  const direct = fullJudgment(row, testCriteria, undefined, boards);
  // `fullJudgment` also takes `representativeByKey`, computed by
  // `explainPosting` from every posting in the store; with one posting on
  // file it maps this row to itself, which does not change the verdict
  // here (no duplicate criterion is exercised by this fixture), so a
  // direct call with no representative map reaches the same reasons.
  assert.deepEqual(
    result.reasons.map((reason) => reason.criterion),
    direct.reasons.map((reason) => reason.criterion),
  );
  assert.deepEqual(result.reasons, direct.reasons);
  assert.equal(result.kept, direct.kept);
});

test("explainPosting: a kept posting reports kept: true and its full reasons", async () => {
  const row = posting({ key: "acme::1", company: "Acme" });
  const testCriteria = criteria();
  const testCompany = company("Acme");
  const store = memoryStore({
    postings: [row],
    criteria: [testCriteria],
    companies: [testCompany],
  });

  const result = await explainPosting(store, "acme::1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.kept, true);
  assert.ok(result.reasons.length > 0);
  assert.ok(result.reasons.every((reason) => reason.verdict === "in"));
});

test("explainPosting: a key not on file is a clear refusal, not a throw", async () => {
  const store = memoryStore({
    criteria: [criteria()],
  });

  const result = await explainPosting(store, "nobody::1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /nobody::1/);
});

test("explainPosting: no criteria row is a clear refusal", async () => {
  const row = posting({ key: "acme::1", company: "Acme" });
  const store = memoryStore({
    postings: [row],
  });

  const result = await explainPosting(store, "acme::1");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /criteria/);
});
