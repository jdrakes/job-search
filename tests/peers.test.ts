import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRecord, parseRecord, readSeeds, seedsOf } from "../scripts/peers.ts";
import type { Candidate, Company } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

const NOW = "2026-09-28T12:00:00.000Z";

function company(name: string, peersSearchedAt: string | null = null): Company {
  return { name, boards: [], reason: null, dropped_at: null, peers_searched_at: peersSearchedAt };
}

// Breaks if `applied` stops counting a status James sets after applying, or
// starts counting `closed` or an untouched posting.
test("seedsOf: every status but closed makes a seed, with its titles", () => {
  const postings = [
    { company: "Acme", title: "Staff Engineer", status: "applied" as const },
    { company: "Acme", title: "Principal Engineer", status: "rejected" as const },
    { company: "Acme", title: "Staff Engineer", status: "interviewing" as const },
    { company: "Globex", title: "Senior Engineer", status: "offer" as const },
    { company: "Initech", title: "Staff Engineer", status: "closed" as const },
    { company: "Umbrella", title: "Staff Engineer", status: null },
  ];
  const companies = [company("Acme"), company("Globex"), company("Initech"), company("Umbrella")];
  assert.deepEqual(seedsOf(postings, companies), [
    { name: "Acme", roles: ["Staff Engineer", "Principal Engineer"] },
    { name: "Globex", roles: ["Senior Engineer"] },
  ]);
});

// Breaks if a searched seed is offered again, or if a posting whose company
// has no row (so could never be marked) becomes a seed.
test("seedsOf: a searched company and a company with no row are not seeds", () => {
  const postings = [
    { company: "Acme", title: "Staff Engineer", status: "applied" as const },
    { company: "Globex", title: "Staff Engineer", status: "applied" as const },
    { company: "Hooli", title: "Staff Engineer", status: "applied" as const },
  ];
  const companies = [company("Acme", "2026-09-01T00:00:00.000Z"), company("Globex")];
  assert.deepEqual(seedsOf(postings, companies), [{ name: "Globex", roles: ["Staff Engineer"] }]);
});

test("readSeeds: prints three criteria fields and every company and candidate name as known", async () => {
  const store = memoryStore({
    criteria: [
      {
        id: 1,
        level_words: ["staff"],
        role_words: ["engineer"],
        excluded_title_words: ["intern"],
        comp_floor: 200000,
      },
    ],
    companies: [company("Globex"), company("Acme")],
    postings: [
      { key: "greenhouse/acme::1", company: "Acme", title: "Staff Engineer", status: "applied" },
    ],
    candidates: [
      { id: "c1", name: "Hooli", origin: "james", added_at: NOW },
      { id: "c2", name: null, url: "https://example.com", origin: "james", added_at: NOW },
      { id: "c3", name: "Acme", origin: "james", added_at: NOW },
    ],
  });
  const result = await readSeeds(store);
  assert.deepEqual(result, {
    ok: true,
    value: {
      criteria: { level_words: ["staff"], role_words: ["engineer"], comp_floor: 200000 },
      seeds: [{ name: "Acme", roles: ["Staff Engineer"] }],
      known: ["Acme", "Globex", "Hooli"],
    },
  });
});

test("readSeeds: refuses with no criteria row", async () => {
  const result = await readSeeds(memoryStore());
  assert.equal(result.ok, false);
});

test("parseRecord: reads a valid record, an absent url as null", () => {
  const text = JSON.stringify({
    searched: ["Acme"],
    candidates: [
      { name: "Hooli", url: "https://hooli.example/careers", evidence: "Listed as a peer." },
      { name: "Vandelay", evidence: "Same market." },
    ],
  });
  assert.deepEqual(parseRecord(text), {
    ok: true,
    value: {
      searched: ["Acme"],
      candidates: [
        { name: "Hooli", url: "https://hooli.example/careers", evidence: "Listed as a peer." },
        { name: "Vandelay", url: null, evidence: "Same market." },
      ],
    },
  });
});

// Breaks if evidence becomes optional, or if the reason stops naming the
// entry.
test("parseRecord: refuses a candidate with no evidence, naming it", () => {
  const text = JSON.stringify({
    searched: [],
    candidates: [
      { name: "Hooli", evidence: "Listed as a peer." },
      { name: "Vandelay", url: "https://vandelay.example" },
    ],
  });
  assert.deepEqual(parseRecord(text), {
    ok: false,
    reason: "candidates[1] (Vandelay) needs evidence",
  });
});

test("parseRecord: refuses a url that does not parse, naming it", () => {
  const text = JSON.stringify({
    searched: [],
    candidates: [{ name: "Hooli", url: "hooli dot com", evidence: "Listed as a peer." }],
  });
  assert.deepEqual(parseRecord(text), {
    ok: false,
    reason: 'candidates[0] (Hooli) cannot read url "hooli dot com"',
  });
});

// Breaks if a URL is accepted on parsing alone: these parse, but no board
// or careers page lives at either.
for (const url of ["mailto:jobs@hooli.example", "ftp://hooli.example/jobs"]) {
  test(`parseRecord: refuses a url that is not http or https: ${url}`, () => {
    const text = JSON.stringify({
      searched: [],
      candidates: [{ name: "Hooli", url, evidence: "Listed as a peer." }],
    });
    assert.deepEqual(parseRecord(text), {
      ok: false,
      reason: `candidates[0] (Hooli) cannot read url ${JSON.stringify(url)}`,
    });
  });
}

test("parseRecord: refuses a candidate with no name", () => {
  const text = JSON.stringify({ searched: [], candidates: [{ evidence: "A peer." }] });
  assert.deepEqual(parseRecord(text), { ok: false, reason: "candidates[0] needs a name" });
});

test("parseRecord: refuses text that is not JSON", () => {
  assert.deepEqual(parseRecord("{ nope"), { ok: false, reason: "not valid JSON" });
});

// Breaks if a candidate row gains a column the run owns, or loses the
// `peers` origin.
test("applyRecord: inserts each candidate's input columns only, as peers", async () => {
  const store = memoryStore();
  const result = await applyRecord(
    store,
    {
      searched: [],
      candidates: [{ name: "Hooli", url: "https://hooli.example", evidence: "Listed as a peer." }],
    },
    NOW,
  );
  assert.deepEqual(result, { ok: true, value: { added: 1, marked: 0, unknownSeeds: [] } });
  const rows = await store.select<Candidate>("candidates");
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...row, id: "any" },
    {
      id: "any",
      name: "Hooli",
      url: "https://hooli.example",
      origin: "peers",
      evidence: "Listed as a peer.",
      added_at: NOW,
      outcome: null,
      outcome_at: null,
      company: null,
    },
  );
});

function appliedTo(company: string): object {
  return { key: `greenhouse/${company}::1`, company, title: "Staff Engineer", status: "applied" };
}

test("applyRecord: marks a searched seed, leaving its other columns", async () => {
  const store = memoryStore({
    postings: [appliedTo("Acme")],
    companies: [
      {
        name: "Acme",
        boards: [{ platform: "greenhouse", id: "acme" }],
        reason: null,
        dropped_at: null,
        peers_searched_at: null,
      },
    ],
  });
  const result = await applyRecord(store, { searched: ["Acme"], candidates: [] }, NOW);
  assert.deepEqual(result, { ok: true, value: { added: 0, marked: 1, unknownSeeds: [] } });
  assert.deepEqual(await store.select<Company>("companies"), [
    {
      name: "Acme",
      boards: [{ platform: "greenhouse", id: "acme" }],
      reason: null,
      dropped_at: null,
      peers_searched_at: NOW,
    },
  ]);
});

// Breaks if a name `seeds` would not print (searched already, no applied
// posting, or no company row) can be marked, or if a refused record still
// writes its candidates.
test("applyRecord: a searched name that is not a current seed refuses the record, naming each", async () => {
  const store = memoryStore({
    postings: [appliedTo("Acme"), appliedTo("Globex"), appliedTo("Hooli")],
    companies: [company("Acme"), company("Globex", "2026-09-01T00:00:00.000Z"), company("Initech")],
  });
  const result = await applyRecord(
    store,
    {
      searched: ["Acme", "Globex", "Initech", "Hooli"],
      candidates: [{ name: "Vandelay", url: null, evidence: "Same market." }],
    },
    NOW,
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'searched names that are not current seeds: "Globex", "Initech", "Hooli"',
  });
  assert.deepEqual(await store.select<Candidate>("candidates"), []);
  assert.deepEqual(
    (await store.select<Company>("companies")).map((row) => [row.name, row.peers_searched_at]),
    [
      ["Acme", null],
      ["Globex", "2026-09-01T00:00:00.000Z"],
      ["Initech", null],
    ],
  );
});

// The first attempt's failure: an upsert here creates the company. A seed's
// row deleted after the seed check (another writer, between the read and
// the mark) is the one way to reach it. Breaks if marking a seed can insert
// a company row.
test("applyRecord: a seed whose company row is deleted after the check creates no row and is reported", async () => {
  const inner = memoryStore({
    postings: [appliedTo("Acme"), appliedTo("Hooli")],
    companies: [company("Acme"), company("Hooli")],
  });
  const store: Store = {
    ...inner,
    async select<T>(
      table: Parameters<Store["select"]>[0],
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ): Promise<T[]> {
      const rows = await inner.select<T>(table, eq, columns);
      if (table === "companies") await inner.delete("companies", ["Hooli"]);
      return rows;
    },
  };
  const result = await applyRecord(store, { searched: ["Acme", "Hooli"], candidates: [] }, NOW);
  assert.deepEqual(result, {
    ok: true,
    value: { added: 0, marked: 1, unknownSeeds: ['companies: no row with name "Hooli"'] },
  });
  const names = (await inner.select<Company>("companies")).map((row) => row.name);
  assert.deepEqual(names, ["Acme"]);
});
