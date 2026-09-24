import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Listing, Reader } from "../src/ats/ats.ts";
import { ingest, judgeAll } from "../src/ingest.ts";
import { HttpError } from "../src/net/http.ts";
import type { Company, Criteria, Platform, Posting, Table } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

interface SelectCall {
  readonly table: Table;
  readonly eq: Partial<Record<string, unknown>> | undefined;
  readonly columns: readonly string[] | undefined;
}

interface UpsertCall {
  readonly table: Table;
  readonly rows: readonly object[];
}

interface UpdateCall {
  readonly table: Table;
  readonly key: string;
  readonly patch: object;
}

// Answers exactly as the store it wraps while recording what was asked of
// it: the reads a run makes are the thing under test.
function recording(inner: Store): {
  store: Store;
  selects: SelectCall[];
  upserts: UpsertCall[];
  updates: UpdateCall[];
} {
  const selects: SelectCall[] = [];
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];
  const store: Store = {
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      selects.push({ table, eq, columns });
      return inner.select<T>(table, eq, columns);
    },
    async upsert(table, rows) {
      upserts.push({ table, rows });
      return inner.upsert(table, rows);
    },
    async update(table, key, patch) {
      updates.push({ table, key, patch });
      return inner.update(table, key, patch);
    },
    delete: (table, keys) => inner.delete(table, keys),
  };
  return { store, selects, upserts, updates };
}

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "watched",
    boards: [],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00.000Z",
    last_seen: "2026-09-15T00:00:00.000Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

function listing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    location: null,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: null,
    ...overrides,
  };
}

// The judging pass needs a criteria row to run at all; most titles below
// carry no role word, so the listing criteria drop them and judging
// finishes with no errors.
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
    title: null,
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
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

test("ingest: two companies with two boards each are all listed", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
      company("Globex", {
        boards: [
          { platform: "greenhouse", id: "globex-gh" },
          { platform: "lever", id: "globex-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async (board) => [listing(`${board.id}-1`)] },
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers);

  assert.equal(result.companies, 2);
  assert.equal(result.listed, 4);
  assert.equal(result.recorded, 4);
  assert.deepEqual(result.errors, []);

  const rows = await store.select<Posting>("postings");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.key).sort(), [
    "greenhouse/acme-gh::acme-gh-1",
    "greenhouse/globex-gh::globex-gh-1",
    "lever/acme-lv::acme-lv-1",
    "lever/globex-lv::globex-lv-1",
  ]);
});

test("ingest: two company names carrying one board record one posting, not two", async () => {
  // Wellspring and Wellspring Health are one employer with one Greenhouse
  // board; a key naming the company rather than the board stores every such
  // req twice.
  const store = memoryStore({
    companies: [
      company("Wellspring", { boards: [{ platform: "greenhouse", id: "wellspring" }] }),
      company("Wellspring Health", { boards: [{ platform: "greenhouse", id: "wellspring" }] }),
    ],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("4123456")] },
  };

  const result = await ingest(store, readers);

  assert.equal(result.listed, 2, "both companies' boards were listed");
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/wellspring::4123456"],
  );
});

test("ingest: a failing board is recorded as an error and the others still land", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        throw new Error("board unavailable");
      },
    },
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /Acme greenhouse\/acme-gh: board unavailable/);
  assert.equal(result.listed, 1);
  assert.equal(result.recorded, 1);

  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["lever/acme-lv::acme-lv-1"],
  );
});

function goneReader(platform: Platform, status: number): Reader {
  return {
    platform,
    list: async () => {
      throw new HttpError(status, `HTTP ${status}`);
    },
  };
}

test("ingest: a board that 404s twice is removed on the second run and its company returned to discovered", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = { greenhouse: goneReader("greenhouse", 404) };

  const first = await ingest(store, readers);
  assert.deepEqual(first.returned, []);
  assert.deepEqual(first.errors, ["Acme greenhouse/acme-gh: HTTP 404"]);
  const [afterFirst] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(afterFirst?.state, "watched");
  assert.deepEqual(afterFirst?.boards, [{ platform: "greenhouse", id: "acme-gh", gone: 1 }]);

  const second = await ingest(store, readers);
  assert.deepEqual(second.returned, ["Acme greenhouse/acme-gh"]);
  assert.deepEqual(second.errors, ["Acme greenhouse/acme-gh: HTTP 404"]);
  const [afterSecond] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(afterSecond?.state, "discovered");
  assert.deepEqual(afterSecond?.boards, []);

  // Nothing left to walk.
  const third = await ingest(store, readers);
  assert.equal(third.companies, 0);
});

test("ingest: a board that 404s once and then lists loses its mark", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  let answers = false;
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        if (!answers) throw new HttpError(404, "HTTP 404");
        return [listing("1")];
      },
    },
  };

  await ingest(store, readers);
  const [marked] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(marked?.boards, [{ platform: "greenhouse", id: "acme-gh", gone: 1 }]);

  answers = true;
  const result = await ingest(store, readers, { now: () => "2026-09-16T06:00:00.000Z" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.listed, 1);
  const [cleared] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(cleared?.state, "watched");
  assert.deepEqual(cleared?.boards, [
    { platform: "greenhouse", id: "acme-gh", last_read: "2026-09-16T06:00:00.000Z" },
  ]);
});

test("ingest: a board answering 429 is an error line every run and is never marked gone", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = { greenhouse: goneReader("greenhouse", 429) };

  await ingest(store, readers);
  const result = await ingest(store, readers);

  assert.deepEqual(result.errors, ["Acme greenhouse/acme-gh: HTTP 429"]);
  assert.deepEqual(result.returned, []);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme-gh" }]);
});

test("ingest: a workday board answering 400 twice is gone; a greenhouse board answering 400 is not", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", { boards: [{ platform: "workday", id: "acme/site" }] }),
      company("Bolt", { boards: [{ platform: "greenhouse", id: "bolt" }] }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: goneReader("workday", 400),
    greenhouse: goneReader("greenhouse", 400),
  };

  await ingest(store, readers);
  const result = await ingest(store, readers);

  assert.deepEqual(result.returned, ["Acme workday/acme/site"]);
  const [acme] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(acme?.state, "discovered");
  const [bolt] = await store.select<Company>("companies", { name: "Bolt" });
  assert.equal(bolt?.state, "watched");
  assert.deepEqual(bolt?.boards, [{ platform: "greenhouse", id: "bolt" }]);
});

test("ingest: a company with two boards loses only the dead one and stays watched", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: goneReader("greenhouse", 404),
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T06:00:00.000Z" });
  const result = await ingest(store, readers, { now: () => "2026-09-16T06:00:00.000Z" });

  assert.deepEqual(result.returned, []);
  assert.equal(result.listed, 1);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "lever", id: "acme-lv", last_read: "2026-09-16T06:00:00.000Z" },
  ]);
});

// Seconds from 06:00 on the day, one per call: the run's first reading is
// the board's `last_read` and every later one is a row's `last_seen`.
function tickingClockFrom(day: string): () => string {
  let seconds = 0;
  return () => {
    const at = new Date(`${day}T06:00:00.000Z`);
    at.setUTCSeconds(seconds);
    seconds += 1;
    return at.toISOString();
  };
}

function tickingClock(): () => string {
  return tickingClockFrom("2026-09-18");
}

test("ingest: the board that listed carries the run's first clock reading as last_read", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("1"), listing("2")] },
  };

  const result = await ingest(store, readers, { now: tickingClock() });

  assert.deepEqual(result.errors, []);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme-gh", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("ingest: every row a run records has last_seen at or after its board's last_read", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("1"), listing("2")] },
    lever: { platform: "lever", list: async () => [listing("3")] },
  };

  await ingest(store, readers, { now: tickingClock() });

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  const lastRead = new Map(row?.boards.map((board) => [board.platform, board.last_read]));
  const postings = await store.select<Posting>("postings");
  assert.equal(postings.length, 3);
  for (const posting of postings) {
    const read = lastRead.get(posting.platform);
    assert.ok(read !== undefined, `${posting.platform} board has a last_read`);
    assert.ok(
      posting.last_seen >= read,
      `${posting.key}: last_seen ${posting.last_seen} is not before last_read ${read}`,
    );
  }
});

test("ingest: a board whose reader throws carries no last_read while its answering sibling does", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: goneReader("greenhouse", 500),
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers, { now: () => "2026-09-18T06:00:00.000Z" });

  assert.deepEqual(result.errors, ["Acme greenhouse/acme-gh: HTTP 500"]);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme-gh" },
    { platform: "lever", id: "acme-lv", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("ingest: a board that 404s keeps its gone mark while its answering sibling is marked read", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: goneReader("greenhouse", 404),
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  await ingest(store, readers, { now: () => "2026-09-18T06:00:00.000Z" });

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme-gh", gone: 1 },
    { platform: "lever", id: "acme-lv", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("ingest: a reader answering an empty listing is a read and sets last_read", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [] },
  };

  const result = await ingest(store, readers, { now: () => "2026-09-18T06:00:00.000Z" });

  assert.deepEqual(result.errors, []);
  assert.equal(result.listed, 0);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [
    { platform: "greenhouse", id: "acme-gh", last_read: "2026-09-18T06:00:00.000Z" },
  ]);
});

test("ingest: a refused postings upsert leaves last_read unset", async () => {
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      if (table === "postings") throw new Error("refused");
      return inner.upsert(table, rows);
    },
  };
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("1")] },
  };

  const result = await ingest(store, readers, { now: () => "2026-09-18T06:00:00.000Z" });

  assert.deepEqual(result.errors, ["Acme: recording 1 postings: refused"]);
  const [row] = await inner.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme-gh" }]);
});

test("ingest: a refused board-read write is an error line and the postings still land", async () => {
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      if (table === "companies") throw new Error("refused");
      return inner.upsert(table, rows);
    },
  };
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("1")] },
  };

  const result = await ingest(store, readers, { now: () => "2026-09-18T06:00:00.000Z" });

  assert.deepEqual(result.errors, ["Acme: recording board reads: refused"]);
  assert.equal(result.recorded, 1);
  const [row] = await inner.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme-gh" }]);
});

test("ingest: a board whose reader throws a chained network error names the cause in its error line", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      },
    },
  };

  const result = await ingest(store, readers);

  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0] ?? "",
    /Acme greenhouse\/acme-gh: fetch failed <- read ECONNRESET \(ECONNRESET\)/,
  );
});

test("ingest: a store refusal while recording one company is an error line and the other companies still land", async () => {
  const inner = memoryStore({
    companies: [
      company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
      company("Globex", { boards: [{ platform: "lever", id: "globex-lv" }] }),
    ],
    criteria: [criteria()],
  });
  // Refuses Acme's rows only; Globex's worker must still land its row.
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      if (rows.some((row) => "company" in row && row.company === "Acme")) {
        throw new Error("refused");
      }
      return inner.upsert(table, rows);
    },
  };

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async (board) => [listing(`${board.id}-1`)] },
    lever: { platform: "lever", list: async (board) => [listing(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /Acme: recording 1 postings: refused/);
  assert.equal(result.listed, 2);
  assert.equal(result.recorded, 1);

  const rows = await inner.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["lever/globex-lv::globex-lv-1"],
  );
});

test("ingest: a board whose platform has no reader is an error line, not a crash", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "wd5/Acme/acme" }] })],
  });

  const result = await ingest(store, {});

  assert.equal(result.companies, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /no reader for "workday"/);
  assert.equal(result.recorded, 0);
});

test("ingest: a re-listed posting keeps its first_seen and updates last_seen and fields", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-gh::123",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        title: "Old Title",
        comp_low: 1,
        kept: true,
        status: "applied",
      }),
    ],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("123", { title: "New Title", compLow: 200_000, body: "a body with the range" }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::123" });
  assert.ok(row);
  assert.equal(row?.first_seen, "2020-01-01T00:00:00.000Z");
  assert.equal(row?.last_seen, "2026-09-15T12:00:00.000Z");
  assert.equal(row?.title, "New Title");
  // A listing that carries a comp still rewrites it, so a reader fix
  // corrects every stored posting on the next run.
  assert.equal(row?.comp_low, 200_000);
  // Fields a later stage owns are untouched by the re-list.
  assert.equal(row?.kept, true);
  assert.equal(row?.status, "applied");
});

test("ingest: re-lists a company without reading its stored postings back", async () => {
  const { store, selects } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      postings: [
        posting({
          key: "greenhouse/acme-gh::123",
          company: "Acme",
          platform: "greenhouse",
          board: "acme-gh",
          title: "Old Title",
          status: "applied",
        }),
      ],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [listing("123", { title: "New Title" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  // The read this removes: `GET postings?company=eq.Acme`, once per watched
  // company, which timed out on the full store.
  const perCompany = selects.filter(
    (call) => call.table === "postings" && call.eq !== undefined && "company" in call.eq,
  );
  assert.deepEqual(perCompany, [], "a re-list must not read a company's stored postings");

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::123" });
  assert.equal(row?.title, "New Title");
  assert.equal(row?.status, "applied", "a column the payload omits keeps its stored value");
});

test("ingest: a re-list omits first_seen, leaving it to the column default", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123")] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const written = upserts.filter((call) => call.table === "postings").flatMap((call) => call.rows);
  assert.equal(written.length, 1);
  // No `comp_low`/`comp_high` either, and no `workplace`: nothing to read a
  // comp from, and no body or word to state a workplace.
  assert.deepEqual(Object.keys(written[0] ?? {}).sort(), [
    "board",
    "company",
    "key",
    "last_seen",
    "location",
    "platform",
    "posted_at",
    "title",
    "url",
  ]);
});

test("ingest: a company's listings with a body, with only a comp, and with neither go in one mixed-shape upsert", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [
        company("Acme", {
          boards: [
            { platform: "greenhouse", id: "acme-gh" },
            { platform: "workday", id: "acme-wd" },
          ],
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("gh1", { body: "the board handed this over" }),
        listing("gh2", { body: null, compLow: 150_000, compHigh: 200_000 }),
      ],
    },
    workday: { platform: "workday", list: async () => [listing("wd1", { body: null })] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  // ingest.ts sends the whole company as one upsert; the adapter is what
  // groups by column set (body-carrying, comp-only, and the bare two-phase
  // entry).
  const written = upserts.filter((call) => call.table === "postings");
  assert.equal(written.length, 1);
  assert.deepEqual(
    written[0]?.rows.map((row) => [(row as Posting).key, "body" in row, "comp_low" in row]),
    [
      ["greenhouse/acme-gh::gh1", true, true],
      ["greenhouse/acme-gh::gh2", false, true],
      ["workday/acme-wd::wd1", false, false],
    ],
  );
});

// Computed the same way `bodyHash` in src/ingest.ts does: a fixture value.
function hashOf(body: string): string {
  return createHash("md5").update(body, "utf8").digest("hex");
}

test("ingest: a re-listed posting whose body is unchanged is upserted without its body", async () => {
  const bodyText = "same text";
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      postings: [
        posting({
          key: "greenhouse/acme-gh::123",
          company: "Acme",
          platform: "greenhouse",
          board: "acme-gh",
          body: bodyText,
          body_hash: hashOf(bodyText),
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123", { body: bodyText })] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "greenhouse/acme-gh::123");
  assert.ok(written);
  assert.equal("body" in (written as object), false);
  assert.equal("body_hash" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::123" });
  assert.equal(row?.body, bodyText);
});

test("ingest: a re-listed posting whose body changed is upserted with body and hash", async () => {
  const oldBody = "same text";
  const newBody = "new text";
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      postings: [
        posting({
          key: "greenhouse/acme-gh::123",
          company: "Acme",
          platform: "greenhouse",
          board: "acme-gh",
          body: oldBody,
          body_hash: hashOf(oldBody),
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123", { body: newBody })] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "greenhouse/acme-gh::123") as
    { body?: unknown; body_hash?: unknown } | undefined;
  assert.equal(written?.body, newBody);
  assert.equal(written?.body_hash, hashOf(newBody));

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::123" });
  assert.equal(row?.body, newBody);
});

// First seen without pay, out on level ("Senior" is pay-settled) until a
// re-list adds a band above the floor. `judged_with` already matches the
// current criteria row, so without the band trigger the stale "out" stays.
test("ingest: a re-listed posting whose band crosses the floor is re-judged the same run and kept", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-gh::swe1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        title: "Senior Backend Engineer",
        comp_high: null,
        kept: false,
        reasons: [
          {
            criterion: "level",
            verdict: "out",
            detail: 'title carries "Senior" but no pay is posted to settle it',
          },
        ],
        // Already judged with the criteria row this run uses.
        judged_with: "2026-09-14T00:00:00Z",
      }),
    ],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("swe1", {
          title: "Senior Backend Engineer",
          compLow: 250_000,
          compHigh: 300_000,
          body: "This is a fully remote position open to candidates anywhere in the US.",
        }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });
  const judging = await judgeAll(store, readers, { now: () => "2026-09-17T12:00:01.000Z" });

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::swe1" });
  assert.equal(row?.kept, true);
  assert.equal(row?.comp_high, 300_000);
  assert.equal(row?.evidence["level"], 'title carries "Senior", settled by the posted pay');
});

test("ingest: a re-listed posting whose band is unchanged keeps its stored judged_with", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      postings: [
        posting({
          key: "greenhouse/acme-gh::swe2",
          company: "Acme",
          platform: "greenhouse",
          board: "acme-gh",
          title: "Staff Backend Engineer",
          comp_high: 300_000,
          kept: true,
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("swe2", { title: "Staff Backend Engineer", compLow: 250_000, compHigh: 300_000 }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "greenhouse/acme-gh::swe2");
  assert.ok(written);
  assert.equal("judged_with" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::swe2" });
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
});

test("ingest: a two-phase re-list carries no comp, so a stored band survives untouched with its judged_with", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      postings: [
        posting({
          key: "workday/acme-wd::swe3",
          company: "Acme",
          platform: "workday",
          board: "acme-wd",
          title: "Staff Backend Engineer",
          comp_high: 251_900,
          kept: true,
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe3", { title: "Staff Backend Engineer" })],
      body: async () => {
        assert.fail("a re-list must not fetch a body; only the judging pass does");
      },
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "workday/acme-wd::swe3");
  assert.ok(written);
  assert.equal("comp_low" in (written as object), false);
  assert.equal("judged_with" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe3" });
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
  assert.equal(row?.comp_high, 251_900, "the stored band survives an untouched re-list");
});

// The board's workplace word is a verdict input the way a band is. The
// stored-null case is also the backfill: after the migration every stored
// row is null and every Ashby/Lever listing is not.
test("ingest: a re-listed posting whose board states a workplace the store lacks is re-judged the same run", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "ashby", id: "acme" }] })],
      postings: [
        posting({
          key: "ashby/acme::swe4",
          company: "Acme",
          platform: "ashby",
          board: "acme",
          title: "Staff Engineer",
          workplace: null,
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    ashby: {
      platform: "ashby",
      list: async () => [listing("swe4", { title: "Staff Engineer", workplace: "remote" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "ashby/acme::swe4") as
    { workplace?: unknown; judged_with?: unknown } | undefined;
  assert.equal(written?.workplace, "remote");
  assert.equal(written?.judged_with, null);
  assert.equal("judged_with" in (written ?? {}), true);

  const judging = await judgeAll(store, readers, { now: () => "2026-09-17T12:00:01.000Z" });
  assert.equal(judging.judged, 1, "the null judged_with makes the judging pass look again");
  const [row] = await store.select<Posting>("postings", { key: "ashby/acme::swe4" });
  assert.equal(row?.workplace, "remote");
});

test("ingest: a re-listed posting whose board states the workplace already stored keeps its judged_with", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "ashby", id: "acme" }] })],
      postings: [
        posting({
          key: "ashby/acme::swe5",
          company: "Acme",
          platform: "ashby",
          board: "acme",
          title: "Staff Engineer",
          workplace: "remote",
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    ashby: {
      platform: "ashby",
      list: async () => [listing("swe5", { title: "Staff Engineer", workplace: "remote" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "ashby/acme::swe5");
  assert.ok(written);
  assert.equal("judged_with" in (written as object), false);

  const judging = await judgeAll(store, readers, { now: () => "2026-09-17T12:00:01.000Z" });
  assert.equal(judging.judged, 0);
  const [row] = await store.select<Posting>("postings", { key: "ashby/acme::swe5" });
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
});

test("ingest: a re-listed posting whose board withdrew its workplace word is re-judged", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "ashby", id: "acme" }] })],
      postings: [
        posting({
          key: "ashby/acme::swe6",
          company: "Acme",
          platform: "ashby",
          board: "acme",
          title: "Staff Engineer",
          workplace: "remote",
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    ashby: {
      platform: "ashby",
      list: async () => [
        listing("swe6", { title: "Staff Engineer", body: "Staff Engineer.", workplace: null }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  // The listing carries its body, so its null is the board's word: the
  // board no longer states one and the text path takes over.
  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "ashby/acme::swe6") as
    { workplace?: unknown; judged_with?: unknown } | undefined;
  assert.equal(written?.workplace, null);
  assert.equal("judged_with" in (written ?? {}), true);
  assert.equal(written?.judged_with, null);
});

test("ingest: a first-seen posting with a workplace makes no re-judge claim", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "lever", id: "acme" }] })],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    lever: {
      platform: "lever",
      list: async () => [listing("swe7", { title: "Staff Engineer", workplace: "hybrid" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  // Nothing stored to differ from: `judged_with` stays out of the payload.
  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "lever/acme::swe7") as
    { workplace?: unknown; judged_with?: unknown } | undefined;
  assert.equal(written?.workplace, "hybrid");
  assert.equal("judged_with" in (written ?? {}), false);
});

// A two-phase board states its workplace on the detail, not the listing,
// so the listing's null is not a withdrawal: the column stays out of the
// payload and no re-judge is claimed.
test("ingest: a two-phase re-list stating no workplace keeps the stored word and its judged_with", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      postings: [
        posting({
          key: "workday/acme-wd::swe8",
          company: "Acme",
          platform: "workday",
          board: "acme-wd",
          title: "Staff Backend Engineer",
          workplace: "remote",
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe8", { title: "Staff Backend Engineer", workplace: null })],
      body: async () => {
        assert.fail("a re-list must not fetch a body; only the judging pass does");
      },
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "workday/acme-wd::swe8");
  assert.ok(written);
  assert.equal("workplace" in (written as object), false);
  assert.equal("judged_with" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe8" });
  assert.equal(row?.workplace, "remote");
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
});

test("ingest: a two-phase listing that states a workplace writes it and re-judges on a change", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      postings: [
        posting({
          key: "workday/acme-wd::swe9",
          company: "Acme",
          platform: "workday",
          board: "acme-wd",
          title: "Staff Backend Engineer",
          workplace: "remote",
          judged_with: "2026-09-14T00:00:00Z",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe9", { title: "Staff Backend Engineer", workplace: "hybrid" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "workday/acme-wd::swe9") as
    { workplace?: unknown; judged_with?: unknown } | undefined;
  assert.equal(written?.workplace, "hybrid");
  assert.equal(written?.judged_with, null);
  assert.equal("judged_with" in (written ?? {}), true);
});

test("ingest: bare listings whose workplace changed and whose did not go in one upsert, each keeping its own shape", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "ashby", id: "acme" }] })],
      postings: [
        posting({ key: "ashby/acme::a", company: "Acme", platform: "ashby", board: "acme" }),
        posting({
          key: "ashby/acme::b",
          company: "Acme",
          platform: "ashby",
          board: "acme",
          workplace: "onsite",
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    ashby: {
      platform: "ashby",
      list: async () => [
        listing("a", { workplace: "remote" }),
        listing("b", { workplace: "onsite" }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z" });

  // One upsert for the company; a bare row carrying `judged_with: null`
  // keeps a different shape from a bare row that omits it, which is the
  // adapter's grouping to make, not ingest.ts's.
  const written = upserts.filter((call) => call.table === "postings");
  assert.equal(written.length, 1);
  assert.deepEqual(
    written[0]?.rows.map((row) => [(row as Posting).key, "judged_with" in row]),
    [
      ["ashby/acme::a", true],
      ["ashby/acme::b", false],
    ],
  );
});

test("ingest: a new posting with a body is stored with its hash", async () => {
  const bodyText = "brand new body";
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("new1", { body: bodyText })] },
  };

  await ingest(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::new1" });
  assert.equal(row?.body, bodyText);
  assert.equal(row?.body_hash, hashOf(bodyText));
});

test("ingest: a stored posting with no hash yet gets its body and hash written once", async () => {
  const bodyText = "same text, never hashed";
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      postings: [
        posting({
          key: "greenhouse/acme-gh::123",
          company: "Acme",
          platform: "greenhouse",
          board: "acme-gh",
          body: bodyText,
          body_hash: null,
        }),
      ],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123", { body: bodyText })] },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "greenhouse/acme-gh::123") as
    { body?: unknown; body_hash?: unknown } | undefined;
  assert.equal(written?.body, bodyText);
  assert.equal(written?.body_hash, hashOf(bodyText));
});

test("ingest: a failed hash read logs an error and lists with every body written, not a thrown run", async () => {
  const bodyText = "same text";
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-gh::123",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        body: bodyText,
        body_hash: hashOf(bodyText),
      }),
    ],
  });
  // Only the up-front sweep's own read fails; every other read answers.
  const failing: Store = {
    ...inner,
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      if (table === "postings" && columns?.join(",") === "key,body_hash,comp_high,workplace") {
        throw new Error("column postings.body_hash does not exist");
      }
      return inner.select<T>(table, eq, columns);
    },
  };
  const { store, upserts } = recording(failing);

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123", { body: bodyText })] },
  };

  const result = await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  assert.match(result.errors[0] ?? "", /reading stored body hashes/);
  assert.equal(result.recorded, 1);

  // No hash to compare against, so the body goes with the row.
  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "greenhouse/acme-gh::123") as
    { body?: unknown; body_hash?: unknown } | undefined;
  assert.equal(written?.body, bodyText);
  assert.equal(written?.body_hash, hashOf(bodyText));
});

test("ingest: a listing with no id is refused, never recorded under an empty key", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("", { title: "First" }),
        listing("", { title: "Second" }),
        listing("real"),
      ],
    },
  };

  const result = await ingest(store, readers);

  // Without the refusal all three key to "greenhouse/acme-gh::" and
  // overwrite one row, with nothing on `errors` to say so.
  assert.equal(result.listed, 3);
  assert.equal(result.recorded, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0] ?? "", /Acme greenhouse\/acme-gh: listing with no id: First/);
  assert.match(result.errors[1] ?? "", /Acme greenhouse\/acme-gh: listing with no id: Second/);

  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/acme-gh::real"],
  );
});

test("ingest: a duplicate id in one board's listing is recorded once", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [listing("dup", { title: "First" }), listing("dup", { title: "Second" })],
    },
  };

  const result = await ingest(store, readers);

  assert.equal(result.listed, 2);
  assert.equal(result.recorded, 1);

  const rows = await store.select<Posting>("postings");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, "Second");
});

// The timeout is the assertion's other half: `node --test` has no default
// timeout, so without one a hang is a wedged suite.
test(
  "ingest: platforms are listed concurrently, not one after another",
  { timeout: 2000 },
  async () => {
    const store = memoryStore({
      companies: [
        company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
        company("Globex", { boards: [{ platform: "lever", id: "globex-lv" }] }),
      ],
    });

    // Sequential code awaits greenhouse first and never calls lever, so the
    // gate never opens. Concurrent code calls both.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const readers: Partial<Record<Platform, Reader>> = {
      greenhouse: {
        platform: "greenhouse",
        list: async (board) => {
          await gate;
          return [listing(`${board.id}-1`)];
        },
      },
      lever: {
        platform: "lever",
        list: async (board) => {
          release();
          return [listing(`${board.id}-1`)];
        },
      },
    };

    const result = await ingest(store, readers);

    assert.equal(result.listed, 2);
    const rows = await store.select<Posting>("postings");
    assert.deepEqual(rows.map((row) => row.key).sort(), [
      "greenhouse/acme-gh::acme-gh-1",
      "lever/globex-lv::globex-lv-1",
    ]);
  },
);

test("ingest: a company with boards on two platforms is walked by one worker in board order", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-gh" },
          { platform: "lever", id: "acme-lv" },
        ],
      }),
    ],
  });

  const calls: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        calls.push(board.platform);
        return [listing(`${board.id}-1`)];
      },
    },
    lever: {
      platform: "lever",
      list: async (board) => {
        calls.push(board.platform);
        return [listing(`${board.id}-1`)];
      },
    },
  };

  await ingest(store, readers);

  assert.deepEqual(calls, ["greenhouse", "lever"]);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(rows.map((row) => row.key).sort(), [
    "greenhouse/acme-gh::acme-gh-1",
    "lever/acme-lv::acme-lv-1",
  ]);
});

test("ingest: fetches the body and judges a posting the listing criteria kept", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  const bodyCalls: Array<{ boardId: string; id: string }> = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async (board, id) => {
        bodyCalls.push({ boardId: board.id, id });
        return listing(id, {
          body: "This is a fully remote position open to candidates anywhere in the US.",
        });
      },
    },
  };

  await ingest(store, readers);
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  assert.deepEqual(bodyCalls, [{ boardId: "acme-gh", id: "swe1" }]);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::swe1" });
  assert.ok(row);
  assert.equal(row?.kept, true);
  assert.equal(row?.body, "This is a fully remote position open to candidates anywhere in the US.");
  assert.equal(row?.judged_with, criteria().updated_at);
});

// The two things the cut at the first `::` has to hold for: a key written
// before the key moved off the company name, and a board that puts `::`
// inside a listing id.
test("judgeAll: a posting stored under the old company-name key still fetches its body by the bare listing id", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "Acme::swe1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        title: "Staff Backend Engineer",
      }),
    ],
    criteria: [criteria()],
  });

  const bodyCalls: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [],
      body: async (_board, id) => {
        bodyCalls.push(id);
        return listing(id, { body: "A fully remote role, open across the US." });
      },
    },
  };

  await judgeAll(store, readers);

  assert.deepEqual(bodyCalls, ["swe1"]);
});

test("judgeAll: a listing id carrying the key's own separator is fetched whole", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-gh::swe::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        title: "Staff Backend Engineer",
      }),
    ],
    criteria: [criteria()],
  });

  const bodyCalls: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [],
      body: async (_board, id) => {
        bodyCalls.push(id);
        return listing(id, { body: "A fully remote role, open across the US." });
      },
    },
  };

  await judgeAll(store, readers);

  assert.deepEqual(bodyCalls, ["swe::1"]);
});

// Workday stands in for the three two-phase boards.
function twoPhaseReader(body: string): Reader {
  return {
    platform: "workday",
    list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
    body: async (_board, id) => listing(id, { body }),
  };
}

test("ingest: a two-phase posting's comp is read from its fetched body and survives the next re-list", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000 })],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReader(
      "Staff Backend Engineer. Remote in the US. The salary range is $184,500.00 to $251,900.00.",
    ),
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [judged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(judged?.comp_low, 184_500);
  assert.equal(judged?.comp_high, 251_900);
  assert.equal(judged?.kept, true);

  // The re-list carries neither body nor comp, so it must leave what the
  // judging pass wrote alone.
  await ingest(store, readers);

  const [relisted] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(relisted?.comp_low, 184_500);
  assert.equal(relisted?.comp_high, 251_900);
});

// Workable and Rippling state pay in detail fields outside the prose; the
// stated band wins over what `compInText` reads from the body.
const RELOCATION_BODY =
  "Staff Backend Engineer. Remote in the US. We offer $5,000 - $10,000 relocation.";

function twoPhaseReaderStating(comp: Pick<Listing, "compLow" | "compHigh">): Reader {
  return {
    platform: "workday",
    list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
    body: async (_board, id) => listing(id, { body: RELOCATION_BODY, ...comp }),
  };
}

test("ingest: a two-phase detail stating its comp writes the stated band, not the prose's", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReaderStating({ compLow: 140_000, compHigh: 165_000 }),
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.comp_low, 140_000);
  assert.equal(row?.comp_high, 165_000);
});

test("ingest: a two-phase detail stating no comp falls back to the prose's", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReaderStating({ compLow: null, compHigh: null }),
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.comp_low, 5_000);
  assert.equal(row?.comp_high, 10_000);
});

// The comp columns are integers and Rippling states its range as floats.
// `wholeDollars` is `Math.round`, so .5 goes up and .25 goes down.
test("ingest: a two-phase detail stating float pay writes it rounded to whole dollars", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReaderStating({ compLow: 140_000.5, compHigh: 165_000.25 }),
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.comp_low, 140_001);
  assert.equal(row?.comp_high, 165_000);
});

test("ingest: a two-phase detail stating its comp with no prose still writes the stated band", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async (_board, id) => listing(id, { body: null, compLow: 140_000, compHigh: 165_000 }),
    },
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.body, null);
  assert.equal(row?.comp_low, 140_000);
  assert.equal(row?.comp_high, 165_000);
});

// A criteria edit re-judges from the stored body with no detail read. The
// stated band is not in the prose, so re-parsing the prose would replace it
// with the relocation figures; the row must carry its stored band instead.
test("ingest: a re-judge from the stored body keeps the detail's stated band and does not refetch", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    // A floor the stated band clears: a posting refused on the floor is
    // never read for its body, and this test is about the read.
    criteria: [criteria({ comp_floor: 100_000, updated_at: "2026-09-14T00:00:00Z" })],
  });
  const first: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReaderStating({ compLow: 140_000, compHigh: 165_000 }),
  };

  await ingest(store, first);
  await judgeAll(store, first);

  const [written] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(written?.comp_low, 140_000);
  assert.equal(written?.comp_high, 165_000);
  assert.equal(written?.kept, true);
  assert.equal(written?.judged_with, "2026-09-14T00:00:00Z");

  const edited = await store.update("criteria", "1", {
    level_words: ["staff", "principal"],
    updated_at: "2026-09-15T00:00:00Z",
  });
  assert.equal(edited.ok, true);
  const second: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async () => {
        assert.fail("a stored body must not be refetched on a criteria edit");
      },
    },
  };

  await ingest(store, second);
  const judging = await judgeAll(store, second);

  assert.equal(judging.judged, 1);
  const [rejudged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(rejudged?.comp_low, 140_000);
  assert.equal(rejudged?.comp_high, 165_000);
  assert.equal(rejudged?.judged_with, "2026-09-15T00:00:00Z");
});

test("ingest: a two-phase posting judged on a detail stating remote stores the word and decides remote by it", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000 })],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      // The text alone would read as on-site; the board's word decides.
      body: async (_board, id) =>
        listing(id, {
          body: "Staff Backend Engineer. This role is in-office 5 days a week. The salary range is $184,500.00 to $251,900.00.",
          workplace: "remote",
        }),
    },
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [judged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(judged?.workplace, "remote");
  assert.equal(judged?.kept, true);
  const remote = (judged?.reasons as { criterion: string; detail: string }[]).find(
    (reason) => reason.criterion === "remote",
  );
  assert.equal(remote?.detail, "board states remote");

  // The re-list states no workplace, so the word the detail gave survives.
  await ingest(store, readers);

  const [relisted] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(relisted?.workplace, "remote");
});

test("ingest: a two-phase posting whose detail is gone is recorded with no body and no workplace", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    postings: [
      posting({
        key: "workday/acme-wd::swe1",
        company: "Acme",
        platform: "workday",
        board: "acme-wd",
        title: "Staff Backend Engineer",
        workplace: "remote",
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async () => null,
    },
  };

  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 1);

  const [judged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(judged?.body, null);
  assert.equal(judged?.workplace, null);
});

test("judgeAll: a re-judge that fetches nothing keeps the stored workplace out of its verdict", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      postings: [
        posting({
          key: "workday/acme-wd::swe1",
          company: "Acme",
          platform: "workday",
          board: "acme-wd",
          title: "Staff Backend Engineer",
          body: "Staff Backend Engineer. This role is in-office 5 days a week. The salary range is $184,500.00 to $251,900.00.",
          comp_high: 251_900,
          workplace: "remote",
          kept: true,
          judged_with: "2026-09-01T00:00:00Z",
        }),
      ],
      criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
    }),
  );
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async () => {
        assert.fail("a posting with a stored body is not fetched again");
      },
    },
  };

  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 1);

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "workday/acme-wd::swe1");
  assert.ok(written);
  assert.equal("workplace" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.workplace, "remote");
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
  assert.equal(row?.kept, true, "the stored word still decides remote on the re-judge");
});

test("ingest: a two-phase posting is refused on the comp its body states", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000 })],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReader(
      "Staff Backend Engineer. Remote in the US. The salary range is $70,000 - $90,000.",
    ),
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.comp_high, 90_000);
  assert.equal(row?.evidence["comp_floor"], "comp_high 90000 is below the floor 120000");
});

test("ingest: a two-phase posting refused on the floor keeps its comp and its floor reason across a criteria edit", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000, updated_at: "2026-09-14T00:00:00Z" })],
  });
  let bodyCalls = 0;
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async (_board, id) => {
        bodyCalls += 1;
        return listing(id, {
          body: "Staff Backend Engineer. Remote in the US. The salary range is $70,000 - $90,000.",
        });
      },
    },
  };

  await ingest(store, readers);
  await judgeAll(store, readers);

  const [first] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(first?.comp_low, 70_000);
  assert.equal(first?.comp_high, 90_000);
  assert.equal(first?.kept, false);
  assert.equal(first?.evidence["comp_floor"], "comp_high 90000 is below the floor 120000");

  // Now fails the floor on its stored comp, so its body is never read; the
  // verdict must carry that comp back rather than write null over it.
  const edited = await store.update("criteria", "1", { updated_at: "2026-09-15T00:00:00Z" });
  assert.equal(edited.ok, true);
  await judgeAll(store, readers);

  const [second] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(second?.comp_low, 70_000);
  assert.equal(second?.comp_high, 90_000);
  assert.equal(second?.kept, false);
  assert.equal(second?.evidence["comp_floor"], "comp_high 90000 is below the floor 120000");
  assert.equal(second?.judged_with, "2026-09-15T00:00:00Z");
  assert.equal(bodyCalls, 1);
});

// The stored band is what the detail read wrote, prose or fields; a
// re-judge that reads only the stored body does not re-parse the prose
// over it, even when the prose states a band the row lacks.
test("ingest: a two-phase posting with a stored body and no comp keeps null on re-judge, not the prose's band", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    postings: [
      posting({
        key: "Acme::swe1",
        company: "Acme",
        platform: "workday",
        board: "acme-wd",
        title: "Staff Backend Engineer",
        body: "Staff Backend Engineer. Remote in the US. The salary range is $184,500.00 to $251,900.00.",
        judged_with: "2026-09-01T00:00:00Z",
      }),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async () => {
        assert.fail("a stored body must not be refetched to read its comp");
      },
    },
  };

  // Before the stored posting's last_seen, so the board's fresh last_read
  // does not judge it gone: this run is testing the re-judge, not gone.
  await ingest(store, readers, { now: () => "2019-01-01T00:00:00.000Z" });
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "Acme::swe1" });
  assert.equal(row?.comp_low, null);
  assert.equal(row?.comp_high, null);
});

test("ingest: never fetches a body for a posting the listing criteria dropped", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  let bodyCalled = false;
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      // A level word but no role word: dropped before a body is worth fetching.
      list: async () => [listing("eng1", { title: "Staff Engineer" })],
      body: async () => {
        bodyCalled = true;
        return null;
      },
    },
  };

  await ingest(store, readers);
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  assert.equal(bodyCalled, false);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::eng1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, null);
});

// A two-phase board whose only comp is in the body, listing a numbered
// title: without the fetch gate the body is never read and the row never
// recovers.
function numberedTwoPhaseReader(
  title: string,
  body: string,
): {
  readonly reader: Reader;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    reader: {
      platform: "workday",
      list: async () => [listing("swe6", { title })],
      body: async (_board, id) => {
        calls += 1;
        return listing(id, { body });
      },
    },
    calls: () => calls,
  };
}

test("ingest: a numbered title with no stored comp on a two-phase board is judged on the comp its body states", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000 })],
  });
  const fetches = numberedTwoPhaseReader(
    "Backend Engineer 6",
    "Backend Engineer 6. Remote in the US. The salary range is $300,000 - $400,000.",
  );
  const readers: Partial<Record<Platform, Reader>> = { workday: fetches.reader };

  await ingest(store, readers);
  await judgeAll(store, readers);

  assert.equal(fetches.calls(), 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe6" });
  assert.equal(row?.comp_high, 400_000);
  assert.equal(row?.kept, true);
  assert.equal(row?.evidence["level"], 'title carries a bare number "6" used as a level');
});

test("ingest: a two-phase title with no level marker and no engineering word has no body fetched", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria({ comp_floor: 120_000 })],
  });
  // Pay only settles a level-less title that names engineering work, so the
  // gate stays shut. A title with a role word but no engineering word.
  const fetches = numberedTwoPhaseReader(
    "Backend Program Manager",
    "Backend Program Manager. Remote in the US. The salary range is $300,000 - $400,000.",
  );
  const readers: Partial<Record<Platform, Reader>> = { workday: fetches.reader };

  await ingest(store, readers);
  await judgeAll(store, readers);

  assert.equal(fetches.calls(), 0);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe6" });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, null);
  assert.equal(row?.evidence["level"], "title carries no level word or marker");
});

test("ingest: a criteria change alone makes an already-judged posting need judging again, with no refetch", async () => {
  let bodyCalled = false;
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [
      posting({
        key: "Acme::swe1",
        company: "Acme",
        title: "Staff Backend Engineer",
        body: "This is a fully remote position open to candidates anywhere in the US.",
        kept: true,
        judged_with: "2026-09-01T00:00:00Z",
      }),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [],
      body: async () => {
        bodyCalled = true;
        return null;
      },
    },
  };

  await ingest(store, readers);
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  assert.equal(bodyCalled, false);

  const [row] = await store.select<Posting>("postings", { key: "Acme::swe1" });
  assert.equal(row?.judged_with, "2026-09-14T00:00:00Z");
  assert.equal(row?.body, "This is a fully remote position open to candidates anywhere in the US.");
});

test("ingest: a failed body fetch is an error, leaving the posting for the next run's judging", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async () => {
        throw new Error("board unavailable");
      },
    },
  };

  await ingest(store, readers);
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 0);
  assert.equal(judging.errors.length, 1);
  assert.match(judging.errors[0] ?? "", /judge body fetch: board unavailable/);

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::swe1" });
  assert.equal(row?.judged_with, null);
  assert.equal(row?.kept, null);
});

test("ingest: a listing carrying a body stores it, and one without keeps the stored body", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-gh::already",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-gh",
        body: "fetched by the judging pass",
      }),
    ],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("fresh", { body: "the board handed this over" }),
        // The body the judging pass fetched must survive the re-list.
        listing("already", { body: null }),
      ],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z" });

  const [fresh] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::fresh" });
  assert.equal(fresh?.body, "the board handed this over");
  const [kept] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::already" });
  assert.equal(kept?.body, "fetched by the judging pass");
});

test("ingest: the judging pass reads every posting without its body", async () => {
  const { store, selects } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      // No role word, so no body is asked for.
      list: async () => [listing("eng1", { title: "Staff Engineer" })],
    },
  };

  await ingest(store, readers);
  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 1);

  const sweeps = selects.filter((call) => call.table === "postings" && call.eq === undefined);
  // Two sweeps: ingest's own `key, body_hash` read and the judging pass's;
  // neither reads by key.
  assert.equal(sweeps.length, 2, "ingest and judging each sweep the table once");
  const judgingSweep = sweeps.find((call) => call.columns?.includes("judged_with"));
  // `body` is not on the list, which is the point of the sweep.
  assert.deepEqual(judgingSweep?.columns, [
    "key",
    "company",
    "platform",
    "board",
    "title",
    "location",
    "posted_at",
    "comp_high",
    "comp_low",
    "workplace",
    "last_seen",
    "first_seen",
    "judged_with",
    "kept",
    "reasons",
  ]);
  assert.deepEqual(
    selects.filter((call) => call.table === "postings" && call.eq !== undefined),
    [],
    "a posting the listing criteria dropped costs no body read at all",
  );
});

test("ingest: reads a stored body only for the postings the listing criteria kept", async () => {
  const { store, selects } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
      postings: [
        posting({
          key: "Acme::swe1",
          company: "Acme",
          title: "Staff Backend Engineer",
          body: "This is a fully remote position open to candidates anywhere in the US.",
        }),
        posting({ key: "Acme::eng1", company: "Acme", title: "Staff Engineer" }),
      ],
      criteria: [criteria()],
    }),
  );

  let bodyCalled = false;
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [],
      body: async () => {
        bodyCalled = true;
        return null;
      },
    },
  };

  // Before the stored postings' last_seen, so the board's fresh last_read
  // does not judge them gone: this run is testing the body select, not gone.
  await ingest(store, readers, { now: () => "2019-01-01T00:00:00.000Z" });
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 2);
  assert.equal(bodyCalled, false, "a stored body must not be refetched from the board");
  assert.deepEqual(
    selects
      .filter((call) => call.table === "postings" && call.eq !== undefined)
      .map((call) => [call.eq?.["key"], call.columns]),
    [["Acme::swe1", ["body"]]],
  );
});

test("ingest: the judging pass writes the verdict columns with key, company and last_seen, and a body only when it fetched one", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [
        listing("swe1", { title: "Staff Backend Engineer" }),
        listing("eng1", { title: "Staff Engineer" }),
      ],
      body: async (_board, id) =>
        listing(id, { body: "This is a fully remote position, open to anyone in the US." }),
    },
  };

  await ingest(store, readers);
  const baseline = upserts.length;
  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 2);

  const written = new Map(
    upserts
      .slice(baseline)
      .flatMap((call) => call.rows)
      .map((row) => [(row as Posting).key, Object.keys(row).sort()]),
  );
  // `comp_low`/`comp_high` travel on every verdict; only `body`/`workplace`
  // vary with whether the judging pass fetched a detail.
  assert.deepEqual(written.get("workday/acme-wd::eng1"), [
    "comp_high",
    "comp_low",
    "company",
    "evidence",
    "judged_with",
    "kept",
    "key",
    "last_seen",
    "reasons",
  ]);
  assert.deepEqual(written.get("workday/acme-wd::swe1"), [
    "body",
    "comp_high",
    "comp_low",
    "company",
    "evidence",
    "judged_with",
    "kept",
    "key",
    "last_seen",
    "reasons",
    "workplace",
  ]);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, true);
  assert.equal(
    row?.title,
    "Staff Backend Engineer",
    "a verdict write must not touch a listing column",
  );
});

test("judgeAll: verdicts are written in batches, not one write per posting", async () => {
  const { store, upserts, updates } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      // No role word, so no body is fetched: one flush group, five rows.
      list: async () => [
        listing("eng1", { title: "Staff Engineer" }),
        listing("eng2", { title: "Staff Engineer" }),
        listing("eng3", { title: "Staff Engineer" }),
        listing("eng4", { title: "Staff Engineer" }),
        listing("eng5", { title: "Staff Engineer" }),
      ],
    },
  };

  await ingest(store, readers);
  const baseline = upserts.length;
  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 5);

  const postingUpserts = upserts.slice(baseline).filter((call) => call.table === "postings");
  assert.equal(postingUpserts.length, 1, "one flush for five postings");
  assert.equal(postingUpserts[0]?.rows.length, 5);
  assert.deepEqual(updates, []);
});

test("judgeAll: a refused flush is one error line, not a thrown run, and its rows keep judged_with null", async () => {
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("swe1", { title: "Staff Backend Engineer" }),
        listing("eng1", { title: "Staff Engineer" }),
      ],
      body: async (_board, id) =>
        listing(id, { body: "This is a fully remote position, open to anyone in the US." }),
    },
  };

  await ingest(inner, readers);

  // The judging pass sends one upsert for its one flush, mixing swe1 (a
  // body fetched) and eng1 (none); the adapter's own grouping is not under
  // test here, only that ingest.ts treats the flush as a single write.
  const store: Store = {
    select: (table, eq, columns) => inner.select(table, eq, columns),
    upsert: () => Promise.reject(new Error("boom")),
    update: (table, key, patch) => inner.update(table, key, patch),
    delete: (table, keys) => inner.delete(table, keys),
  };

  const judging = await judgeAll(store, readers);

  assert.equal(judging.errors.length, 1);
  assert.match(judging.errors[0] ?? "", /writing 2 verdicts: boom/);
  assert.equal(judging.judged, 0);

  const [swe1] = await inner.select<Posting>("postings", { key: "greenhouse/acme-gh::swe1" });
  const [eng1] = await inner.select<Posting>("postings", { key: "greenhouse/acme-gh::eng1" });
  assert.equal(swe1?.judged_with, null, "a failed flush leaves every posting in it untouched");
  assert.equal(eng1?.judged_with, null, "a failed flush leaves every posting in it untouched");
});

test("judgeAll: a flush mid-loop empties the buffer and the remainder lands in a second flush", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
      criteria: [criteria()],
    }),
  );

  // One over the flush size, so the buffer flushes once in the loop and
  // once at the end; no role word, so every verdict is in one column set.
  const ids = Array.from({ length: 201 }, (_, i) => `eng${i + 1}`);
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => ids.map((id) => listing(id, { title: "Staff Engineer" })),
    },
  };

  await ingest(store, readers);
  const baseline = upserts.length;
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 201);
  assert.deepEqual(judging.errors, []);
  const postingUpserts = upserts.slice(baseline).filter((call) => call.table === "postings");
  assert.deepEqual(
    postingUpserts.map((call) => call.rows.length),
    [200, 1],
  );

  const stored = await store.select<Posting>("postings");
  assert.equal(stored.length, 201);
  for (const row of stored) {
    assert.equal(row.judged_with, criteria().updated_at, `${row.key} was judged`);
  }
});

// The age verdict moves with no edit anywhere, and only the rows whose
// verdict has actually moved are picked up.
test("judgeAll: a kept posting that has aged past the max is re-judged; one still within it is not", async () => {
  const kept = (key: string, postedAt: string): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      posted_at: postedAt,
      body: "This is a fully remote position open to candidates anywhere in the US.",
      kept: true,
      judged_with: "2026-09-14T00:00:00Z",
    });
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [
      kept("Acme::old1", "2026-06-09T00:00:00Z"),
      kept("Acme::new1", "2026-08-18T00:00:00Z"),
    ],
    criteria: [criteria({ max_age_days: 90, updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {}, { now: () => "2026-09-17T00:00:00.000Z" });

  assert.equal(judging.judged, 1, "only the posting whose age verdict moved is re-judged");
  const [aged] = await store.select<Posting>("postings", { key: "Acme::old1" });
  assert.equal(aged?.kept, false);
  assert.equal(aged?.evidence["age"], "posted 100 days ago, past the max age 90");
  const [recent] = await store.select<Posting>("postings", { key: "Acme::new1" });
  assert.equal(recent?.kept, true);
  assert.deepEqual(recent?.evidence, {}, "a posting still within the max age is left alone");
});

// A kept posting whose board has been read since it was last seen was
// listed without it; a posting seen at or after the read is untouched.
test("judgeAll: a kept posting last seen before its board's last read is dropped as gone; the others are untouched", async () => {
  const seenOn = (key: string, day: string): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      last_seen: `${day}T06:00:00.000Z`,
      kept: true,
      judged_with: "2026-09-14T00:00:00Z",
    });
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [{ platform: "greenhouse", id: "board", last_read: "2026-09-16T06:00:00.000Z" }],
      }),
    ],
    postings: [
      seenOn("Acme::oldest", "2026-09-15"),
      seenOn("Acme::middle", "2026-09-16"),
      seenOn("Acme::latest", "2026-09-17"),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 1, "only the posting unseen since the board's read is re-judged");
  const [oldest] = await store.select<Posting>("postings", { key: "Acme::oldest" });
  assert.equal(oldest?.kept, false);
  assert.equal(oldest?.evidence["gone"], "last seen 2026-09-15, board read 2026-09-16 without it");
  const [middle] = await store.select<Posting>("postings", { key: "Acme::middle" });
  assert.equal(middle?.kept, true);
  assert.deepEqual(middle?.evidence, {}, "a posting seen at the board's read is left alone");
  const [latest] = await store.select<Posting>("postings", { key: "Acme::latest" });
  assert.equal(latest?.kept, true);
  assert.deepEqual(latest?.evidence, {});
});

// Without the reverse trigger a posting its board lists again stays gone
// until the next criteria edit.
test("judgeAll: a posting judged gone on one run and listed again on the next is judged back in", async () => {
  const seenOn = (key: string, day: string): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      last_seen: `${day}T06:00:00.000Z`,
      body: "This is a fully remote position open to candidates anywhere in the US.",
      kept: true,
      judged_with: "2026-09-14T00:00:00Z",
    });
  // Dropped on its level two runs back: the row a fresh `last_seen` must
  // not pull back in.
  const levelOut = posting({
    key: "Acme::junior",
    company: "Acme",
    title: "Backend Engineer",
    last_seen: "2026-09-16T06:00:00.000Z",
    kept: false,
    reasons: [{ criterion: "level", verdict: "out", detail: "no level word in the title" }],
    evidence: { level: "no level word in the title" },
    judged_with: "2026-09-14T00:00:00Z",
  });
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [{ platform: "greenhouse", id: "board", last_read: "2026-09-16T06:00:00.000Z" }],
      }),
    ],
    postings: [
      seenOn("Acme::lapsed", "2026-09-15"),
      seenOn("Acme::steady", "2026-09-17"),
      levelOut,
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const firstRun = await judgeAll(store, {});
  assert.equal(firstRun.judged, 1);
  const [gone] = await store.select<Posting>("postings", { key: "Acme::lapsed" });
  assert.equal(gone?.kept, false);
  assert.equal(gone?.evidence["gone"], "last seen 2026-09-15, board read 2026-09-16 without it");

  // The partial rows `ingest` writes on a re-list, and the board read it
  // records once they land.
  await store.upsert("postings", [
    { key: "Acme::lapsed", company: "Acme", last_seen: "2026-09-18T06:00:01.000Z" },
    { key: "Acme::steady", company: "Acme", last_seen: "2026-09-18T06:00:01.000Z" },
  ]);
  await store.upsert("companies", [
    company("Acme", {
      boards: [{ platform: "greenhouse", id: "board", last_read: "2026-09-18T06:00:00.000Z" }],
    }),
  ]);

  const secondRun = await judgeAll(store, {});
  assert.equal(secondRun.judged, 1, "only the re-listed gone posting is judged again");
  const [back] = await store.select<Posting>("postings", { key: "Acme::lapsed" });
  assert.equal(back?.kept, true);
  assert.equal(back?.evidence["gone"], "listed at the board's last read 2026-09-18");
  const [steady] = await store.select<Posting>("postings", { key: "Acme::steady" });
  assert.deepEqual(steady?.evidence, {}, "a kept posting seen every run is never re-judged");
  const [junior] = await store.select<Posting>("postings", { key: "Acme::junior" });
  assert.equal(junior?.kept, false, "a posting dropped on another criterion stays dropped");
});

test("judgeAll: a board with no recorded read marks nothing gone", async () => {
  const seenLongAgo = (key: string): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      last_seen: "2020-01-01T00:00:00.000Z",
      body: "This is a fully remote position open to candidates anywhere in the US.",
      kept: true,
      judged_with: "2026-09-01T00:00:00Z", // stale, so this run still judges it
    });
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [seenLongAgo("Acme::a"), seenLongAgo("Acme::b")],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 2);
  const [a] = await store.select<Posting>("postings", { key: "Acme::a" });
  assert.equal(a?.kept, true);
  assert.equal(a?.evidence["gone"], "board has no recorded read");
});

// A gone-out row's board with no read on record: the morning's read failed,
// or a first 404 marked it, or the read write was refused. Nothing was
// learned, so nothing moves; only a read that lists the row again does.
const goneOut = (key: string, overrides: Partial<Posting> = {}): Posting =>
  posting({
    key,
    company: "Acme",
    title: "Staff Backend Engineer",
    comp_high: 250_000,
    body: "This is a fully remote position open to candidates anywhere in the US.",
    last_seen: "2026-09-10T06:00:00.000Z",
    kept: false,
    reasons: [
      {
        criterion: "gone",
        verdict: "out",
        detail: "last seen 2026-09-10, board read 2026-09-11 without it",
      },
    ],
    evidence: { gone: "last seen 2026-09-10, board read 2026-09-11 without it" },
    judged_with: "2026-09-14T00:00:00Z",
    ...overrides,
  });

test("judgeAll: a gone posting on a watched board with no recorded read stays gone, unjudged", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [goneOut("Acme::a")],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 0);
  const [a] = await store.select<Posting>("postings", { key: "Acme::a" });
  assert.equal(a?.kept, false);
  assert.equal(a?.evidence["gone"], "last seen 2026-09-10, board read 2026-09-11 without it");
});

test("judgeAll: a gone posting whose board was removed from its company is judged out unwatched once, then left alone", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [] })],
    postings: [goneOut("Acme::a")],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const firstRun = await judgeAll(store, {});
  assert.equal(firstRun.judged, 1);
  const [a] = await store.select<Posting>("postings", { key: "Acme::a" });
  assert.equal(a?.kept, false);
  assert.equal(a?.evidence["unwatched"], "board greenhouse/board is no longer on Acme");
  assert.equal(a?.evidence["gone"], "board has no recorded read");

  const secondRun = await judgeAll(store, {});
  assert.equal(secondRun.judged, 0, "the unwatched verdict holds without another judging");
});

// One run, no grace: a board read without a posting judges it gone that
// run, and a board whose read fails judges nothing.
test("ingest then judgeAll: a posting the board stops listing is gone after one run; a failed read moves nothing", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const kept = (id: string): Listing =>
    listing(id, {
      title: "Staff Backend Engineer",
      compHigh: 250_000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
    });
  let listings: () => Listing[] = () => [kept("a"), kept("b")];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => listings() },
  };
  const run = async (day: string): Promise<readonly string[]> => {
    const now = tickingClockFrom(day);
    const listed = await ingest(store, readers, { now });
    const judged = await judgeAll(store, readers, { now });
    return [...listed.errors, ...judged.errors];
  };
  const verdicts = async (): Promise<readonly (boolean | null)[]> => {
    const [a] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::a" });
    const [b] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::b" });
    return [a?.kept ?? null, b?.kept ?? null];
  };

  assert.deepEqual(await run("2026-09-15"), []);
  assert.deepEqual(await verdicts(), [true, true]);

  listings = () => [kept("a")];
  assert.deepEqual(await run("2026-09-16"), []);
  assert.deepEqual(await verdicts(), [true, false]);
  const [gone] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::b" });
  assert.equal(gone?.evidence["gone"], "last seen 2026-09-15, board read 2026-09-16 without it");

  listings = () => {
    throw new HttpError(500, "HTTP 500");
  };
  assert.deepEqual(await run("2026-09-17"), ["Acme greenhouse/acme-gh: HTTP 500"]);
  assert.deepEqual(await verdicts(), [true, false]);
  const [board] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(board?.boards[0]?.last_read, "2026-09-16T06:00:00.000Z");
});

test("judgeAll: a kept posting whose company became an alias is judged out unwatched; a status survives the same way", async () => {
  const kept = (key: string, overrides: Partial<Posting> = {}): Posting =>
    posting({
      key,
      company: "Acme",
      platform: "greenhouse",
      board: "acme-gh",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      kept: true,
      judged_with: "2026-09-14T00:00:00Z",
      ...overrides,
    });
  const store = memoryStore({
    companies: [
      company("Acme", {
        state: "alias",
        alias_of: "Acme Inc",
        boards: [{ platform: "greenhouse", id: "acme-gh" }],
      }),
    ],
    postings: [
      kept("Acme::swe1"),
      kept("Acme::swe2", { status: "applied", applied_at: "2026-09-10T00:00:00Z" }),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 2, "the company's state alone moves both postings");
  const [row] = await store.select<Posting>("postings", { key: "Acme::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.evidence["unwatched"], "company Acme is an alias of Acme Inc");

  const [statusRow] = await store.select<Posting>("postings", { key: "Acme::swe2" });
  assert.equal(statusRow?.kept, false);
  assert.equal(statusRow?.evidence["unwatched"], "company Acme is an alias of Acme Inc");
  assert.equal(statusRow?.status, "applied", "the processor never changes a posting's status");
});

// A real six-title shape on one ashby board is one req, except the
// parenthetical row: a parenthetical is not a level word, so "Founding
// Product Engineer (YC experience)" keeps its own key. Two kept, four out;
// the representative is "Lead Product Engineer", the latest seen that the
// level criterion admits.
test("judgeAll: the six-title Pragmatike shape keeps two and marks four out as duplicates", async () => {
  const pragmatike = (key: string, title: string, firstSeen: string): Posting =>
    posting({
      key,
      company: "Pragmatike",
      platform: "ashby",
      board: "pragmatike",
      title,
      location: "San Francisco",
      comp_high: 400_000,
      posted_at: "2026-08-14",
      first_seen: firstSeen,
      last_seen: "2026-09-17T00:00:00.000Z",
      body: "This is a fully remote position open to candidates anywhere in the US.",
    });
  const store = memoryStore({
    companies: [company("Pragmatike", { boards: [{ platform: "ashby", id: "pragmatike" }] })],
    postings: [
      pragmatike("Pragmatike::1", "Staff Founding Product Engineer", "2026-08-14T00:00:00.000Z"),
      pragmatike(
        "Pragmatike::2",
        "Founding Product Engineer (YC experience)",
        "2026-08-14T00:00:01.000Z",
      ),
      pragmatike("Pragmatike::3", "Senior Founding Product Engineer", "2026-08-14T00:00:02.000Z"),
      pragmatike(
        "Pragmatike::4",
        "Principal Founding Product Engineer",
        "2026-08-14T00:00:03.000Z",
      ),
      pragmatike(
        "Pragmatike::5",
        "Principal Founding Product Engineer",
        "2026-08-14T00:00:04.000Z",
      ),
      pragmatike("Pragmatike::6", "Lead Product Engineer", "2026-08-14T00:00:05.000Z"),
    ],
    criteria: [criteria({ role_words: ["product"] })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 6);
  const rows = await Promise.all(
    ["1", "2", "3", "4", "5", "6"].map(
      async (id) => (await store.select<Posting>("postings", { key: `Pragmatike::${id}` }))[0],
    ),
  );
  const kept = rows.filter((row) => row?.kept === true);
  const out = rows.filter((row) => row?.kept === false);
  assert.equal(kept.length, 2, "the parenthetical row and the five-title group's representative");
  assert.equal(out.length, 4, "the rest of the five-title group are out as its duplicates");
  assert.deepEqual(kept.map((row) => row?.key).sort(), ["Pragmatike::2", "Pragmatike::6"]);
  for (const row of out) {
    assert.equal(
      row?.evidence["duplicate"],
      "duplicate of Pragmatike::6: same board, date, band and place, title differs only by level words; that posting is the latest the level criterion admits",
    );
  }
});

// A representative must not hold its group once it is gone, or every
// duplicate at its key is out forever. `Pragmatike::2`'s stored `duplicate`
// reason survives one run where nothing moves, then clears once
// `Pragmatike::1` falls behind.
test("judgeAll: a duplicate-out row is judged in once its representative twin goes gone", async () => {
  const pragmatike = (
    key: string,
    title: string,
    lastSeenDay: string,
    extra: Partial<Posting>,
  ): Posting =>
    posting({
      key,
      company: "Pragmatike",
      platform: "ashby",
      board: "pragmatike",
      title,
      location: "San Francisco",
      comp_high: 400_000,
      posted_at: "2026-08-14",
      last_seen: `${lastSeenDay}T00:00:00Z`,
      body: "This is a fully remote position open to candidates anywhere in the US.",
      judged_with: "2026-09-14T00:00:00Z",
      ...extra,
    });
  const DUPLICATE_OUT = {
    criterion: "duplicate",
    verdict: "out",
    detail:
      "duplicate of Pragmatike::1: same board, date, band and place, title differs only by level words; that posting is the latest the level criterion admits",
  } as const;

  // The representative: the later `first_seen`.
  const representative = pragmatike(
    "Pragmatike::1",
    "Staff Founding Product Engineer",
    "2026-09-16",
    {
      first_seen: "2026-08-15T00:00:00.000Z",
      kept: true,
      reasons: [],
      evidence: {},
    },
  );
  // The duplicate: represents the key only once the row above is gone.
  const duplicate = pragmatike("Pragmatike::2", "Lead Product Engineer", "2026-09-16", {
    first_seen: "2026-08-14T00:00:00.000Z",
    kept: false,
    reasons: [DUPLICATE_OUT],
    evidence: { duplicate: DUPLICATE_OUT.detail },
  });
  const pragmatikeBoard = (lastRead: string): Company =>
    company("Pragmatike", {
      boards: [{ platform: "ashby", id: "pragmatike", last_read: lastRead }],
    });
  const store = memoryStore({
    companies: [pragmatikeBoard("2026-09-16T00:00:00Z")],
    postings: [representative, duplicate],
    criteria: [criteria({ role_words: ["product"], updated_at: "2026-09-14T00:00:00Z" })],
  });

  const firstRun = await judgeAll(store, {});
  assert.equal(firstRun.judged, 0, "the representative row was seen at the board's last read");
  const [stillRepresentative] = await store.select<Posting>("postings", { key: "Pragmatike::1" });
  assert.equal(stillRepresentative?.kept, true);
  const [stillDuplicate] = await store.select<Posting>("postings", { key: "Pragmatike::2" });
  assert.equal(stillDuplicate?.kept, false);

  // The board is read again and lists the duplicate but not the
  // representative: the shape `goneBy` reads as gone.
  await store.upsert("postings", [
    { key: "Pragmatike::2", company: "Pragmatike", last_seen: "2026-09-18T00:00:01Z" },
  ]);
  await store.upsert("companies", [pragmatikeBoard("2026-09-18T00:00:00Z")]);

  await judgeAll(store, {});
  const [gone] = await store.select<Posting>("postings", { key: "Pragmatike::1" });
  assert.equal(gone?.kept, false, "the representative row is now gone");
  const [freed] = await store.select<Posting>("postings", { key: "Pragmatike::2" });
  assert.equal(freed?.kept, true, "the duplicate-out row is judged in once its twin is gone");
  assert.equal(
    freed?.evidence["duplicate"],
    "no later, level-admitted posting shares its board, date, band, place and title",
  );
});
