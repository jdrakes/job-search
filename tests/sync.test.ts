import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCriteria } from "../src/criteria.ts";
import { needsJudging } from "../src/judge/judge.ts";
import type { Company, Criteria, Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";
import { publishSlice, pullDecisions } from "../src/sync.ts";

// Every write a pull makes, as "verb table".
function recordingStore(inner: Store): { store: Store; writes: string[] } {
  const writes: string[] = [];
  const store: Store = {
    select: <T>(...args: Parameters<Store["select"]>) => inner.select<T>(...args),
    upsert: (table, rows) => {
      writes.push(`upsert ${table}`);
      return inner.upsert(table, rows);
    },
    update: (table, key, patch) => {
      writes.push(`update ${table}`);
      return inner.update(table, key, patch);
    },
    delete: (table, keys) => {
      writes.push(`delete ${table}`);
      return inner.delete(table, keys);
    },
  };
  return { store, writes };
}

function posting(key: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key,
    company: "Acme",
    platform: "greenhouse",
    board: "acme",
    title: "Staff Engineer",
    url: "https://example.com/1",
    location: "Remote",
    comp_low: 200000,
    comp_high: 250000,
    posted_at: "2026-09-10",
    first_seen: "2026-09-10T00:00:00.000Z",
    last_seen: "2026-09-17T00:00:00.000Z",
    live: true,
    body: "the body",
    kept: true,
    reasons: [],
    evidence: {},
    judged_with: "2026-09-16T00:00:00.000Z",
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: "abc",
    workplace: null,
    ...overrides,
  };
}

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "watched",
    boards: [{ platform: "greenhouse", id: "acme" }],
    source: "hn",
    reason: null,
    first_seen: "2026-09-10T00:00:00.000Z",
    last_seen: "2026-09-17T00:00:00.000Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    id: 1,
    level_words: ["staff"],
    role_words: ["engineer"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: [],
    missing_languages: [],
    comp_floor: 200000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

test("pullDecisions: a status set in the list reaches the local store", async () => {
  const local = memoryStore({ postings: [posting("Acme::1")] });
  const hosted = memoryStore({
    postings: [
      posting("Acme::1", {
        status: "applied",
        status_at: "2026-09-17",
        applied_at: "2026-09-17",
        note: "referred by Dana",
      }),
    ],
  });

  const result = await pullDecisions(local, hosted);

  const [pulled] = await local.select<Posting>("postings");
  assert.equal(pulled?.status, "applied");
  assert.equal(pulled?.status_at, "2026-09-17");
  assert.equal(pulled?.applied_at, "2026-09-17");
  assert.equal(pulled?.note, "referred by Dana");
  assert.equal(result.statuses, 1);
  assert.equal(result.skipped, 0);
});

test("pullDecisions: the processor's own columns are not pulled back over the local ones", async () => {
  const local = memoryStore({ postings: [posting("Acme::1", { title: "Staff Engineer" })] });
  const hosted = memoryStore({
    postings: [
      posting("Acme::1", { status: "applied", title: "stale title", kept: false, live: false }),
    ],
  });

  await pullDecisions(local, hosted);

  const [pulled] = await local.select<Posting>("postings");
  assert.equal(pulled?.title, "Staff Engineer");
  assert.equal(pulled?.kept, true);
  assert.equal(pulled?.live, true);
});

test("pullDecisions: a hosted posting with no status does not clear a local one", async () => {
  const local = memoryStore({
    postings: [posting("Acme::1", { status: "rejected", status_at: "2026-09-14" })],
  });
  const hosted = memoryStore({ postings: [posting("Acme::1")] });

  const result = await pullDecisions(local, hosted);

  const [pulled] = await local.select<Posting>("postings");
  assert.equal(pulled?.status, "rejected");
  assert.equal(pulled?.status_at, "2026-09-14");
  assert.equal(result.statuses, 0);
});

test("pullDecisions: a status for a posting the local store has never seen is skipped", async () => {
  const local = memoryStore({ postings: [posting("Acme::1")] });
  const hosted = memoryStore({
    postings: [posting("Acme::1"), posting("Ghost::9", { status: "applied" })],
  });

  const result = await pullDecisions(local, hosted);

  const keys = (await local.select<Posting>("postings")).map((row) => row.key);
  assert.deepEqual(keys, ["Acme::1"]);
  assert.equal(result.statuses, 0);
  assert.equal(result.skipped, 1);
});

test("pullDecisions: a company dropped in the list reaches the local store with its reason", async () => {
  const local = memoryStore({ companies: [company("Acme")] });
  const hosted = memoryStore({
    companies: [
      company("Acme", { dropped_at: "2026-09-18T17:17:00.000Z", reason: "no remote roles" }),
    ],
  });

  const result = await pullDecisions(local, hosted);

  const [pulled] = await local.select<Company>("companies");
  assert.equal(pulled?.dropped_at, "2026-09-18T17:17:00.000Z");
  assert.equal(pulled?.reason, "no remote roles");
  assert.equal(pulled?.state, "watched");
  assert.equal(result.companies, 1);
});

test("pullDecisions: a drop cleared in the list clears the local one", async () => {
  const local = memoryStore({
    companies: [
      company("Acme", { dropped_at: "2026-09-18T17:17:00.000Z", reason: "no remote roles" }),
    ],
  });
  const hosted = memoryStore({ companies: [company("Acme")] });

  const result = await pullDecisions(local, hosted);

  const [pulled] = await local.select<Company>("companies");
  assert.equal(pulled?.dropped_at, null);
  assert.equal(pulled?.reason, null);
  assert.equal(result.companies, 1);
});

test("pullDecisions: a company's state, boards and source are not pulled back over the local ones", async () => {
  const local = memoryStore({ companies: [company("Acme")] });
  const hosted = memoryStore({
    companies: [company("Acme", { state: "discovered", boards: [], source: "stale" })],
  });

  const result = await pullDecisions(local, hosted);

  const [pulled] = await local.select<Company>("companies");
  assert.equal(pulled?.state, "watched");
  assert.deepEqual(pulled?.boards, [{ platform: "greenhouse", id: "acme" }]);
  assert.equal(pulled?.source, "hn");
  assert.equal(result.companies, 0);
});

test("pullDecisions: a company the local store has never seen is skipped", async () => {
  const local = memoryStore({ companies: [company("Acme")] });
  const hosted = memoryStore({
    companies: [company("Acme"), company("Ghost", { dropped_at: "2026-09-18T17:17:00.000Z" })],
  });

  const result = await pullDecisions(local, hosted);

  const names = (await local.select<Company>("companies")).map((row) => row.name);
  assert.deepEqual(names, ["Acme"]);
  assert.equal(result.skipped, 1);
});

test("pullDecisions: a criteria edit arrives whole and puts a judged posting back in the queue", async () => {
  const judged = posting("Acme::1", { judged_with: "2026-09-16T00:00:00.000Z" });
  const local = memoryStore({ postings: [judged], criteria: [criteria()] });
  const hosted = memoryStore({
    criteria: [
      criteria({
        comp_floor: 120000,
        role_words: ["engineer", "architect"],
        updated_at: "2026-09-17T06:00:00.000Z",
      }),
    ],
  });
  assert.equal(needsJudging(judged, criteria()), false);

  const result = await pullDecisions(local, hosted);

  const pulled = await loadCriteria(local);
  assert.ok(pulled.ok);
  assert.equal(pulled.value.comp_floor, 120000);
  assert.deepEqual(pulled.value.role_words, ["engineer", "architect"]);
  assert.equal(pulled.value.updated_at, "2026-09-17T06:00:00.000Z");
  assert.equal(needsJudging(judged, pulled.value), true);
  assert.equal(result.hasCriteria, true);
});

// Postgres checks a NOT NULL constraint while it forms the tuple, before
// ON CONFLICT can route the row to its update, so an upsert of the four
// decision columns onto a stored posting fails with 23502 on `company`. A
// memory store would never say so.
test("pullDecisions: a status is patched onto the local row, never upserted as a partial one", async () => {
  const { store: local, writes } = recordingStore(memoryStore({ postings: [posting("Acme::1")] }));
  const hosted = memoryStore({
    postings: [posting("Acme::1", { status: "applied", status_at: "2026-09-17" })],
  });

  await pullDecisions(local, hosted);

  assert.deepEqual(writes, ["update postings"]);
});

test("pullDecisions: a morning with no new decisions writes nothing", async () => {
  const decided = posting("Acme::1", { status: "applied", status_at: "2026-09-17" });
  const { store: local, writes } = recordingStore(
    memoryStore({ postings: [decided], companies: [company("Acme")] }),
  );
  const hosted = memoryStore({ postings: [decided], companies: [company("Acme")] });

  const result = await pullDecisions(local, hosted);

  assert.deepEqual(writes, []);
  assert.equal(result.statuses, 0);
  assert.equal(result.companies, 0);
});

test("pullDecisions: a hosted store with no criteria row leaves the local criteria alone", async () => {
  const local = memoryStore({ criteria: [criteria({ comp_floor: 200000 })] });
  const hosted = memoryStore({});

  const result = await pullDecisions(local, hosted);

  const pulled = await loadCriteria(local);
  assert.ok(pulled.ok);
  assert.equal(pulled.value.comp_floor, 200000);
  assert.equal(result.hasCriteria, false);
});

// publishSlice: what the list reads goes up, and nothing James wrote comes
// back down over him.

test("publishSlice sends the kept postings and the acted-on ones, and no others", async () => {
  const local = memoryStore({
    postings: [
      posting("kept::1", { kept: true }),
      posting("acted::1", { kept: false, status: "applied" }),
      posting("rejected::1", { kept: false }),
    ],
    companies: [company("Acme")],
  });
  const hosted = memoryStore();

  const result = await publishSlice(local, hosted);

  const published = await hosted.select<Posting>("postings");
  assert.deepEqual(
    published.map((row) => row.key).sort(),
    ["acted::1", "kept::1"],
    "a posting the processor rejected and James never touched is not the list's business",
  );
  assert.equal(result.postings, 2);
  assert.equal(result.companies, 1);
});

test("publishSlice never sends a posting's body or its hash", async () => {
  const local = memoryStore({ postings: [posting("kept::1", { kept: true })] });
  const hosted = memoryStore();

  await publishSlice(local, hosted);

  const [published] = await hosted.select<Record<string, unknown>>("postings");
  assert.ok(published !== undefined);
  // The list renders the evidence, never the text (POSTING_LIST_FIELDS).
  assert.equal(published["body"] ?? null, null);
  assert.equal(published["body_hash"] ?? null, null);
});

test("publishSlice does not write the four columns James authors", async () => {
  // The local store is stale here, and publishing must not carry that
  // staleness up.
  const local = memoryStore({ postings: [posting("acme::1", { kept: true, status: null })] });
  const hosted = memoryStore({
    postings: [
      posting("acme::1", {
        kept: true,
        status: "applied",
        status_at: "2026-09-16",
        applied_at: "2026-09-16",
        note: "phone screen booked",
      }),
    ],
  });

  await publishSlice(local, hosted);

  const [after] = await hosted.select<Posting>("postings", { key: "acme::1" });
  assert.ok(after !== undefined);
  assert.equal(after.status, "applied", "the status James set survives a stale publish");
  assert.equal(after.status_at, "2026-09-16");
  assert.equal(after.applied_at, "2026-09-16");
  assert.equal(after.note, "phone screen booked");
});

test("publishSlice does not write the two company columns James authors", async () => {
  // The local row is a run's read of a company James dropped after the
  // run's pull: the processor's columns go up, the drop stays.
  const local = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme", last_read: "2026-09-18T17:10:00.000Z" },
          { platform: "lever", id: "acme-inc" },
        ],
        last_seen: "2026-09-18T17:10:00.000Z",
      }),
    ],
  });
  const hosted = memoryStore({
    companies: [
      company("Acme", {
        state: "discovered",
        dropped_at: "2026-09-18T17:17:00.000Z",
        reason: "no remote roles",
      }),
    ],
  });

  const result = await publishSlice(local, hosted);

  const [after] = await hosted.select<Company>("companies", { name: "Acme" });
  assert.ok(after !== undefined);
  assert.equal(after.dropped_at, "2026-09-18T17:17:00.000Z", "the drop James made survives");
  assert.equal(after.reason, "no remote roles");
  assert.equal(after.state, "watched");
  assert.deepEqual(after.boards, [
    { platform: "greenhouse", id: "acme", last_read: "2026-09-18T17:10:00.000Z" },
    { platform: "lever", id: "acme-inc" },
  ]);
  assert.equal(after.last_seen, "2026-09-18T17:10:00.000Z");
  assert.equal(result.companies, 1);
});

// The 2026-09-18 Ferrous Motors loss: dropped in the list at ~12:17, during
// a run that had pulled at 12:10:51 and published at ~12:35.
test("a drop made between a run's pull and its publish is still there after the publish", async () => {
  const local = memoryStore({ companies: [company("Ferrous Motors")] });
  const hosted = memoryStore({ companies: [company("Ferrous Motors")] });

  await pullDecisions(local, hosted);
  await hosted.update("companies", "Ferrous Motors", {
    dropped_at: "2026-09-18T17:17:00.000Z",
    reason: "no remote roles",
  });
  await publishSlice(local, hosted);

  const [after] = await hosted.select<Company>("companies", { name: "Ferrous Motors" });
  assert.equal(after?.dropped_at, "2026-09-18T17:17:00.000Z");
  assert.equal(after?.reason, "no remote roles");

  const next = await pullDecisions(local, hosted);
  assert.equal(next.companies, 1, "the next morning's pull brings the drop down");
  const [pulled] = await local.select<Company>("companies", { name: "Ferrous Motors" });
  assert.equal(pulled?.dropped_at, "2026-09-18T17:17:00.000Z");
});

test("publishSlice removes a hosted posting that has left the slice", async () => {
  const local = memoryStore({ postings: [posting("kept::1", { kept: true })] });
  const hosted = memoryStore({
    postings: [posting("kept::1", { kept: true }), posting("gone::1", { kept: true })],
  });

  const result = await publishSlice(local, hosted);

  const published = await hosted.select<Posting>("postings");
  assert.deepEqual(
    published.map((row) => row.key),
    ["kept::1"],
  );
  assert.equal(result.removed, 1);
});

test("publishSlice never removes a hosted posting that carries a status", async () => {
  // Kept=false with a status: the operator's record, not stale output.
  const local = memoryStore({ postings: [posting("kept::1", { kept: true })] });
  const hosted = memoryStore({
    postings: [
      posting("kept::1", { kept: true }),
      posting("rejected-but-applied::1", { kept: false, status: "rejected" }),
    ],
  });

  const result = await publishSlice(local, hosted);

  const published = await hosted.select<Posting>("postings");
  assert.deepEqual(published.map((row) => row.key).sort(), ["kept::1", "rejected-but-applied::1"]);
  assert.equal(result.removed, 0);
});

test("publishSlice does not write criteria, which the list authors", async () => {
  const local = memoryStore({
    postings: [posting("kept::1", { kept: true })],
    criteria: [criteria({ comp_floor: 111111 })],
  });
  const hosted = memoryStore({ criteria: [criteria({ comp_floor: 120000 })] });
  const recorded = recordingStore(hosted);

  await publishSlice(local, recorded.store);

  assert.ok(!recorded.writes.includes("upsert criteria"), "criteria flows down only");
  const [after] = await hosted.select<Criteria>("criteria", { id: 1 });
  assert.equal(after?.comp_floor, 120000);
});
