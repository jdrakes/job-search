import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeOfficeDuplicates,
  planBoardMerges,
  type StoredRow,
} from "../scripts/merge-office-duplicates.ts";
import type { Listing } from "../src/ats/ats.ts";
import type { Board, Posting, Status } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

const BOARD: Board = { platform: "greenhouse", id: "digitalocean" };

function listing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    title: "Senior Software Engineer II, Network Datapath",
    url: `https://x/${id}`,
    location: null,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: null,
    requisitionId: null,
    ...overrides,
  };
}

function stored(id: string, status: Status | null = null): StoredRow {
  return {
    key: `greenhouse/digitalocean::${id}`,
    company: "DigitalOcean",
    platform: "greenhouse",
    board: "digitalocean",
    status,
  };
}

function byKey(rows: readonly StoredRow[]): ReadonlyMap<string, StoredRow> {
  return new Map(rows.map((row) => [row.key, row]));
}

const OFFICES = [
  listing("300", { requisitionId: "req-1", location: "Denver" }),
  listing("100", { requisitionId: "req-1", location: "Austin" }),
  listing("200", { requisitionId: "req-1", location: "Boston" }),
];

// Breaks if a matched group stops keeping the lowest-id row, folding every
// office into it, and deleting the rest.
test("planBoardMerges: a matched group with no acted-on row plans a merge", () => {
  const plan = planBoardMerges(
    BOARD,
    byKey([stored("100"), stored("200"), stored("300")]),
    OFFICES,
  );

  assert.deepEqual(plan, {
    merges: [
      {
        company: "DigitalOcean",
        keep: "greenhouse/digitalocean::100",
        locations: [
          { name: "Austin", url: "https://x/100" },
          { name: "Boston", url: "https://x/200" },
          { name: "Denver", url: "https://x/300" },
        ],
        remove: ["greenhouse/digitalocean::200", "greenhouse/digitalocean::300"],
      },
    ],
    deferred: [],
  });
});

// Breaks if a status James set on a non-primary office is deleted by a merge.
test("planBoardMerges: a non-primary row with a status defers instead of merging", () => {
  const plan = planBoardMerges(
    BOARD,
    byKey([stored("100"), stored("200", "applied"), stored("300")]),
    OFFICES,
  );

  assert.deepEqual(plan, {
    merges: [],
    deferred: [
      {
        keep: "greenhouse/digitalocean::100",
        keys: [
          "greenhouse/digitalocean::100",
          "greenhouse/digitalocean::200",
          "greenhouse/digitalocean::300",
        ],
        reason: "status set on greenhouse/digitalocean::200",
      },
    ],
  });
});

// Breaks if a status on the primary (the row kept) blocks the merge.
test("planBoardMerges: a status on the primary row still merges", () => {
  const plan = planBoardMerges(BOARD, byKey([stored("100", "applied"), stored("200")]), OFFICES);

  assert.equal(plan.merges.length, 1);
  assert.deepEqual(plan.merges[0]?.remove, ["greenhouse/digitalocean::200"]);
});

// Breaks if a merge is planned with no primary row to keep.
test("planBoardMerges: a group whose primary has no stored row defers", () => {
  const plan = planBoardMerges(BOARD, byKey([stored("200"), stored("300")]), OFFICES);

  assert.deepEqual(plan.merges, []);
  assert.equal(plan.deferred[0]?.reason, "primary office has no stored row");
});

// Breaks if distinct requisitions, or listings with no requisition id, are
// planned as merges.
test("planBoardMerges: a board with no duplicates plans nothing", () => {
  const plan = planBoardMerges(BOARD, byKey([stored("1"), stored("2"), stored("3")]), [
    listing("1", { requisitionId: "req-1" }),
    listing("2", { requisitionId: "req-2" }),
    listing("3"),
  ]);

  assert.deepEqual(plan, { merges: [], deferred: [] });
});

// Breaks if a group with only one stored row is merged: nothing to fold.
test("planBoardMerges: a group matching one stored row plans nothing", () => {
  const plan = planBoardMerges(BOARD, byKey([stored("100")]), OFFICES);

  assert.deepEqual(plan, { merges: [], deferred: [] });
});

// Breaks if two listings sharing a reused placeholder requisition id but
// different titles are bundled into one merge group instead of being kept
// apart, matching groupByRequisition's (requisitionId, title) key.
test("planBoardMerges: same requisition id, different titles, never merge together", () => {
  const plan = planBoardMerges(BOARD, byKey([stored("100"), stored("200")]), [
    listing("100", { requisitionId: "N/A", title: "Backend Engineer" }),
    listing("200", { requisitionId: "N/A", title: "Frontend Engineer" }),
  ]);

  assert.deepEqual(plan, { merges: [], deferred: [] });
});

function posting(id: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key: `greenhouse/digitalocean::${id}`,
    company: "DigitalOcean",
    platform: "greenhouse",
    board: "digitalocean",
    title: "Senior Software Engineer II, Network Datapath",
    url: `https://x/${id}`,
    location: null,
    locations: [],
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2026-09-01T00:00:00.000Z",
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
    gone_at: null,
    ...overrides,
  };
}

const READERS = {
  greenhouse: { platform: "greenhouse" as const, list: async () => [...OFFICES] },
};

// Breaks if the default run writes anything: without --apply it only plans.
test("mergeOfficeDuplicates: without apply, plans and writes nothing", async () => {
  const store = memoryStore({ postings: [posting("100"), posting("200"), posting("300")] });

  const run = await mergeOfficeDuplicates(store, READERS, false);

  assert.equal(run.merges.length, 1);
  const rows = await store.select<Posting>("postings");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]?.locations, []);
});

// Breaks if apply stops writing the merged locations or deleting the rest.
test("mergeOfficeDuplicates: with apply, keeps the primary with every office and deletes the others", async () => {
  const store = memoryStore({ postings: [posting("100"), posting("200"), posting("300")] });

  await mergeOfficeDuplicates(store, READERS, true);

  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/digitalocean::100"],
  );
  assert.deepEqual(rows[0]?.locations, [
    { name: "Austin", url: "https://x/100" },
    { name: "Boston", url: "https://x/200" },
    { name: "Denver", url: "https://x/300" },
  ]);
  assert.equal(rows[0]?.title, "Senior Software Engineer II, Network Datapath");
});

// Breaks if a failed board read throws the run instead of returning an
// error line.
test("mergeOfficeDuplicates: a failed board read is an error line, not a throw", async () => {
  const store = memoryStore({ postings: [posting("100"), posting("200")] });
  const failing = {
    greenhouse: {
      platform: "greenhouse" as const,
      list: async (): Promise<Listing[]> => {
        throw new Error("boom");
      },
    },
  };

  const run = await mergeOfficeDuplicates(store, failing, true);

  assert.deepEqual(run.merges, []);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0] ?? "", /^greenhouse\/digitalocean: .*boom/);
  assert.equal((await store.select<Posting>("postings")).length, 2);
});
