import assert from "node:assert/strict";
import { test } from "node:test";

import { copyToHosted } from "../scripts/copy-to-hosted.ts";
import type { Candidate, Company, Criteria, Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

function posting(overrides: Partial<Posting> & Pick<Posting, "key">): Posting {
  return {
    company: "Acme",
    platform: "greenhouse",
    board: "acme",
    title: "Staff Backend Engineer",
    url: null,
    location: null,
    locations: [],
    comp_low: null,
    comp_high: 250_000,
    posted_at: null,
    first_seen: "2026-09-01T00:00:00.000Z",
    body: "Fully remote in the US.",
    kept: true,
    reasons: [],
    evidence: {},
    judged_with: "2026-09-20T00:00:00.000Z",
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    gone_at: null,
    ...overrides,
  };
}

function company(overrides: Partial<Company> & Pick<Company, "name">): Company {
  return { boards: [], reason: null, dropped_at: null, peers_searched_at: null, ...overrides };
}

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "id">): Candidate {
  return {
    name: "Acme",
    url: null,
    origin: "james",
    evidence: null,
    added_at: "2026-09-20T00:00:00.000Z",
    outcome: null,
    outcome_at: null,
    company: null,
    ...overrides,
  };
}

const CRITERIA = { id: 1, comp_floor: 200_000 } as unknown as Criteria;

// Breaks if a posting the hosted store already has gets its status columns
// from the local copy: those are James's, written in the list.
test("copyToHosted: a posting both stores hold keeps the hosted store's decision and takes the local rest", async () => {
  const local = memoryStore({
    postings: [
      posting({
        key: "p1",
        title: "Staff Backend Engineer, revised",
        body: "local body",
        status: null,
        note: null,
      }),
    ],
  });
  const hosted = memoryStore({
    postings: [
      posting({
        key: "p1",
        body: null,
        status: "applied",
        status_at: "2026-09-25",
        applied_at: "2026-09-25",
        note: "sent",
      }),
    ],
  });

  await copyToHosted(local, hosted);

  const [row] = await hosted.select<Posting>("postings", { key: "p1" });
  assert.equal(row?.status, "applied");
  assert.equal(row?.status_at, "2026-09-25");
  assert.equal(row?.applied_at, "2026-09-25");
  assert.equal(row?.note, "sent");
  assert.equal(row?.title, "Staff Backend Engineer, revised");
  assert.equal(row?.body, "local body");
});

// Breaks if a posting only the local store holds loses anything on the way.
test("copyToHosted: a posting the hosted store lacks is copied whole, body included", async () => {
  const local = memoryStore({
    postings: [posting({ key: "p2", kept: false, reasons: ["level"], body: "the text" })],
  });
  const hosted = memoryStore({ postings: [] });

  const summary = await copyToHosted(local, hosted);

  assert.equal(summary.postings, 1);
  const [row] = await hosted.select<Posting>("postings", { key: "p2" });
  assert.equal(row?.body, "the text");
  assert.equal(row?.kept, false);
  assert.deepEqual(row?.reasons, ["level"]);
});

// Breaks if a company's drop or its reason is copied: both are James's.
test("copyToHosted: a company takes the local boards and keeps the hosted drop", async () => {
  const local = memoryStore({
    companies: [
      company({ name: "Acme", boards: [{ platform: "ashby", id: "acme" }], dropped_at: null }),
    ],
  });
  const hosted = memoryStore({
    companies: [
      company({ name: "Acme", boards: [], dropped_at: "2026-09-26", reason: "no remote" }),
    ],
  });

  await copyToHosted(local, hosted);

  const [row] = await hosted.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "ashby", id: "acme" }]);
  assert.equal(row?.dropped_at, "2026-09-26");
  assert.equal(row?.reason, "no remote");
});

// Breaks if candidates are left behind or the criteria row is overwritten.
test("copyToHosted: candidates are copied whole and criteria are left alone", async () => {
  const local = memoryStore({
    candidates: [candidate({ id: "c1", outcome: "watched", company: "Acme" })],
    criteria: [{ ...CRITERIA, comp_floor: 1 }],
  });
  const hosted = memoryStore({ candidates: [], criteria: [CRITERIA] });

  const summary = await copyToHosted(local, hosted);

  assert.equal(summary.candidates, 1);
  const [row] = await hosted.select<Candidate>("candidates", { id: "c1" });
  assert.equal(row?.outcome, "watched");
  assert.equal(row?.company, "Acme");
  const [criteria] = await hosted.select<Criteria>("criteria", { id: 1 });
  assert.equal(criteria?.comp_floor, 200_000);
});

// Breaks if a candidate both stores hold keeps any hosted column: the local
// row is the record, and the hosted copy is only the backfill's snapshot.
test("copyToHosted: a candidate both stores hold takes every local column", async () => {
  const local = memoryStore({
    candidates: [
      candidate({
        id: "c2",
        origin: "builtin.com",
        added_at: "2026-09-10T00:00:00.000Z",
        outcome: "watched",
        company: "Acme",
      }),
    ],
  });
  const hosted = memoryStore({
    candidates: [
      candidate({ id: "c2", origin: "bootstrap", added_at: "2026-09-11T00:00:00.000Z" }),
    ],
  });

  await copyToHosted(local, hosted);

  const [row] = await hosted.select<Candidate>("candidates", { id: "c2" });
  assert.equal(row?.origin, "builtin.com");
  assert.equal(row?.added_at, "2026-09-10T00:00:00.000Z");
  assert.equal(row?.outcome, "watched");
  assert.equal(row?.company, "Acme");
});
