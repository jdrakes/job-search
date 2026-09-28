import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Listing, Reader } from "../src/ats/ats.ts";
import { listExitCode } from "../src/daily.ts";
import { boardsToRead, ingest, judgeAll, type IngestResult } from "../src/ingest.ts";
import { HttpError } from "../src/net/http.ts";
import type { Candidate, Company, Criteria, Platform, Posting, Table } from "../src/schema.ts";
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

// Every run needs a day; most tests read every board, as a Monday does.
// A local noon avoids any midnight-boundary flakiness from the runner's
// time zone; 2026-09-28 is a Monday, 2026-09-29 the Tuesday right after it.
const MONDAY = new Date("2026-09-28T12:00:00");
const TUESDAY = new Date("2026-09-29T12:00:00");

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    boards: [],
    reason: null,
    dropped_at: null,
    peers_searched_at: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "id">): Candidate {
  return {
    name: null,
    url: null,
    origin: "ui",
    evidence: null,
    added_at: "2026-09-20T00:00:00.000Z",
    outcome: null,
    outcome_at: null,
    company: null,
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

// A listing whose title and place every `criteria()` passes: since #287
// nothing else is stored. The id in the title keeps two such postings from
// reading as duplicates of each other.
function admitted(id: string, overrides: Partial<Listing> = {}): Listing {
  return listing(id, { title: `Staff Backend Engineer ${id}`, ...overrides });
}

// Stored, and dropped by the listing criteria on its pay alone: its title and
// place pass, and its band sits below `criteria()`'s floor. Stated on the
// listing, so a two-phase board has no reason to fetch its detail either.
function belowFloor(id: string): Listing {
  return admitted(id, { compLow: 50_000, compHigh: 60_000 });
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
    full_read_at: "2026-09-14T00:00:00Z",
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
    greenhouse: { platform: "greenhouse", list: async (board) => [admitted(`${board.id}-1`)] },
    lever: { platform: "lever", list: async (board) => [admitted(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers, { today: MONDAY });

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
    greenhouse: { platform: "greenhouse", list: async () => [admitted("4123456")] },
  };

  const result = await ingest(store, readers, { today: MONDAY });

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
    lever: { platform: "lever", list: async (board) => [admitted(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers, { today: MONDAY });

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

// Breaks if ingest goes back to removing the board itself: the removal is
// discovery's (`unbind`, discover.ts).
test("ingest: a board that 404s is an error line and reported gone, and its company keeps it", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = { greenhouse: goneReader("greenhouse", 404) };

  const result = await ingest(store, readers, { today: MONDAY });

  assert.deepEqual(result.gone, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
  ]);
  assert.deepEqual(result.errors, ["Acme greenhouse/acme-gh: HTTP 404"]);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme-gh" }]);
});

test("ingest: a board answering 429 is an error line every run and is never removed", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = { greenhouse: goneReader("greenhouse", 429) };

  await ingest(store, readers, { today: MONDAY });
  const result = await ingest(store, readers, { today: MONDAY });

  assert.deepEqual(result.errors, ["Acme greenhouse/acme-gh: HTTP 429"]);
  assert.deepEqual(result.gone, []);
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme-gh" }]);
});

test("ingest: a workday board answering 400 is reported gone; a greenhouse board answering 400 is not", async () => {
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

  const result = await ingest(store, readers, { today: MONDAY });

  assert.deepEqual(result.gone, [
    { company: "Acme", board: { platform: "workday", id: "acme/site" } },
  ]);
});

// Breaks if only one of a company's gone boards is reported, or if the
// company's name is reported as a label to be parsed back.
test("ingest: every board that answered gone this run is reported with its company's full name", async () => {
  const store = memoryStore({
    companies: [
      company("Wellspring Health", {
        boards: [
          { platform: "greenhouse", id: "wellspring" },
          { platform: "lever", id: "wellspring" },
        ],
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: goneReader("greenhouse", 404),
    lever: goneReader("lever", 404),
  };

  const result = await ingest(store, readers, { today: MONDAY });

  assert.deepEqual(result.gone, [
    { company: "Wellspring Health", board: { platform: "greenhouse", id: "wellspring" } },
    { company: "Wellspring Health", board: { platform: "lever", id: "wellspring" } },
  ]);
});

// Breaks if the list phase writes `companies` again for any answer a board
// gives: gone, a failure, or a listing (the old per-run `last_read`).
test("ingest: a run with a gone, a failing and a listing board makes no companies write", async () => {
  const before = [
    company("Acme", {
      boards: [
        { platform: "greenhouse", id: "acme-gh" },
        { platform: "lever", id: "acme-lv" },
      ],
    }),
    company("Bolt", { boards: [{ platform: "ashby", id: "bolt" }] }),
  ];
  const { store, upserts, updates } = recording(
    memoryStore({ companies: before, criteria: [criteria()] }),
  );
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: goneReader("greenhouse", 404),
    lever: { platform: "lever", list: async (board) => [admitted(`${board.id}-1`)] },
    ashby: goneReader("ashby", 500),
  };

  const result = await ingest(store, readers, {
    now: () => "2026-09-16T06:00:00.000Z",
    today: MONDAY,
  });

  assert.deepEqual(result.gone, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
  ]);
  assert.equal(result.recorded, 1);
  assert.deepEqual(
    upserts.map((call) => call.table),
    ["postings"],
  );
  assert.deepEqual(updates, []);
  assert.deepEqual(await store.select<Company>("companies"), before);
});

// Seconds from 06:00 on the day, one per call: the run's first reading is
// the `gone_at` of any posting it marks gone.
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

test("ingest: every row a run lists is recorded not gone", async () => {
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
    greenhouse: { platform: "greenhouse", list: async () => [admitted("1"), admitted("2")] },
    lever: { platform: "lever", list: async () => [admitted("3")] },
  };

  await ingest(store, readers, { now: tickingClock(), today: MONDAY });

  const postings = await store.select<Posting>("postings");
  assert.deepEqual(
    postings.map((posting) => [posting.key, posting.gone_at]),
    [
      ["greenhouse/acme-gh::1", null],
      ["greenhouse/acme-gh::2", null],
      ["lever/acme-lv::3", null],
    ],
  );
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

  const result = await ingest(store, readers, { today: MONDAY });

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
    greenhouse: { platform: "greenhouse", list: async (board) => [admitted(`${board.id}-1`)] },
    lever: { platform: "lever", list: async (board) => [admitted(`${board.id}-1`)] },
  };

  const result = await ingest(store, readers, { today: MONDAY });

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
    criteria: [criteria()],
  });

  const result = await ingest(store, {}, { today: MONDAY });

  assert.equal(result.companies, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /no reader for "workday"/);
  assert.equal(result.recorded, 0);
});

test("ingest: a re-listed posting keeps its first_seen and updates its fields", async () => {
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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: "greenhouse/acme-gh::123" });
  assert.ok(row);
  assert.equal(row?.first_seen, "2020-01-01T00:00:00.000Z");
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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

  const written = upserts.filter((call) => call.table === "postings").flatMap((call) => call.rows);
  assert.equal(written.length, 1);
  // No `comp_low`/`comp_high` either, and no `workplace`: nothing to read a
  // comp from, and no body or word to state a workplace.
  assert.deepEqual(Object.keys(written[0] ?? {}).sort(), [
    "board",
    "company",
    "key",
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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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
        reasons: ["level"],
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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });
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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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
          title: "Staff Backend Engineer",
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
      list: async () => [listing("swe4", { title: "Staff Backend Engineer", workplace: "remote" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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
          title: "Staff Backend Engineer",
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
      list: async () => [listing("swe5", { title: "Staff Backend Engineer", workplace: "remote" })],
    },
  };

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-17T12:00:00.000Z", today: MONDAY });

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

  await ingest(store, readers, { today: MONDAY });

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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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
      if (
        table === "postings" &&
        columns?.join(",") ===
          "key,company,platform,title,url,location,posted_at,body_hash,comp_low,comp_high,workplace,kept,status,gone_at"
      ) {
        throw new Error("column postings.body_hash does not exist");
      }
      return inner.select<T>(table, eq, columns);
    },
  };
  const { store, upserts } = recording(failing);

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => [listing("123", { body: bodyText })] },
  };

  const result = await ingest(store, readers, {
    now: () => "2026-09-15T12:00:00.000Z",
    today: MONDAY,
  });

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

// Clears every criterion `judge()` can decide on the posting alone under
// `criteria()`: a role word, a level settled by pay above the floor, a
// remote body with no missing language.
const KEPT_BODY = "This is a fully remote position open to candidates anywhere in the US.";

function keptListing(id: string): Listing {
  return listing(id, {
    title: "Senior Backend Engineer",
    compLow: 250_000,
    compHigh: 300_000,
    body: KEPT_BODY,
  });
}

// The same listing, dropped by title alone: since #287 not stored at all
// unless acted on or kept.
const EXCLUDES_SENIOR = criteria({ excluded_title_words: ["senior"] });

// The same listing, dropped by its pay alone: its title and place pass, so
// it is stored, and `toRow` decides its body.
const FLOOR_ABOVE_PAY = criteria({ comp_floor: 400_000 });

function oneBoard(listings: Listing[]): Partial<Record<Platform, Reader>> {
  return { greenhouse: { platform: "greenhouse", list: async () => listings } };
}

const ACME = company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] });
const KEY = "greenhouse/acme-gh::b1";

// Breaks if `toRow` stores a body without judging it first.
test("ingest: a one-phase listing dropped on its pay is stored without its body", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [FLOOR_ABOVE_PAY] });

  const result = await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  assert.deepEqual(result.errors, []);
  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.title, "Senior Backend Engineer");
  assert.equal(row?.body, null);
  assert.equal(row?.body_hash, null);
});

// Breaks if a dropped listing leaves its columns out of the upsert (which
// keeps the old text) or if the unchanged-hash check runs before the
// decision.
test("ingest: a criteria edit that drops a stored one-phase posting clears its body", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [
      posting({
        key: KEY,
        company: "Acme",
        board: "acme-gh",
        body: KEPT_BODY,
        body_hash: hashOf(KEPT_BODY),
      }),
    ],
    criteria: [FLOOR_ABOVE_PAY],
  });

  await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, null);
  assert.equal(row?.body_hash, null);
});

// Breaks if the decision drops bodies `judge()` keeps.
test("ingest: a one-phase listing every criterion keeps is stored with its body", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [criteria()] });

  await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, KEPT_BODY);
  assert.equal(row?.body_hash, hashOf(KEPT_BODY));
});

// Breaks if the stored `status` is not read or not consulted.
test("ingest: a one-phase listing acted on keeps its body whatever the verdict", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [posting({ key: KEY, company: "Acme", board: "acme-gh", status: "applied" })],
    criteria: [EXCLUDES_SENIOR],
  });

  await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, KEPT_BODY);
  assert.equal(row?.body_hash, hashOf(KEPT_BODY));
});

// Breaks if a missing criteria row refuses the run, drops bodies, or adds
// an error line (which `daily.ts` would count as a failed board).
test("ingest: with no criteria row every listed body is stored with no error line", async () => {
  const store = memoryStore({ companies: [ACME] });

  const result = await ingest(store, oneBoard([listing("b1", { body: "any text" })]), {
    today: MONDAY,
  });

  assert.equal(result.recorded, 1);
  assert.deepEqual(result.errors, []);
  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, "any text");
});

// The listing criteria all pass; only the text says no (a missing
// language). The location affirms remote, so an empty body would pass the
// remote criterion too; no structured workplace, so the score-remote
// exemption does not keep this body either.
const TEXT_OUT_BODY = "5+ years of production Delphi required.";

// Breaks if `toRow` decides with the full `judge()`, or if `judgeAll`
// clears a one-phase body it read back from the store: either way the body
// is gone, `judgeAll`'s listing-only `wantsBody` still asks for it at the
// next re-judge, a one-phase board has nothing to refetch, and the empty
// text judges the posting back in. The second pass has no `ingest()`
// before it: a day the board's read failed, so `toRow` never relisted it.
test("ingest then judgeAll: a one-phase listing out only on a text criterion stays out across re-judges", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [criteria()] });
  const readers = oneBoard([
    listing("b1", {
      title: "Senior Backend Engineer",
      location: "Remote - US",
      compLow: 250_000,
      compHigh: 300_000,
      body: TEXT_OUT_BODY,
    }),
  ]);

  await ingest(store, readers, { today: MONDAY });
  const judging = await judgeAll(store, readers);

  assert.deepEqual(judging.errors, []);
  assert.equal(judging.judged, 1);
  const [first] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(first?.kept, false);
  assert.equal(first?.body, TEXT_OUT_BODY, "a one-phase body has no refetch, so it stays");
  assert.equal(first?.body_hash, hashOf(TEXT_OUT_BODY));

  const edited = await store.update("criteria", "1", { updated_at: "2026-09-15T00:00:00Z" });
  assert.equal(edited.ok, true);
  const rejudging = await judgeAll(store, readers);

  assert.deepEqual(rejudging.errors, []);
  assert.equal(rejudging.judged, 1);
  const [second] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(second?.judged_with, "2026-09-15T00:00:00Z");
  assert.equal(second?.kept, false);
  assert.deepEqual(second?.reasons, first?.reasons);
  assert.equal(second?.body, TEXT_OUT_BODY);
  assert.equal(second?.body_hash, hashOf(TEXT_OUT_BODY));
});

// Breaks if the `remote`/`onsite` exemption is missing from `toRow`:
// `scripts/score-remote.ts` reads these bodies whatever the verdict.
test("ingest: a one-phase listing dropped on its pay whose board states remote keeps its body", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [FLOOR_ABOVE_PAY] });

  await ingest(store, oneBoard([{ ...keptListing("b1"), workplace: "remote" }]), { today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, KEPT_BODY);
  assert.equal(row?.body_hash, hashOf(KEPT_BODY));
});

// Breaks if either `toRow` or `judgeAll` drops an `onsite` body on a
// verdict. Its title and place pass, so it is stored (#287); every other
// criterion drops it.
test("ingest then judgeAll: an onsite listing out on its pay and its text keeps its body", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [criteria()] });
  const body = "In our Wyoming office five days a week. Delphi and COBOL daily.";
  const readers = oneBoard([
    listing("b1", {
      title: "Staff Backend Engineer",
      compLow: 40_000,
      compHigh: 50_000,
      body,
      workplace: "onsite",
    }),
  ]);

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, body);
  assert.equal(row?.body_hash, hashOf(body));
});

// Breaks if a body landing where none was stored keeps the old verdict's
// `judged_with`, which was reached without the text.
test("ingest: a body stored where the row had none clears judged_with", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [
      posting({
        key: KEY,
        company: "Acme",
        board: "acme-gh",
        title: "Senior Backend Engineer",
        comp_low: 250_000,
        comp_high: 300_000,
        judged_with: "2026-09-14T00:00:00Z",
      }),
    ],
    criteria: [criteria()],
  });

  await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.body, KEPT_BODY);
  assert.equal(row?.judged_with, null);
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
        admitted("real"),
      ],
    },
  };

  const result = await ingest(store, readers, { today: MONDAY });

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

  const result = await ingest(store, readers, { today: MONDAY });

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

    const result = await ingest(store, readers, { today: MONDAY });

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

  await ingest(store, readers, { today: MONDAY });

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

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [judged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(judged?.comp_low, 184_500);
  assert.equal(judged?.comp_high, 251_900);
  assert.equal(judged?.kept, true);

  // The re-list carries neither body nor comp, so it must leave what the
  // judging pass wrote alone.
  await ingest(store, readers, { today: MONDAY });

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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.comp_low, 140_000);
  assert.equal(row?.comp_high, 165_000);
});

// The listing criteria already refuse a posting past the max age, so
// `wantsBody` never fetches its body; `judge()` alone makes the verdict
// age-only. Breaks if `judge()` stops short-circuiting on age (the reasons
// grow to the full sweep) or if `wantsBody` starts fetching (the reader fails).
test("judgeAll: a stored posting not acted on past the max age is judged on age alone, with no body fetch", async () => {
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
          posted_at: "2026-08-08T00:00:00.000Z", // 40 days before now
          status: null,
        }),
      ],
      criteria: [criteria({ max_age_days: 35 })],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async () => {
        assert.fail("a posting past the max age and not acted on must not fetch a body");
      },
    },
  };

  const judging = await judgeAll(store, readers, { now: () => "2026-09-17T00:00:00.000Z" });
  assert.equal(judging.judged, 1);

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === "workday/acme-wd::swe1");
  assert.ok(written);
  assert.equal("body" in (written as object), false);
  assert.equal("workplace" in (written as object), false);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.deepEqual(row?.reasons, ["age"]);
  assert.deepEqual(row?.evidence, {});
});

// Breaks if `judge()`'s age-only short-circuit stops checking `status`.
test("judgeAll: a stored posting acted on past the max age still runs the full judgment", async () => {
  const { store } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      postings: [
        posting({
          key: "workday/acme-wd::swe1",
          company: "Acme",
          platform: "workday",
          board: "acme-wd",
          title: "Staff Backend Engineer",
          posted_at: "2026-08-08T00:00:00.000Z", // 40 days before now
          status: "applied",
        }),
      ],
      criteria: [criteria({ max_age_days: 35 })],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async (_board, id) => listing(id, { body: "A fully remote role, open across the US." }),
    },
  };

  await judgeAll(store, readers, { now: () => "2026-09-17T00:00:00.000Z" });

  // Unchanged from today: the age criterion inside `judgeListing` already
  // drops an aged posting on its own, so the listing sweep's full nine
  // criteria run, not the age-alone short-circuit's one. A posting acted on
  // keeps the evidence of every criterion that ran.
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.ok((row?.reasons as unknown[]).includes("age"));
  assert.ok(Object.keys(row?.evidence ?? {}).length > 1);
});

test("ingest: a two-phase detail stating no comp falls back to the prose's", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReaderStating({ compLow: null, compHigh: null }),
  };

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, first, { today: MONDAY });
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

  await ingest(store, second, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [judged] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(judged?.workplace, "remote");
  assert.equal(judged?.kept, true);
  assert.equal(judged?.evidence["remote"], "board states remote");

  // The re-list states no workplace, so the word the detail gave survives.
  await ingest(store, readers, { today: MONDAY });

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

test("judgeAll: a two-phase detail that fails a criterion is judged but its body is not stored", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" })],
      body: async (_board, id) =>
        listing(id, { body: "5+ years of production Delphi.", workplace: "hybrid" }),
    },
  };

  await ingest(store, readers, { today: MONDAY });
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, null);
  assert.equal(row?.workplace, "hybrid");
});

// Breaks if `judgeAll` clears a body it read back from the store rather
// than one it fetched this pass. The criteria edit alone drops this
// posting on its text; the stored body stays, since the verdict did not
// come from a fresh read of the detail.
test("judgeAll: a body stored on an earlier run that a criteria edit now drops on its text is kept", async () => {
  const body = "Staff Backend Engineer. Remote in the US. 5+ years of production Delphi.";
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    postings: [
      posting({
        key: "workday/acme-wd::swe1",
        company: "Acme",
        platform: "workday",
        board: "acme-wd",
        title: "Staff Backend Engineer",
        comp_high: 251_900,
        body,
        body_hash: hashOf(body),
        kept: true,
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
        assert.fail("a posting with a stored body is not fetched again");
      },
    },
  };

  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, body);
  assert.equal(row?.body_hash, hashOf(body));
});

// The operator's setup: one board on Greenhouse has a detail read, so
// `withDetailReads` wraps the whole platform, and every other Greenhouse
// board's `body` falls through to the bare reader's absent fetch: null.
// Breaks if `judgeAll` clears a stored body because the reader has a
// `body`: the body goes, the next re-judge (a criteria edit, no relist)
// asks the wrapped reader, gets null, and judges the empty text back in.
test("ingest then judgeAll: a text rejection on a platform wrapped for another board's detail read stays out across re-judges", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [criteria()] });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [
        listing("b1", {
          title: "Senior Backend Engineer",
          location: "Remote - US",
          compLow: 250_000,
          compHigh: 300_000,
          body: TEXT_OUT_BODY,
        }),
      ],
      body: async () => null,
    },
  };

  await ingest(store, readers, { today: MONDAY });
  const judging = await judgeAll(store, readers);

  assert.deepEqual(judging.errors, []);
  const [first] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(first?.kept, false);
  assert.equal(first?.body, TEXT_OUT_BODY);
  assert.equal(first?.body_hash, hashOf(TEXT_OUT_BODY));

  const edited = await store.update("criteria", "1", { updated_at: "2026-09-15T00:00:00Z" });
  assert.equal(edited.ok, true);
  const rejudging = await judgeAll(store, readers);

  assert.deepEqual(rejudging.errors, []);
  assert.equal(rejudging.judged, 1);
  const [second] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(second?.judged_with, "2026-09-15T00:00:00Z");
  assert.equal(second?.kept, false);
  assert.deepEqual(second?.reasons, first?.reasons);
  assert.equal(second?.body, TEXT_OUT_BODY);
});

test("judgeAll: a two-phase detail that fails a criterion still stores its body when the posting was acted on", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    postings: [
      posting({
        key: "workday/acme-wd::swe1",
        company: "Acme",
        platform: "workday",
        board: "acme-wd",
        title: "Staff Backend Engineer",
        status: "applied",
      }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [],
      body: async (_board, id) =>
        listing(id, { body: "5+ years of production Delphi.", workplace: "remote" }),
    },
  };

  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.body, "5+ years of production Delphi.");
});

test("judgeAll: a two-phase detail that clears every criterion stores its body", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    workday: twoPhaseReader(
      "Staff Backend Engineer. Remote in the US. The salary range is $184,500.00 to $251,900.00.",
    ),
  };

  await ingest(store, readers, { today: MONDAY });
  const judging = await judgeAll(store, readers);

  assert.equal(judging.judged, 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, true);
  assert.equal(
    row?.body,
    "Staff Backend Engineer. Remote in the US. The salary range is $184,500.00 to $251,900.00.",
  );
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(row?.kept, false);
  assert.equal(row?.comp_high, 90_000);
  assert.deepEqual(row?.reasons, ["comp_floor"]);
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  const [first] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(first?.comp_low, 70_000);
  assert.equal(first?.comp_high, 90_000);
  assert.equal(first?.kept, false);
  assert.deepEqual(first?.reasons, ["comp_floor"]);

  // Now fails the floor on its stored comp, so its body is never read; the
  // verdict must carry that comp back rather than write null over it.
  const edited = await store.update("criteria", "1", { updated_at: "2026-09-15T00:00:00Z" });
  assert.equal(edited.ok, true);
  await judgeAll(store, readers);

  const [second] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe1" });
  assert.equal(second?.comp_low, 70_000);
  assert.equal(second?.comp_high, 90_000);
  assert.equal(second?.kept, false);
  assert.deepEqual(second?.reasons, ["comp_floor"]);
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

  // The stored key's `Acme` prefix is not this board's, so the empty read
  // marks nothing gone: this run is testing the re-judge, not gone.
  await ingest(store, readers, { now: () => "2019-01-01T00:00:00.000Z", today: MONDAY });
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
      // Pay below the floor: dropped before a body is worth fetching.
      list: async () => [belowFloor("eng1")],
      body: async () => {
        bodyCalled = true;
        return null;
      },
    },
  };

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  assert.equal(fetches.calls(), 1);
  const [row] = await store.select<Posting>("postings", { key: "workday/acme-wd::swe6" });
  assert.equal(row?.comp_high, 400_000);
  assert.equal(row?.kept, true);
  assert.equal(row?.evidence["level"], 'title carries a bare number "6" used as a level');
});

// Breaks if the stored-listing check (#287) judges a two-phase listing at the
// floor when even the floor cannot settle its level.
test("ingest: a two-phase title with no level marker and no engineering word is not stored and has no body fetched", async () => {
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

  await ingest(store, readers, { today: MONDAY });
  await judgeAll(store, readers);

  assert.equal(fetches.calls(), 0);
  assert.deepEqual(await store.select<Posting>("postings"), []);
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

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { today: MONDAY });
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

  await ingest(store, readers, { now: () => "2026-09-15T12:00:00.000Z", today: MONDAY });

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
      // Pay below the floor, so no body is asked for.
      list: async () => [belowFloor("eng1")],
    },
  };

  await ingest(store, readers, { today: MONDAY });
  const judging = await judgeAll(store, readers);
  assert.equal(judging.judged, 1);

  const sweeps = selects.filter((call) => call.table === "postings" && call.eq === undefined);
  // Two sweeps: ingest's own `key, body_hash` read and the judging pass's;
  // neither reads by key.
  assert.equal(sweeps.length, 2, "ingest and judging each sweep the table once");
  const judgingSweep = sweeps.find((call) => call.columns?.includes("first_seen"));
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
    "gone_at",
    "first_seen",
    "judged_with",
    "kept",
    "reasons",
    "status",
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
        // Dropped by the listing criteria on its pay, not its title and
        // place, so the prune (#287) leaves it for the judging pass.
        posting({
          key: "Acme::eng1",
          company: "Acme",
          title: "Staff Platform Engineer",
          comp_low: 50_000,
          comp_high: 60_000,
        }),
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

  // The stored keys' `Acme` prefix is not this board's, so the empty read
  // marks nothing gone: this run is testing the body select, not gone.
  await ingest(store, readers, { now: () => "2019-01-01T00:00:00.000Z", today: MONDAY });
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

test("ingest: the judging pass writes the verdict columns with key and company, and a body only when it fetched one", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] })],
      criteria: [criteria()],
    }),
  );

  const readers: Partial<Record<Platform, Reader>> = {
    workday: {
      platform: "workday",
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" }), belowFloor("eng1")],
      body: async (_board, id) =>
        listing(id, { body: "This is a fully remote position, open to anyone in the US." }),
    },
  };

  await ingest(store, readers, { today: MONDAY });
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
      // Pay below the floor, so no body is fetched: one flush group, five rows.
      list: async () => ["eng1", "eng2", "eng3", "eng4", "eng5"].map(belowFloor),
    },
  };

  await ingest(store, readers, { today: MONDAY });
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
      list: async () => [listing("swe1", { title: "Staff Backend Engineer" }), belowFloor("eng1")],
      body: async (_board, id) =>
        listing(id, { body: "This is a fully remote position, open to anyone in the US." }),
    },
  };

  await ingest(inner, readers, { today: MONDAY });

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
  // once at the end; pay below the floor, so every verdict is in one column
  // set.
  const ids = Array.from({ length: 201 }, (_, i) => `eng${i + 1}`);
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => ids.map(belowFloor),
    },
  };

  await ingest(store, readers, { today: MONDAY });
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
  assert.deepEqual(aged?.reasons, ["age"]);
  const [recent] = await store.select<Posting>("postings", { key: "Acme::new1" });
  assert.equal(recent?.kept, true);
  assert.deepEqual(recent?.evidence, {}, "a posting still within the max age is left alone");
});

// A kept posting a board's read marked gone (`gone_at` set, `judged_with`
// cleared by `listCompany`) is re-judged out; a posting `judged_with`
// stays untouched for is left alone.
test("judgeAll: a kept posting marked gone is dropped as gone; the others are untouched", async () => {
  const seenOn = (key: string, judgedWith: string | null): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      kept: true,
      judged_with: judgedWith,
    });
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [
      { ...seenOn("Acme::gone", null), gone_at: "2026-09-17T06:00:00.000Z" },
      seenOn("Acme::middle", "2026-09-14T00:00:00Z"),
      seenOn("Acme::latest", "2026-09-14T00:00:00Z"),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 1, "only the row judged_with was cleared for is re-judged");
  const [gone] = await store.select<Posting>("postings", { key: "Acme::gone" });
  assert.equal(gone?.kept, false);
  assert.deepEqual(gone?.reasons, ["gone"]);
  const [middle] = await store.select<Posting>("postings", { key: "Acme::middle" });
  assert.equal(middle?.kept, true);
  assert.deepEqual(middle?.evidence, {}, "a posting not re-judged is left alone");
  const [latest] = await store.select<Posting>("postings", { key: "Acme::latest" });
  assert.equal(latest?.kept, true);
  assert.deepEqual(latest?.evidence, {});
});

// Without the staleness trigger (`judged_with` cleared, `listCompany`'s job
// once it clears `gone_at`) a posting stays gone until the next criteria
// edit.
test("judgeAll: a posting judged gone on one run and marked back by the next read is judged back in", async () => {
  const kept = (key: string, judgedWith: string | null): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
      kept: true,
      judged_with: judgedWith,
    });
  // Dropped on its level two runs back: a cleared `judged_with` alone must
  // not pull it back in.
  const levelOut = posting({
    key: "Acme::junior",
    company: "Acme",
    title: "Backend Engineer",
    kept: false,
    reasons: ["level"],
    evidence: {},
    judged_with: "2026-09-14T00:00:00Z",
  });
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [
      { ...kept("Acme::lapsed", null), gone_at: "2026-09-17T06:00:00.000Z" },
      kept("Acme::steady", "2026-09-14T00:00:00Z"),
      levelOut,
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const firstRun = await judgeAll(store, {});
  assert.equal(firstRun.judged, 1);
  const [gone] = await store.select<Posting>("postings", { key: "Acme::lapsed" });
  assert.equal(gone?.kept, false);
  assert.deepEqual(gone?.reasons, ["gone"]);

  // The next read lists it again: `listCompany` (ingest.ts) clears
  // `gone_at` and `judged_with` together, in one upsert.
  await store.upsert("postings", [
    { key: "Acme::lapsed", company: "Acme", judged_with: null, gone_at: null },
  ]);

  const secondRun = await judgeAll(store, {});
  assert.equal(secondRun.judged, 1, "only the re-listed gone posting is judged again");
  const [back] = await store.select<Posting>("postings", { key: "Acme::lapsed" });
  assert.equal(back?.kept, true);
  assert.equal(back?.evidence["gone"], "listed at the board's last read");
  const [steady] = await store.select<Posting>("postings", { key: "Acme::steady" });
  assert.deepEqual(steady?.evidence, {}, "a posting not re-judged is left alone");
  const [junior] = await store.select<Posting>("postings", { key: "Acme::junior" });
  assert.equal(junior?.kept, false, "a posting dropped on another criterion stays dropped");
});

test("judgeAll: a posting never marked gone stays kept once re-judged for another reason", async () => {
  const stale = (key: string): Posting =>
    posting({
      key,
      company: "Acme",
      title: "Staff Backend Engineer",
      comp_high: 250_000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
      kept: true,
      judged_with: "2026-09-01T00:00:00Z", // stale, so this run still judges it
    });
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })],
    postings: [stale("Acme::a"), stale("Acme::b")],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 2);
  const [a] = await store.select<Posting>("postings", { key: "Acme::a" });
  assert.equal(a?.kept, true);
  assert.equal(a?.evidence["gone"], "listed at the board's last read");
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
    kept: false,
    reasons: ["gone"],
    evidence: {},
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
  assert.deepEqual(a?.reasons, ["gone"]);
});

// The gone-reverse branch that used to fold `unwatchedBy` in as a fallback
// trigger for a gone-out row is retired (Ruling 2, the gone_at plan): a
// dropped board no longer pulls a gone-out row back in for a fresh
// unwatched verdict on its own.
test("judgeAll: a gone posting whose board was removed from its company is left alone", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [] })],
    postings: [goneOut("Acme::a")],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 0, "nothing triggers a re-judge for an already-gone, unstale row");
  const [a] = await store.select<Posting>("postings", { key: "Acme::a" });
  assert.equal(a?.kept, false);
  assert.deepEqual(
    a?.reasons,
    ["gone"],
    "the stored gone reason stands, not replaced by unwatched",
  );
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
    const listed = await ingest(store, readers, { now, today: MONDAY });
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
  assert.deepEqual(gone?.reasons, ["gone"]);

  listings = () => {
    throw new HttpError(500, "HTTP 500");
  };
  assert.deepEqual(await run("2026-09-17"), ["Acme greenhouse/acme-gh: HTTP 500"]);
  assert.deepEqual(await verdicts(), [true, false]);
});

test("judgeAll: a kept posting whose company has no board is judged out unwatched; a status survives the same way", async () => {
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
    companies: [company("Acme")],
    postings: [
      kept("Acme::swe1"),
      kept("Acme::swe2", { status: "applied", applied_at: "2026-09-10T00:00:00Z" }),
    ],
    criteria: [criteria({ updated_at: "2026-09-14T00:00:00Z" })],
  });

  const judging = await judgeAll(store, {});

  assert.equal(judging.judged, 2, "the company's lost board alone moves both postings");
  const [row] = await store.select<Posting>("postings", { key: "Acme::swe1" });
  assert.equal(row?.kept, false);
  assert.deepEqual(row?.reasons, ["unwatched"]);

  const [statusRow] = await store.select<Posting>("postings", { key: "Acme::swe2" });
  assert.equal(statusRow?.kept, false);
  assert.equal(statusRow?.evidence["unwatched"], "company Acme has no board");
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
    assert.deepEqual(row?.reasons, ["duplicate"]);
  }
});

// A representative must not hold its group once it is gone, or every
// duplicate at its key is out forever. `Pragmatike::2`'s stored `duplicate`
// reason survives one run where nothing moves, then clears once
// `Pragmatike::1` falls behind.
test("judgeAll: a duplicate-out row is judged in once its representative twin goes gone", async () => {
  const pragmatike = (key: string, title: string, extra: Partial<Posting>): Posting =>
    posting({
      key,
      company: "Pragmatike",
      platform: "ashby",
      board: "pragmatike",
      title,
      location: "San Francisco",
      comp_high: 400_000,
      posted_at: "2026-08-14",
      body: "This is a fully remote position open to candidates anywhere in the US.",
      judged_with: "2026-09-14T00:00:00Z",
      ...extra,
    });
  // The representative: the later `first_seen`.
  const representative = pragmatike("Pragmatike::1", "Staff Founding Product Engineer", {
    first_seen: "2026-08-15T00:00:00.000Z",
    kept: true,
    reasons: [],
    evidence: {},
  });
  // The duplicate: represents the key only once the row above is gone.
  const duplicate = pragmatike("Pragmatike::2", "Lead Product Engineer", {
    first_seen: "2026-08-14T00:00:00.000Z",
    kept: false,
    reasons: ["duplicate"],
    evidence: {},
  });
  const store = memoryStore({
    companies: [company("Pragmatike", { boards: [{ platform: "ashby", id: "pragmatike" }] })],
    postings: [representative, duplicate],
    criteria: [criteria({ role_words: ["product"], updated_at: "2026-09-14T00:00:00Z" })],
  });

  const firstRun = await judgeAll(store, {});
  assert.equal(firstRun.judged, 0, "neither row is stale or gone");
  const [stillRepresentative] = await store.select<Posting>("postings", { key: "Pragmatike::1" });
  assert.equal(stillRepresentative?.kept, true);
  const [stillDuplicate] = await store.select<Posting>("postings", { key: "Pragmatike::2" });
  assert.equal(stillDuplicate?.kept, false);

  // The next read marks the representative gone: `listCompany` (ingest.ts)
  // sets `gone_at` and clears `judged_with` together, in one upsert.
  await store.upsert("postings", [
    {
      key: "Pragmatike::1",
      company: "Pragmatike",
      judged_with: null,
      gone_at: "2026-09-18T00:00:00Z",
    },
  ]);

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

// The stored `gone_at` of one posting, as the next run's reads see it.
async function goneAtOf(store: Store, key: string): Promise<string | null | undefined> {
  const [row] = await store.select<Pick<Posting, "gone_at">>("postings", { key }, ["gone_at"]);
  return row?.gone_at;
}

const GONE_A = "greenhouse/acme-gh::a";
const GONE_B = "greenhouse/acme-gh::b";

// `b` starts with the given mark; `a` is never marked.
function goneFixture(goneAtB: string | null = null): Posting[] {
  return ["a", "b"].map((id) =>
    posting({
      key: `greenhouse/acme-gh::${id}`,
      company: "Acme",
      platform: "greenhouse",
      board: "acme-gh",
      title: `Staff Backend Engineer ${id}`,
      judged_with: "2026-09-14T00:00:00Z",
      gone_at: id === "b" ? goneAtB : null,
    }),
  );
}

function listedPostingKeys(upserts: readonly UpsertCall[]): string[] {
  return upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows.map((row) => (row as Posting).key));
}

// Breaks if the vanished set is not computed per board, or the mark is not
// stamped with the read's own clock reading.
test("ingest: a stored posting its board's read no longer lists is marked gone at that read and re-judged", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: goneFixture(),
    criteria: [criteria()],
  });

  const result = await ingest(store, oneBoard([admitted("a")]), {
    now: tickingClock(),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(await goneAtOf(store, GONE_B), "2026-09-18T06:00:00.000Z", "the read's timestamp");
  assert.equal(await goneAtOf(store, GONE_A), null, "a listed posting is not marked");
  const [b] = await store.select<Posting>("postings", { key: GONE_B });
  assert.equal(b?.judged_with, null);
  const [a] = await store.select<Posting>("postings", { key: GONE_A });
  assert.equal(a?.judged_with, "2026-09-14T00:00:00Z");
});

// Breaks if `toRow` stops clearing `gone_at` on a posting listed again.
test("ingest: a posting marked gone on one run and listed again on the next is back, and re-judged", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: goneFixture(),
    criteria: [criteria()],
  });
  let listings = [admitted("a")];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: { platform: "greenhouse", list: async () => listings },
  };

  await ingest(store, readers, { now: tickingClockFrom("2026-09-18"), today: MONDAY });
  assert.equal(await goneAtOf(store, GONE_B), "2026-09-18T06:00:00.000Z");
  await store.upsert("postings", [
    { key: GONE_B, company: "Acme", judged_with: "2026-09-18T07:00:00.000Z" },
  ]);

  listings = [admitted("a"), admitted("b")];
  const result = await ingest(store, readers, {
    now: tickingClockFrom("2026-09-19"),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(await goneAtOf(store, GONE_B), null);
  const [b] = await store.select<Posting>("postings", { key: GONE_B });
  assert.equal(b?.judged_with, null, "a returning posting needs a fresh verdict");
});

// Breaks if a returning posting is not folded into `verdictInputChanged`:
// its band and body are unchanged, so nothing else would re-judge it.
test("ingest: a returning posting whose band and body are unchanged still clears gone_at and judged_with", async () => {
  const body = "same text";
  const stored = posting({
    key: GONE_B,
    company: "Acme",
    platform: "greenhouse",
    board: "acme-gh",
    comp_high: 250_000,
    body,
    body_hash: hashOf(body),
    judged_with: "2026-09-14T00:00:00Z",
    gone_at: "2026-09-12T00:00:00.000Z",
  });
  const { store, upserts } = recording(memoryStore({ companies: [ACME], postings: [stored] }));

  await ingest(store, oneBoard([listing("b", { compHigh: 250_000, body })]), {
    now: () => "2026-09-18T06:00:00.000Z",
    today: MONDAY,
  });

  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === GONE_B) as Record<string, unknown> | undefined;
  assert.equal(written?.["gone_at"], null);
  assert.equal(written?.["judged_with"], null);
  assert.equal("body" in (written ?? {}), false, "the unchanged body still stays out");
});

// Breaks if an already-marked posting is re-stamped: an unchanged fact is
// no write.
test("ingest: a posting already marked gone that the read still does not list gets no write", async () => {
  const { store, upserts } = recording(
    memoryStore({ companies: [ACME], postings: goneFixture("2026-09-12T00:00:00.000Z") }),
  );

  await ingest(store, oneBoard([admitted("a")]), { now: tickingClock(), today: MONDAY });

  assert.deepEqual(listedPostingKeys(upserts), [GONE_A]);
  assert.equal(await goneAtOf(store, GONE_B), "2026-09-12T00:00:00.000Z", "the first mark stands");
});

// Breaks if the vanished set is computed for a board whose read failed.
test("ingest: a board whose read fails marks none of its postings gone and clears no mark", async () => {
  const { store, upserts } = recording(
    memoryStore({ companies: [ACME], postings: goneFixture("2026-09-12T00:00:00.000Z") }),
  );
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        throw new HttpError(500, "HTTP 500");
      },
    },
  };

  const result = await ingest(store, readers, { now: tickingClock(), today: MONDAY });

  assert.equal(result.errors.length, 1);
  assert.deepEqual(listedPostingKeys(upserts), []);
  assert.equal(await goneAtOf(store, GONE_A), null);
  assert.equal(await goneAtOf(store, GONE_B), "2026-09-12T00:00:00.000Z");
});

// Since #287 a posting is stored only when its title and place pass, or it
// is kept or acted on. `keptListing` is "Senior Backend Engineer", which
// `EXCLUDES_SENIOR` rejects on its title.
function storedSenior(id: string, overrides: Partial<Posting> = {}): Posting {
  return posting({
    key: `greenhouse/acme-gh::${id}`,
    company: "Acme",
    board: "acme-gh",
    title: "Senior Backend Engineer",
    kept: false,
    judged_with: "2026-09-14T00:00:00Z",
    ...overrides,
  });
}

// Breaks if `listCompany` writes a new listing without the title-and-place
// check, or if the check refuses one whose title and place pass.
test("ingest: of three new listings only the one whose title and place pass is stored", async () => {
  const store = memoryStore({
    companies: [ACME],
    criteria: [criteria({ excluded_locations: ["Berlin"] })],
  });
  const readers = oneBoard([
    admitted("in"),
    listing("title-out", { title: "Account Executive" }),
    admitted("place-out", { location: "Berlin, Germany" }),
  ]);

  const result = await ingest(store, readers, { today: MONDAY });

  assert.deepEqual(result.errors, []);
  assert.equal(result.listed, 3, "a listing not stored still counts as listed");
  assert.equal(result.recorded, 1);
  assert.equal(result.pruned, 0, "nothing was stored to delete");
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/acme-gh::in"],
  );
});

// Breaks if the floor pass `admits` gives a two-phase board reaches a
// one-phase board: its listing carries all the pay it will ever state.
test("ingest: a one-phase Senior title with no pay is not stored", async () => {
  const store = memoryStore({ companies: [ACME], criteria: [criteria()] });

  const result = await ingest(
    store,
    oneBoard([listing("b1", { title: "Senior Backend Engineer" })]),
    { today: MONDAY },
  );

  assert.equal(result.recorded, 0);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// Breaks if `admits` judges a listing that states no pay on its own empty
// band: `toRow` leaves the stored band on such a row, so the judge still
// sees it, and deleting the posting would lose a level the pay settled.
test("ingest: a stored Senior posting relisted with no pay stated is judged on its stored band and kept", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1", { comp_low: 250_000, comp_high: 300_000 })],
    criteria: [criteria()],
  });

  const result = await ingest(
    store,
    oneBoard([listing("b1", { title: "Senior Backend Engineer" })]),
    { now: tickingClock(), today: MONDAY },
  );

  assert.equal(result.pruned, 0);
  const [row] = await store.select<Posting>("postings", { key: KEY });
  assert.equal(row?.comp_high, 300_000);
});

// Breaks if a stored posting a criteria edit rejects is kept, or if the
// gone sweep marks the deleted key (an upsert naming it would recreate it).
test("ingest: a stored posting its title now rejects, never acted on, is deleted when its board reads", async () => {
  const { store, upserts } = recording(
    memoryStore({
      companies: [ACME],
      postings: [storedSenior("b1"), storedSenior("b2", { kept: null })],
      criteria: [EXCLUDES_SENIOR],
    }),
  );

  const result = await ingest(store, oneBoard([keptListing("b1"), keptListing("b2")]), {
    now: tickingClock(),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 2);
  assert.equal(result.recorded, 0);
  assert.deepEqual(listedPostingKeys(upserts), []);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// Breaks if the prune is tied to a board's read answering: a posting's title
// and place are on its stored row, so a failed read cannot hide a rejection.
test("ingest: a stored posting its title rejects is pruned even when its board's read fails", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1")],
    criteria: [EXCLUDES_SENIOR],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        throw new HttpError(500, "HTTP 500");
      },
    },
  };

  const result = await ingest(store, readers, { now: tickingClock(), today: MONDAY });

  assert.equal(result.errors.length, 1);
  assert.equal(result.pruned, 1);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// Breaks if the prune covers only keys a read listed: a gone posting, a
// legacy key and a dropped company's posting are listed by no read, and
// Design, Data holds only what the title and place checks admit or James
// acted on. Breaks too if `kept` or `status` stops sparing an unlisted one.
test("ingest: every stored posting its title rejects is pruned whether or not a read lists it; kept and acted-on ones stay", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [
      storedSenior("gone"),
      storedSenior("gone-kept", { kept: true }),
      storedSenior("gone-applied", { status: "applied" }),
      storedSenior("legacy", { key: "Acme::legacy" }),
      storedSenior("x", {
        key: "greenhouse/dropped-gh::x",
        company: "Dropped",
        board: "dropped-gh",
      }),
    ],
    criteria: [EXCLUDES_SENIOR],
  });

  const result = await ingest(store, oneBoard([admitted("a")]), {
    now: tickingClock(),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 3);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => [row.key, row.gone_at]),
    [
      ["greenhouse/acme-gh::a", null],
      ["greenhouse/acme-gh::gone-applied", "2026-09-18T06:00:00.000Z"],
      ["greenhouse/acme-gh::gone-kept", "2026-09-18T06:00:00.000Z"],
    ],
  );
});

// Breaks if the prune decides a listed key on its stored title rather than
// the title the read just listed: the first would delete a posting the
// listing now admits, the second keep one it now rejects for another run.
test("ingest: a listed posting is pruned or kept by its listed title, not its stored one", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1"), storedSenior("b2", { title: "Staff Backend Engineer b2" })],
    criteria: [EXCLUDES_SENIOR],
  });

  const result = await ingest(store, oneBoard([admitted("b1"), keptListing("b2")]), {
    now: tickingClock(),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 1);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => [row.key, row.title]),
    [["greenhouse/acme-gh::b1", "Staff Backend Engineer b1"]],
  );
});

// Breaks if a failed stored read prunes: with no stored rows to judge,
// nothing can be told apart from a posting that should stay.
test("ingest: a failed stored-postings read deletes nothing", async () => {
  const inner = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1")],
    criteria: [EXCLUDES_SENIOR],
  });
  let deletes = 0;
  const store: Store = {
    ...inner,
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      if (table === "postings" && columns?.includes("body_hash") === true) {
        throw new Error("connection reset");
      }
      return inner.select<T>(table, eq, columns);
    },
    async delete(table, keys) {
      deletes += 1;
      return inner.delete(table, keys);
    },
  };

  const result = await ingest(store, oneBoard([]), { today: MONDAY });

  assert.match(result.errors[0] ?? "", /reading stored body hashes: connection reset/);
  assert.equal(result.pruned, 0);
  assert.equal(deletes, 0);
  const rows = await inner.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/acme-gh::b1"],
  );
});

// The operator's setup (`withDetailReads`): one board's detail read wraps
// the whole Greenhouse reader, so every Greenhouse board's reader has a
// `body`. Breaks if the floor pass is decided from the reader `ingest` is
// handed rather than the platform's own in `READERS`: a Greenhouse listing
// states all the pay it will, so a Senior title with none is rejected like
// any one-phase listing's, listed (`b1`) or stored and never judged (`b2`).
test("ingest: a Greenhouse Senior posting with no pay and a body is not stored when listed and is pruned when stored, on a platform wrapped for a detail read", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b2", { body: KEPT_BODY, judged_with: null })],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => [listing("b1", { title: "Senior Backend Engineer", body: KEPT_BODY })],
      body: async () => null,
    },
  };

  const result = await ingest(store, readers, { now: tickingClock(), today: MONDAY });

  assert.deepEqual(result.errors, []);
  assert.equal(result.recorded, 1, "only the gone mark on b2, not b1");
  assert.equal(result.pruned, 1);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// A two-phase board stating pay only on its detail: `nopay` states none,
// `paid` states a band above `criteria()`'s floor.
function seniorTwoPhaseReader(): { readonly reader: Reader; readonly fetched: string[] } {
  const fetched: string[] = [];
  return {
    reader: {
      platform: "workday",
      list: async () => [
        listing("nopay", { title: "Senior Backend Engineer" }),
        listing("paid", { title: "Senior Platform Engineer" }),
      ],
      body: async (_board, id) => {
        fetched.push(id);
        const pay = id === "paid" ? " The salary range is $250,000 - $300,000." : "";
        return listing(id, { body: `Remote in the US.${pay}` });
      },
    },
    fetched,
  };
}

const TWO_PHASE_ACME = company("Acme", { boards: [{ platform: "workday", id: "acme-wd" }] });

// Breaks if a native two-phase listing with no pay loses the floor pass: a
// posting relisted before its first judging would be pruned before its pay
// was ever seen.
test("ingest: a two-phase Senior posting awaiting its first detail is stored and survives a relist", async () => {
  const store = memoryStore({ companies: [TWO_PHASE_ACME], criteria: [criteria()] });
  const { reader } = seniorTwoPhaseReader();
  const readers: Partial<Record<Platform, Reader>> = { workday: reader };

  const first = await ingest(store, readers, { today: MONDAY });
  const second = await ingest(store, readers, { today: MONDAY });

  assert.equal(first.recorded, 2);
  assert.equal(second.pruned, 0);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => [row.key, row.judged_with]),
    [
      ["workday/acme-wd::nopay", null],
      ["workday/acme-wd::paid", null],
    ],
  );
});

// Breaks if the floor pass ends once the detail is read: `nopay` would be
// pruned at the second read, stored again as new at the third, and its
// detail fetched again, one wasted fetch every other read.
test("ingest: a two-phase Senior posting whose detail was read and states no pay stays stored and is not fetched again", async () => {
  const store = memoryStore({ companies: [TWO_PHASE_ACME], criteria: [criteria()] });
  const { reader, fetched } = seniorTwoPhaseReader();
  const readers: Partial<Record<Platform, Reader>> = { workday: reader };

  const runs: IngestResult[] = [];
  for (let run = 0; run < 3; run += 1) {
    runs.push(await ingest(store, readers, { today: MONDAY }));
    assert.deepEqual((await judgeAll(store, readers)).errors, []);
  }

  assert.deepEqual(fetched, ["nopay", "paid"]);
  assert.deepEqual(
    runs.map((result) => result.pruned),
    [0, 0, 0],
  );
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => [row.key, row.comp_high, row.kept]),
    [
      ["workday/acme-wd::nopay", null, false],
      ["workday/acme-wd::paid", 300_000, true],
    ],
  );
});

// Breaks if the stored `kept` or `status` is not read, or not consulted,
// before a rejected posting is deleted.
test("ingest: a stored posting its title rejects is never deleted while kept or acted on", async () => {
  const store = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1", { kept: true }), storedSenior("b2", { status: "applied" })],
    criteria: [EXCLUDES_SENIOR],
  });

  const result = await ingest(store, oneBoard([keptListing("b1"), keptListing("b2")]), {
    now: tickingClock(),
    today: MONDAY,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 0);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => [row.key, row.kept, row.status, row.gone_at]),
    [
      ["greenhouse/acme-gh::b1", true, null, null],
      ["greenhouse/acme-gh::b2", false, "applied", null],
    ],
  );
});

// Breaks if a missing criteria row filters or deletes anything, or logs per
// company instead of once.
test("ingest: with no criteria row every listing is stored, nothing is deleted, and one line says so", async () => {
  const store = memoryStore({
    companies: [ACME, company("Globex", { boards: [{ platform: "greenhouse", id: "globex-gh" }] })],
    postings: [storedSenior("b1"), storedSenior("unlisted")],
  });
  const lines: string[] = [];

  const result = await ingest(
    store,
    oneBoard([
      listing("b1", { title: "Account Executive" }),
      listing("b2", { title: "Recruiter" }),
    ]),
    { today: MONDAY, log: (line) => lines.push(line) },
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 0);
  assert.deepEqual(lines, ["ingest: no criteria row; every listing is stored and none is pruned"]);
  const rows = await store.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      "greenhouse/acme-gh::b1",
      "greenhouse/acme-gh::b2",
      "greenhouse/acme-gh::unlisted",
      "greenhouse/globex-gh::b1",
      "greenhouse/globex-gh::b2",
    ],
  );
});

// Breaks if `pruned` sums per company: two companies carrying one board both
// read it and both delete the same key, which is one posting gone.
test("ingest: a rejected posting on a board two companies carry counts as pruned once", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
      company("Acme Labs", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
    ],
    postings: [storedSenior("b1")],
    criteria: [EXCLUDES_SENIOR],
  });

  const result = await ingest(store, oneBoard([keptListing("b1")]), { today: MONDAY });

  assert.equal(result.pruned, 1);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// Breaks if a gone mark can follow a delete: the first company's read lists
// the rejected key and the second's, of the same board, no longer does, so
// its gone sweep names the key. Deleted before that sweep, the mark's upsert
// would insert it back as a stub.
test("ingest: a pruned key is never marked gone back into the store by a second company carrying its board", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
      company("Acme Labs", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
    ],
    postings: [storedSenior("b1")],
    criteria: [EXCLUDES_SENIOR],
  });
  let reads = 0;
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        reads += 1;
        return reads === 1 ? [keptListing("b1")] : [];
      },
    },
  };

  const result = await ingest(store, readers, { now: tickingClock(), today: MONDAY });

  assert.equal(reads, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pruned, 1);
  assert.deepEqual(await store.select<Posting>("postings"), []);
});

// Breaks if a refused delete throws the run, or skips the company's upsert.
test("ingest: a refused delete is one error line, prunes nothing, and the listed rows still land", async () => {
  const inner = memoryStore({
    companies: [ACME],
    postings: [storedSenior("b1")],
    criteria: [EXCLUDES_SENIOR],
  });
  const store: Store = {
    ...inner,
    delete: () => Promise.reject(new Error("refused")),
  };

  const result = await ingest(store, oneBoard([keptListing("b1"), admitted("b2")]), {
    today: MONDAY,
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /^pruning 1 postings: refused/);
  assert.equal(result.pruned, 0);
  assert.equal(result.recorded, 1);
  const rows = await inner.select<Posting>("postings");
  assert.deepEqual(
    rows.map((row) => row.key),
    ["greenhouse/acme-gh::b1", "greenhouse/acme-gh::b2"],
  );
});

// A re-list identical to what is stored is no write: the daily run lists
// every posting, and rewriting each unchanged row every day is the churn
// `toRow` returning null removes. Only a real write would overwrite
// `UNCHANGED_JUDGED_WITH`.
const UNCHANGED_KEY = "greenhouse/acme-gh::same";
const UNCHANGED_BODY = "Build the platform.";
const UNCHANGED_JUDGED_WITH = "2026-09-14T00:00:00Z";

function unchangedListing(overrides: Partial<Listing> = {}): Listing {
  return listing("same", {
    title: "Staff Backend Engineer",
    url: "https://example.com/same",
    location: "Remote, US",
    postedAt: "2026-09-01",
    compLow: 200_000,
    compHigh: 250_000,
    body: UNCHANGED_BODY,
    workplace: "hybrid",
    ...overrides,
  });
}

function unchangedStored(overrides: Partial<Posting> = {}): Posting {
  return posting({
    key: UNCHANGED_KEY,
    company: "Acme",
    platform: "greenhouse",
    board: "acme-gh",
    title: "Staff Backend Engineer",
    url: "https://example.com/same",
    location: "Remote, US",
    posted_at: "2026-09-01",
    comp_low: 200_000,
    comp_high: 250_000,
    body: UNCHANGED_BODY,
    body_hash: hashOf(UNCHANGED_BODY),
    workplace: "hybrid",
    judged_with: UNCHANGED_JUDGED_WITH,
    ...overrides,
  });
}

// One ingest of one listing over the given stored rows. No criteria row by
// default, so every body is kept and the unchanged-hash branch decides.
async function relist(
  stored: Posting[],
  listed: Listing,
  criteriaRows: Criteria[] = [],
): Promise<{ written: Record<string, unknown> | undefined; recorded: number; store: Store }> {
  const { store, upserts } = recording(
    memoryStore({ companies: [ACME], postings: stored, criteria: criteriaRows }),
  );
  const result = await ingest(store, oneBoard([listed]), { now: tickingClock(), today: MONDAY });
  assert.deepEqual(result.errors, []);
  const written = upserts
    .filter((call) => call.table === "postings")
    .flatMap((call) => call.rows)
    .find((row) => (row as Posting).key === UNCHANGED_KEY) as Record<string, unknown> | undefined;
  return { written, recorded: result.recorded, store };
}

// Breaks if the unchanged-hash branch returns `row` instead of null, or if
// `listCompany` stops adding a null row's key to `seenKeys` (it would be
// marked gone).
test("ingest: a re-listed posting identical to what is stored gets no write and is not marked gone", async () => {
  const { written, recorded, store } = await relist([unchangedStored()], unchangedListing());

  assert.equal(written, undefined);
  assert.equal(recorded, 0);
  const [row] = await store.select<Posting>("postings", { key: UNCHANGED_KEY });
  assert.equal(row?.judged_with, UNCHANGED_JUDGED_WITH);
  assert.equal(row?.gone_at, null);
});

// Breaks if `fieldsChanged` stops comparing the title.
test("ingest: a re-listed posting whose title changed is written with the new title", async () => {
  const { written } = await relist(
    [unchangedStored()],
    unchangedListing({ title: "Principal Backend Engineer" }),
  );

  assert.equal(written?.["title"], "Principal Backend Engineer");
});

// Breaks if `fieldsChanged` stops comparing `posted_at`.
test("ingest: a re-listed posting whose posted date changed is written", async () => {
  const { written } = await relist(
    [unchangedStored()],
    unchangedListing({ postedAt: "2026-09-20" }),
  );

  assert.equal(written?.["posted_at"], "2026-09-20");
});

// Breaks if `fieldsChanged` stops comparing the url.
test("ingest: a re-listed posting whose url changed is written", async () => {
  const { written } = await relist(
    [unchangedStored()],
    unchangedListing({ url: "https://example.com/moved" }),
  );

  assert.equal(written?.["url"], "https://example.com/moved");
});

// Breaks if `fieldsChanged` stops comparing the location.
test("ingest: a re-listed posting whose location changed is written", async () => {
  const { written } = await relist([unchangedStored()], unchangedListing({ location: "Denver" }));

  assert.equal(written?.["location"], "Denver");
});

// Breaks if `fieldsChanged` stops comparing the company a key is stored under.
test("ingest: a re-listed posting stored under another company name is written under this one", async () => {
  const { written } = await relist([unchangedStored({ company: "Acme Old" })], unchangedListing());

  assert.equal(written?.["company"], "Acme");
});

// Breaks if `rowChanged` stops comparing `comp_low`: it feeds no verdict,
// so nothing else would notice it.
test("ingest: a re-listed posting whose low band changed is written without a re-judge", async () => {
  const { written } = await relist([unchangedStored()], unchangedListing({ compLow: 180_000 }));

  assert.equal(written?.["comp_low"], 180_000);
  assert.equal("judged_with" in (written ?? {}), false);
});

// Breaks if a return collapses to null: clearing `gone_at` is a real change
// even when every listed field is the same.
test("ingest: a returning posting with every listed field unchanged is still written, back and re-judged", async () => {
  const { written } = await relist(
    [unchangedStored({ gone_at: "2026-09-12T00:00:00.000Z" })],
    unchangedListing(),
  );

  assert.equal(written?.["gone_at"], null);
  assert.equal(written?.["judged_with"], null);
});

// Breaks if `stored === undefined` stops counting as changed.
test("ingest: a posting never stored before is written", async () => {
  const { written } = await relist([], unchangedListing());

  assert.equal(written?.["title"], "Staff Backend Engineer");
  assert.equal(written?.["body"], UNCHANGED_BODY);
});

// A floor above `unchangedListing`'s band: the listing criteria drop it on
// its pay, so its body is not kept; its title and place pass, so it is
// stored (#287).
const FLOOR_ABOVE_BAND = criteria({ comp_floor: 400_000 });

// Breaks if the `!keep` branch returns `cleared` when there was nothing
// stored to clear and nothing else changed.
test("ingest: a dropped posting with no stored body and nothing changed gets no write", async () => {
  const { written } = await relist(
    [unchangedStored({ body: null, body_hash: null })],
    unchangedListing(),
    [FLOOR_ABOVE_BAND],
  );

  assert.equal(written, undefined);
});

// Breaks if the `!keep` branch collapses to null while a stored body is
// being cleared.
test("ingest: a dropped posting whose stored body is cleared is written even with nothing else changed", async () => {
  const { written } = await relist([unchangedStored()], unchangedListing(), [FLOOR_ABOVE_BAND]);

  assert.equal(written?.["body"], null);
  assert.equal(written?.["body_hash"], null);
});

// Breaks if the no-body, no-comp early return sends `bare` when it repeats
// the stored row.
test("ingest: an unchanged listing with no body and no comp gets no write", async () => {
  const { written } = await relist(
    [unchangedStored({ body: null, body_hash: null })],
    unchangedListing({ body: null, compLow: null, compHigh: null }),
  );

  assert.equal(written, undefined);
});

// Breaks if the no-body early return (comp stated) sends `row` when it
// repeats the stored row.
test("ingest: an unchanged listing with comp but no body gets no write", async () => {
  const { written } = await relist(
    [unchangedStored({ body: null, body_hash: null })],
    unchangedListing({ body: null }),
  );

  assert.equal(written, undefined);
});

// A full sweep (every stored posting stale at once) can run long with no
// other line in the log between its start and its end, which reads the
// same as a hang. Breaks if the progress line stops firing.
test("judgeAll: a long sweep logs its progress periodically", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme" }] })],
    postings: [
      posting({ key: "Acme::1", company: "Acme", platform: "greenhouse", board: "acme" }),
      posting({ key: "Acme::2", company: "Acme", platform: "greenhouse", board: "acme" }),
      posting({ key: "Acme::3", company: "Acme", platform: "greenhouse", board: "acme" }),
    ],
    criteria: [criteria()],
  });
  const lines: string[] = [];
  // Pins the 30 s threshold exactly, on both sides. Readings, in order:
  // the initial `lastProgressAt` (0), then one gap-check per row. Row 1's
  // gap is 29,999ms (must NOT log); row 2's is exactly 30,000ms (must
  // log, and resets `lastProgressAt` to this same reading); row 3's gap
  // from that reset point is only 1ms (must NOT log again).
  const readings = [0, 29_999, 30_000, 30_001];
  let call = 0;
  const clock = () => {
    const value = readings[call] ?? readings[readings.length - 1];
    call += 1;
    return value;
  };

  const judging = await judgeAll(store, {}, { log: (line) => lines.push(line), clock });

  assert.equal(judging.judged, 3);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^judge: 2\/3 scanned, \d+ judged so far$/);
});

// Breaks if the throttle fires on every row instead of waiting the interval.
test("judgeAll: a quick sweep logs no progress at all", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme" }] })],
    postings: [posting({ key: "Acme::1", company: "Acme", platform: "greenhouse", board: "acme" })],
    criteria: [criteria()],
  });
  const lines: string[] = [];

  const judging = await judgeAll(store, {}, { log: (line) => lines.push(line) });

  assert.equal(judging.judged, 1);
  assert.equal(lines.length, 0);
});

// `boardsToRead`'s input as `ingest` builds it: each board's stored postings
// by key, under the board's `platform/board` key prefix.
interface StoredTitleAndPlace {
  readonly title: string | null;
  readonly location: string | null;
  readonly comp_high: number | null;
}

function storedOn(
  boards: Record<string, readonly Partial<StoredTitleAndPlace>[]>,
): Map<string, Map<string, StoredTitleAndPlace>> {
  return new Map(
    Object.entries(boards).map(([prefix, postings]) => [
      prefix,
      new Map(
        postings.map((posting, i) => [
          `${prefix}::${i + 1}`,
          { title: null, location: null, comp_high: null, ...posting },
        ]),
      ),
    ]),
  );
}

// Breaks if Monday stops reading every board.
test("boardsToRead: Monday reads every board, whatever its postings say", () => {
  const companies = [
    company("Acme", {
      boards: [
        { platform: "greenhouse", id: "acme-producing" },
        { platform: "greenhouse", id: "acme-failing" },
      ],
    }),
    company("Globex", { boards: [{ platform: "lever", id: "globex-new" }] }),
  ];
  const stored = storedOn({
    "greenhouse/acme-producing": [{ title: "Staff Backend Engineer" }],
    "greenhouse/acme-failing": [{ title: "Marketing Manager" }],
  });

  const result = boardsToRead(companies, stored, criteria(), MONDAY, new Map());

  assert.deepEqual([...result].sort(), [
    "greenhouse::acme-failing",
    "greenhouse::acme-producing",
    "lever::globex-new",
  ]);
});

// Breaks if a company bound inside the last week waits for Monday instead:
// with #287 a board whose postings all fail never stores one, so a company
// just bound (a candidate outcome watched or added) is the only way to read
// its board before it has anything stored.
test("boardsToRead: a company bound 3 days before a Tuesday is read", () => {
  const companies = [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-new" }] })];
  const boundSince = new Map([["Acme", "2026-09-26T12:00:00"]]);

  const result = boardsToRead(companies, new Map(), criteria(), TUESDAY, boundSince);

  assert.deepEqual([...result], ["greenhouse::acme-new"]);
});

// Breaks if a board that has never produced is read daily, whether it was
// bound long enough ago that its week is up, or never bound at all.
test("boardsToRead: a company bound 10 days before a Tuesday with no passing posting waits", () => {
  const companies = [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-failing" }] })];
  const stored = storedOn({
    "greenhouse/acme-failing": [
      // No level word, no role word: fails both.
      { title: "Marketing Manager" },
      // Passes level and role, fails country.
      { title: "Staff Backend Engineer", location: "Berlin, Germany" },
    ],
  });
  const boundSince = new Map([["Acme", "2026-09-19T12:00:00"]]);

  const result = boardsToRead(companies, stored, criteria(), TUESDAY, boundSince);

  assert.deepEqual([...result], []);
});

// Breaks if a board that has never produced and was never bound is read
// daily (the pre-#287 fallback "no stored posting" arm, now dropped).
test("boardsToRead: a board with no stored posting and no bound company waits on a non-Monday", () => {
  const companies = [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-new" }] })];

  const result = boardsToRead(companies, new Map(), criteria(), TUESDAY, new Map());

  assert.deepEqual([...result], []);
});

// Breaks if `judgeLevel` is called without the posting's pay (review 1): a
// Senior title is admitted only when its posted pay settles the level.
test("boardsToRead: a Senior-titled posting with pay above the floor makes its board read on a non-Monday; without pay it does not", () => {
  const companies = [
    company("Acme", {
      boards: [
        { platform: "greenhouse", id: "acme-paid" },
        { platform: "greenhouse", id: "acme-unpaid" },
      ],
    }),
  ];
  const stored = storedOn({
    "greenhouse/acme-paid": [{ title: "Senior Backend Engineer", comp_high: 200_000 }],
    "greenhouse/acme-unpaid": [{ title: "Senior Backend Engineer" }],
  });

  const result = boardsToRead(
    companies,
    stored,
    criteria({ comp_floor: 120_000 }),
    TUESDAY,
    new Map(),
  );

  assert.deepEqual([...result], ["greenhouse::acme-paid"]);
});

// Breaks if `ingest` never reads `candidates` to build `boundSince`, or
// builds it wrong: a board with nothing stored is read only because its
// company was bound (outcome `added`) three days ago.
test("ingest: a board with no stored posting is read when its company was added as a candidate three days ago", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-new" }] })],
    candidates: [
      candidate({ id: "1", company: "Acme", outcome: "added", outcome_at: "2026-09-26T12:00:00" }),
    ],
    criteria: [criteria()],
  });
  const read: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        read.push(board.id);
        return [];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.deepEqual(read, ["acme-new"]);
  assert.equal(result.boardsToday, 1);
});

// Breaks if `boundSince` counts a candidate outcome other than `watched` or
// `added` (Design, Ingestion names only those two) as binding its company.
test("ingest: a candidate known three days ago, with no watched or added outcome, does not bind its company", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-new" }] })],
    candidates: [
      candidate({ id: "1", company: "Acme", outcome: "known", outcome_at: "2026-09-26T12:00:00" }),
    ],
    criteria: [criteria()],
  });
  const read: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        read.push(board.id);
        return [];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.deepEqual(read, []);
  assert.equal(result.boardsToday, 0);
});

// Breaks if the check reads stored verdicts instead of judging title and
// place fresh: a posting aged out and stored kept:false with reasons naming
// only "age" (the way #274 leaves it) still marks its board producing.
test("ingest: a board whose one passing posting has aged out is still read on a non-Monday", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-old" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-old::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-old",
        title: "Staff Backend Engineer",
        posted_at: "2020-01-01T00:00:00.000Z",
        kept: false,
        reasons: [{ criterion: "age", verdict: "out", detail: "too old" }],
      }),
    ],
    criteria: [criteria({ max_age_days: 1 })],
  });
  const read: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        read.push(board.id);
        return [];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.deepEqual(read, ["acme-old"]);
  assert.equal(result.boardsToday, 1);
  assert.equal(result.boardsWaiting, 0);
});

// Breaks if a waiting board is read, or its postings are swept gone as
// though a read had stopped listing them.
test("ingest: a board with no producing posting waits for Monday, is never read, and its postings keep gone_at null", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        boards: [
          { platform: "greenhouse", id: "acme-producing" },
          { platform: "greenhouse", id: "acme-failing" },
        ],
      }),
    ],
    postings: [
      posting({
        key: "greenhouse/acme-producing::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-producing",
        title: "Staff Backend Engineer",
      }),
      posting({
        key: "greenhouse/acme-failing::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-failing",
        title: "Marketing Manager",
        // Acted on, so the prune (#287) keeps it and the board still
        // produces nothing its title and place pass.
        status: "applied",
      }),
    ],
    criteria: [criteria()],
  });

  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        if (board.id === "acme-failing") {
          throw new Error("the waiting board must never be read");
        }
        return [listing("2", { title: "Staff Backend Engineer" })];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.equal(result.errors.length, 0, "the waiting board cost no error");
  assert.equal(result.listed, 1, "only the producing board's listing was read");
  assert.equal(result.boardsToday, 1);
  assert.equal(result.boardsWaiting, 1);
  const [waiting] = await store.select<Posting>("postings", { key: "greenhouse/acme-failing::1" });
  assert.equal(waiting?.gone_at, null);
  // The read board's posting it no longer lists is swept, so the null above
  // is the skip, not a sweep that never runs.
  const [swept] = await store.select<Posting>("postings", {
    key: "greenhouse/acme-producing::1",
  });
  assert.equal(swept?.gone_at === null, false);
});

// Breaks if the stored-postings read that picks today's boards throws out
// of `ingest` (review 2): a refused read is one error line and every board
// looks new, so every board is read.
test("ingest: a refused stored-postings read on a non-Monday reads every board and costs one error line", async () => {
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-failing" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-failing::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-failing",
        title: "Marketing Manager",
      }),
    ],
    criteria: [criteria()],
  });
  const store: Store = {
    ...inner,
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      if (table === "postings") throw new Error("statement timeout");
      return inner.select<T>(table, eq, columns);
    },
  };
  const read: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        read.push(board.id);
        return [];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.deepEqual(read, ["acme-failing"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /statement timeout/);
});

// Breaks if a refused candidates read (`boundSince`) throws out of `ingest`,
// or is silently swallowed into "nothing is bound": either would leave a
// board with no admitted posting waiting, though nothing here says it should.
test("ingest: a failed candidates read on a non-Monday reads every board and costs one error line", async () => {
  const inner = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-failing" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-failing::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-failing",
        title: "Marketing Manager",
      }),
    ],
    criteria: [criteria()],
  });
  const store: Store = {
    ...inner,
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      if (table === "candidates") throw new Error("statement timeout");
      return inner.select<T>(table, eq, columns);
    },
  };
  const read: string[] = [];
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        read.push(board.id);
        return [];
      },
    },
  };

  const result = await ingest(store, readers, { today: TUESDAY });

  assert.deepEqual(read, ["acme-failing"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /reading candidates.*statement timeout/);
});

// Breaks if today's boards are counted by unique board key (review 4): a
// board two companies carry is read, and fails, once per company, so one
// shared failing board beside one working board is not every board failing.
test("ingest and listExitCode: a failing board two companies share, beside a working board, is not every board failing", async () => {
  const shared = { platform: "greenhouse", id: "shared" } as const;
  const store = memoryStore({
    companies: [
      company("Acme", { boards: [shared] }),
      company("Globex", { boards: [shared] }),
      company("Initech", { boards: [{ platform: "greenhouse", id: "initech" }] }),
    ],
    criteria: [criteria()],
  });
  const readers: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        if (board.id === "shared") throw new HttpError(500, "HTTP 500");
        return [];
      },
    },
  };

  // Monday, not Tuesday: this test is about how boards are counted once
  // they're read, not about which ones `boardsToRead` picks (#287, no
  // candidate or stored posting is seeded here).
  const result = await ingest(store, readers, { today: MONDAY });

  assert.equal(result.errors.length, 2);
  assert.equal(result.boardsToday, 3);
  assert.equal(result.boardsWaiting, 0);
  assert.equal(listExitCode(result), 0);
  assert.equal(
    listExitCode({ ...result, boardsToday: 2 }),
    1,
    "every one of two boards failing is",
  );
});

// `full_read_at` against `updated_at` (`criteriaEdited`): a criteria edit
// reaches every board at the next run, not the next Monday. Each case is a
// Tuesday with one never-bound board whose only posting fails, so nothing
// but the edit could read it.
const WAITING_COMPANIES = [
  company("Acme", { boards: [{ platform: "greenhouse", id: "acme-failing" }] }),
];
const WAITING_STORED = storedOn({ "greenhouse/acme-failing": [{ title: "Marketing Manager" }] });

// Breaks if a criteria row never read in full (the column's null, as it is
// the first run after the migration) is not treated as an edit.
test("boardsToRead: full_read_at null reads every board on a Tuesday", () => {
  const result = boardsToRead(
    WAITING_COMPANIES,
    WAITING_STORED,
    criteria({ full_read_at: null }),
    TUESDAY,
    new Map(),
  );

  assert.deepEqual([...result], ["greenhouse::acme-failing"]);
});

// Breaks if the edit arm stays on once the edit has been read in full, which
// would make every day a Monday.
test("boardsToRead: full_read_at after updated_at leaves a non-producing board waiting", () => {
  const result = boardsToRead(
    WAITING_COMPANIES,
    WAITING_STORED,
    criteria({ updated_at: "2026-09-14T00:00:00Z", full_read_at: "2026-09-15T00:00:00Z" }),
    TUESDAY,
    new Map(),
  );

  assert.deepEqual([...result], []);
});

// Breaks if an edit after the last full read is missed, or if the two
// timestamps are compared as text: full_read_at is 07:00Z spelled with a
// +02:00 offset, an hour before updated_at, yet sorts after it as a string.
test("boardsToRead: full_read_at before updated_at reads every board again", () => {
  const result = boardsToRead(
    WAITING_COMPANIES,
    WAITING_STORED,
    criteria({ updated_at: "2026-09-20T08:00:00.000Z", full_read_at: "2026-09-20T09:00:00+02:00" }),
    TUESDAY,
    new Map(),
  );

  assert.deepEqual([...result], ["greenhouse::acme-failing"]);
});

// Breaks if a missing criteria row counts as an edit: with nothing to judge
// against, a Tuesday reads only newly bound boards, as before.
test("boardsToRead: no criteria row adds no board", () => {
  const result = boardsToRead(WAITING_COMPANIES, WAITING_STORED, undefined, TUESDAY, new Map());

  assert.deepEqual([...result], []);
});

function waitingStore(full_read_at: string | null): Store {
  return memoryStore({
    companies: [company("Acme", { boards: [{ platform: "greenhouse", id: "acme-failing" }] })],
    postings: [
      posting({
        key: "greenhouse/acme-failing::1",
        company: "Acme",
        platform: "greenhouse",
        board: "acme-failing",
        title: "Marketing Manager",
      }),
    ],
    criteria: [criteria({ updated_at: "2026-09-20T00:00:00Z", full_read_at })],
  });
}

const EMPTY_READERS: Partial<Record<Platform, Reader>> = {
  greenhouse: { platform: "greenhouse", list: async () => [] },
};

// Breaks if a run that read every board for an edit does not record it,
// which would make every later run read every board too.
test("ingest: a run that reads every board for a criteria edit writes full_read_at", async () => {
  const { store, updates } = recording(waitingStore("2026-09-14T00:00:00Z"));

  const result = await ingest(store, EMPTY_READERS, { today: TUESDAY, log: () => {} });

  assert.equal(result.boardsToday, 1);
  assert.equal(result.criteriaEdited, true);
  assert.deepEqual(updates, [
    { table: "criteria", key: "1", patch: { full_read_at: "2026-09-20T00:00:00Z" } },
  ]);
});

// Breaks if the write is made on every run rather than only after an edit.
test("ingest: a run with no pending criteria edit leaves full_read_at alone", async () => {
  const { store, updates } = recording(waitingStore("2026-09-20T00:00:00Z"));

  const result = await ingest(store, EMPTY_READERS, { today: TUESDAY, log: () => {} });

  assert.equal(result.boardsToday, 0);
  assert.equal(result.criteriaEdited, false);
  assert.deepEqual(updates, []);
});

// Breaks if a run that read every board because a read failed marks the
// edit as read in full: it read every board for its own reason, and the
// edit must still be acted on by a run that chose to.
test("ingest: a failed stored-postings read does not write full_read_at, even with an edit pending", async () => {
  const inner = waitingStore(null);
  const failing: Store = {
    ...inner,
    async select<T>(
      table: Table,
      eq?: Partial<Record<string, unknown>>,
      columns?: readonly string[],
    ) {
      if (table === "postings") throw new Error("connection reset");
      return inner.select<T>(table, eq, columns);
    },
  };
  const { store, updates } = recording(failing);

  const result = await ingest(store, EMPTY_READERS, { today: TUESDAY, log: () => {} });

  assert.equal(result.boardsToday, 1);
  assert.equal(result.criteriaEdited, false);
  assert.deepEqual(updates, []);
});

// Breaks if the marker is gated only on the stored-postings and candidates
// reads: a run whose board reads all fail (an ATS down or rate-limiting)
// would mark the edit as read, and the failed boards would wait for Monday.
// One board, one error: errors meet `boardsToday`, `listExitCode`'s own
// "every board failed".
test("ingest: every board read failing does not write full_read_at, even with an edit pending", async () => {
  const { store, updates } = recording(waitingStore(null));
  const failingReaders: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async () => {
        throw new Error("rate limited");
      },
    },
  };
  const lines: string[] = [];

  const result = await ingest(store, failingReaders, {
    today: TUESDAY,
    log: (line) => lines.push(line),
  });

  assert.equal(result.boardsToday, 1);
  assert.equal(result.criteriaEdited, true);
  assert.equal(result.errors.length, 1);
  assert.equal(listExitCode(result), 1);
  assert.deepEqual(updates, []);
  assert.deepEqual(lines, [
    "ingest: every board picked for the criteria edit, but every board failed (1 errors, 1 boards); full_read_at not written, the next run reads every board again",
  ]);
});

// Breaks if any single board's error holds the marker back: a run over
// thousands of external boards almost always has a few, and the edit would
// then read every board every day. The live run that found this had 3 of
// 7,139; here 3 of 100.
test("ingest: a few failed board reads still write full_read_at for a pending edit", async () => {
  const failingBoards = new Set(["board-7", "board-42", "board-99"]);
  const inner = memoryStore({
    companies: Array.from({ length: 100 }, (_, index) =>
      company(`Company ${index}`, { boards: [{ platform: "greenhouse", id: `board-${index}` }] }),
    ),
    criteria: [criteria({ updated_at: "2026-09-20T00:00:00Z", full_read_at: null })],
  });
  const { store, updates } = recording(inner);
  const flakyReaders: Partial<Record<Platform, Reader>> = {
    greenhouse: {
      platform: "greenhouse",
      list: async (board) => {
        if (failingBoards.has(board.id)) throw new Error("HTTP 500");
        return [];
      },
    },
  };

  const result = await ingest(store, flakyReaders, { today: TUESDAY, log: () => {} });

  assert.equal(result.boardsToday, 100);
  assert.equal(result.criteriaEdited, true);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(updates, [
    { table: "criteria", key: "1", patch: { full_read_at: "2026-09-20T00:00:00Z" } },
  ]);
});

// Breaks if a refused marker write is counted as an error: `listExitCode`
// would count it against a day's boards, and with one board due a clean run
// would exit as if every board failed.
test("ingest: a refused full_read_at write is a log line, not an error", async () => {
  const inner = waitingStore(null);
  const refusing: Store = {
    ...inner,
    update: async () => ({ ok: false, reason: "permission denied" }),
  };
  const lines: string[] = [];

  const result = await ingest(refusing, EMPTY_READERS, {
    today: TUESDAY,
    log: (line) => lines.push(line),
  });

  assert.deepEqual(result.errors, []);
  assert.equal(listExitCode(result), 0);
  assert.deepEqual(lines, [
    "ingest: every board read for the criteria edit, but full_read_at not written: permission denied",
  ]);
});
