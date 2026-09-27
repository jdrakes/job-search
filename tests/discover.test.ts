import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reader } from "../src/ats/ats.ts";
import { discoverLine, unbindLines } from "../src/daily.ts";
import { discover, type DiscoverResult, suggestAgain, unbind } from "../src/discover.ts";
import type { BoardSource, DiscoverySource, Source } from "../src/discovery/source.ts";
import { HttpError } from "../src/net/http.ts";
import type { Board, Candidate, Company, Platform } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

// `discover` calls the real `probe` and the real `boardName`; these tests
// fake the network underneath both (`HttpOptions.fetchImpl`) and the board
// readers, so nothing leaves the process. http.ts requires a configured
// User-Agent; any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    boards: [],
    reason: null,
    dropped_at: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "seeded-1",
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

function nameSource(name: string, names: string[] | (() => Promise<string[]>)): Source {
  return { name, companies: async () => (typeof names === "function" ? names() : names) };
}

function boardSource(name: string, boards: Board[] | (() => Promise<Board[]>)): BoardSource {
  return {
    name,
    boards: async () => (typeof boards === "function" ? boards() : boards),
  };
}

type Answer = "ok" | "gone" | "down";

// A reader per platform, answering per board id: listing, 404 (gone) or 503
// (unreachable). Every board asked is recorded.
function fakeReaders(answers: Record<string, Answer>): {
  readers: Partial<Record<Platform, Reader>>;
  asked: string[];
} {
  const asked: string[] = [];
  const reader = (platform: Platform): Reader => ({
    platform,
    list: async (board) => {
      asked.push(`${board.platform}::${board.id}`);
      const answer = answers[board.id] ?? "ok";
      if (answer === "gone") throw new HttpError(404, "HTTP 404");
      if (answer === "down") throw new HttpError(503, "HTTP 503");
      return [];
    },
  });
  return {
    readers: { greenhouse: reader("greenhouse"), ashby: reader("ashby"), lever: reader("lever") },
    asked,
  };
}

// A Lever board answering `[]`, whose page's <title> is `title`: the probe
// takes it when the title names the company asked about.
function leverBoard(slug: string, title: string): Record<string, string> {
  return {
    [`https://api.lever.co/v0/postings/${slug}?mode=json`]: "[]",
    [`https://jobs.lever.co/${slug}`]: `<title>${title}</title>`,
  };
}

interface Run {
  readonly result: DiscoverResult;
  readonly lines: string[];
  readonly asked: string[];
  readonly requested: string[];
}

// `responses` maps an exact URL to a 200 body, `statuses` an exact URL to
// an empty answer with that status; every other URL is a 404.
async function run(
  store: Store,
  sources: DiscoverySource[],
  {
    answers = {},
    responses = {},
    statuses = {},
  }: {
    answers?: Record<string, Answer>;
    responses?: Record<string, string>;
    statuses?: Record<string, number>;
  } = {},
): Promise<Run> {
  const { readers, asked } = fakeReaders(answers);
  const lines: string[] = [];
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const status = statuses[url];
    if (status !== undefined) return new Response(null, { status });
    const body = responses[url];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  };
  const result = await discover(
    store,
    sources,
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
    readers,
    (line) => lines.push(line),
  );
  return { result, lines, asked, requested };
}

// Each candidate as "origin name-or-url -> outcome company", sorted: the
// store returns them by random id.
async function candidates(store: Store): Promise<string[]> {
  const rows = await store.select<Candidate>("candidates");
  return rows
    .map((row) => `${row.origin} ${row.name ?? row.url} -> ${row.outcome} ${row.company}`)
    .sort();
}

async function companyRow(store: Store, name: string): Promise<Company | undefined> {
  return (await store.select<Company>("companies", { name }))[0];
}

async function companyNames(store: Store): Promise<string[]> {
  return (await store.select<Company>("companies")).map((row) => row.name);
}

test("discover: a new name that probes to a board is watched, and its company written", async () => {
  const store = memoryStore();

  const { result, lines } = await run(store, [nameSource("hn", ["Acme"])], {
    responses: leverBoard("acme", "Acme"),
  });

  assert.deepEqual(await candidates(store), ["hn Acme -> watched Acme"]);
  assert.equal(result.suggested, 1);
  assert.equal(result.resolved.watched, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(lines, ["hn: new Acme lever::acme"]);
  assert.deepEqual(await companyRow(store, "Acme"), {
    name: "Acme",
    boards: [{ platform: "lever", id: "acme" }],
    reason: null,
    dropped_at: null,
  });
});

test("discover: a name with no board is no_board and writes no company", async () => {
  const store = memoryStore();

  const { result } = await run(store, [nameSource("hn", ["Nobody"])]);

  assert.deepEqual(await candidates(store), ["hn Nobody -> no_board null"]);
  assert.equal(result.resolved.no_board, 1);
  assert.deepEqual(await companyNames(store), []);
});

// Breaks if a board that answers under another company's name is taken
// (watched) or dropped silently (no_board).
test("discover: a name whose only answering board names another company is wrong_company, logged", async () => {
  const store = memoryStore();

  const { result, lines } = await run(store, [nameSource("hn", ["Evolve"])], {
    responses: leverBoard("evolve", "Contoso"),
  });

  assert.deepEqual(await candidates(store), ["hn Evolve -> wrong_company null"]);
  assert.equal(result.resolved.wrong_company, 1);
  assert.deepEqual(await companyNames(store), []);
  assert.deepEqual(lines, ['hn Evolve: wrong_company lever::evolve names "Contoso"']);
});

test("discover: a board whose page loads and names nobody is wrong_company, logged as naming nobody", async () => {
  const store = memoryStore();

  const { result, lines } = await run(store, [nameSource("hn", ["Evolve"])], {
    responses: {
      "https://api.lever.co/v0/postings/evolve?mode=json": "[]",
      "https://jobs.lever.co/evolve": "<html><head><meta charset='utf-8'></head></html>",
    },
  });

  assert.deepEqual(await candidates(store), ["hn Evolve -> wrong_company null"]);
  assert.equal(result.resolved.wrong_company, 1);
  assert.deepEqual(lines, ["hn Evolve: wrong_company lever::evolve names nobody"]);
});

// A name page that does not answer is not a page naming nobody: a 403 from
// bot protection or a one-off 503 (the probe does not retry) would
// otherwise file a real company as wrong_company for good. Breaks if the
// probe reads the name page through boardName again.
// The log line is http.ts's message: a retryable status says how many
// retries it made, and the probe makes none.
for (const [status, logged] of [
  [403, "HTTP 403"],
  [404, "HTTP 404"],
  [503, "HTTP 503 after 0 retries"],
] as const) {
  test(`discover: a name page answering ${status} leaves the name pending, and the next call probes it again`, async () => {
    const store = memoryStore();
    const source = nameSource("hn", ["Evolve"]);

    const first = await run(store, [source], {
      responses: { "https://api.lever.co/v0/postings/evolve?mode=json": "[]" },
      statuses: { "https://jobs.lever.co/evolve": status },
    });

    assert.deepEqual(await candidates(store), ["hn Evolve -> null null"]);
    assert.equal(first.result.pending, 1);
    assert.equal(first.result.resolved.wrong_company, 0);
    assert.deepEqual(first.lines, [`hn Evolve: ${logged}`]);

    const second = await run(store, [source], { responses: leverBoard("evolve", "Evolve") });

    assert.ok(second.requested.includes("https://jobs.lever.co/evolve"), "probed again");
    assert.deepEqual(await candidates(store), ["hn Evolve -> watched Evolve"]);
    assert.deepEqual(second.lines, ["hn: new Evolve lever::evolve"]);
  });
}

// A refused board on one platform does not outweigh a matching board on
// another.
test("discover: a name with one matching board and one refused board is watched on the matching one", async () => {
  const store = memoryStore();

  const { lines } = await run(store, [nameSource("hn", ["Acme"])], {
    responses: {
      ...leverBoard("acme", "Contoso"),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": JSON.stringify({
        jobs: [{ id: "1", company_name: "Acme" }],
      }),
    },
  });

  assert.deepEqual(await candidates(store), ["hn Acme -> watched Acme"]);
  assert.deepEqual(lines, ["hn: new Acme greenhouse::acme"]);
});

test("discover: a company's name from a second source is known, with a row, and not probed", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "lever", id: "acme" }] })],
    candidates: [candidate({ name: "Acme", origin: "hn", outcome: "watched", company: "Acme" })],
  });

  const { result, requested } = await run(store, [nameSource("remoteok", ["ACME"])]);

  assert.deepEqual(requested, []);
  assert.deepEqual(await candidates(store), [
    "hn Acme -> watched Acme",
    "remoteok ACME -> known Acme",
  ]);
  assert.equal(result.suggested, 1);
  assert.equal(result.resolved.known, 1);
});

test("discover: a name known only as a resolved candidate is known with no company, and not probed", async () => {
  const store = memoryStore({
    candidates: [candidate({ name: "Nobody", origin: "hn", outcome: "no_board" })],
  });

  const { requested } = await run(store, [nameSource("remoteok", ["Nobody"])]);

  assert.deepEqual(requested, []);
  assert.deepEqual(await candidates(store), [
    "hn Nobody -> no_board null",
    "remoteok Nobody -> known null",
  ]);
});

test("discover: a company with no board is known by name, not probed, and untouched", async () => {
  const store = memoryStore({ companies: [company("Pocketly")] });

  const { requested } = await run(store, [nameSource("hn", ["Pocketly"])]);

  assert.deepEqual(requested, []);
  assert.deepEqual(await candidates(store), ["hn Pocketly -> known Pocketly"]);
  assert.deepEqual(await companyRow(store, "Pocketly"), company("Pocketly"));
});

// Unlike an ordinary name, a `gone` candidate for a company already on file
// (one that just lost its last board) skips the known-name arm above and is
// probed like a brand new name; a board found is added to that same company,
// never a second row.
test("discover: a gone candidate for a known company with no board is probed, and a found board is added to it", async () => {
  const store = memoryStore({
    companies: [company("Pocketly")],
    candidates: [
      candidate({
        name: "Pocketly",
        origin: "gone",
        evidence: "board lever/pocketly answered gone",
      }),
    ],
  });

  const { result, lines, requested } = await run(store, [], {
    responses: leverBoard("pocketly", "Pocketly"),
  });

  assert.notDeepEqual(requested, [], "the known name was probed, not skipped");
  assert.deepEqual(await candidates(store), ["gone Pocketly -> added Pocketly"]);
  assert.equal(result.resolved.added, 1);
  assert.deepEqual(lines, ["gone: added Pocketly lever::pocketly"]);
  assert.deepEqual(await companyRow(store, "Pocketly"), {
    name: "Pocketly",
    boards: [{ platform: "lever", id: "pocketly" }],
    reason: null,
    dropped_at: null,
  });
});

test("discover: a gone candidate for a known company whose probe finds no board is no_board, and the company stays boardless", async () => {
  const store = memoryStore({
    companies: [company("Pocketly")],
    candidates: [
      candidate({
        name: "Pocketly",
        origin: "gone",
        evidence: "board lever/pocketly answered gone",
      }),
    ],
  });

  const { result } = await run(store, []);

  assert.deepEqual(await candidates(store), ["gone Pocketly -> no_board null"]);
  assert.equal(result.resolved.no_board, 1);
  assert.deepEqual(await companyRow(store, "Pocketly"), company("Pocketly"));
});

// A company that lost one board and keeps another is suggested again too.
// Breaks if the alias check counts the company's own board as another
// company's, which resolved it as its own alias.
test("discover: a gone candidate whose probe finds only a board its company still carries is known, not alias", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "lever", id: "acme" }] })],
    candidates: [
      candidate({ name: "Acme", origin: "gone", evidence: "board greenhouse/acme answered gone" }),
    ],
  });

  const { lines } = await run(store, [], { responses: leverBoard("acme", "Acme") });

  assert.deepEqual(await candidates(store), ["gone Acme -> known Acme"]);
  assert.deepEqual(lines, []);
  assert.deepEqual(
    await companyRow(store, "Acme"),
    company("Acme", { boards: [{ platform: "lever", id: "acme" }] }),
  );
});

test("discover: a gone candidate whose probe finds its own board and a new one adds only the new one", async () => {
  const store = memoryStore({
    companies: [company("Acme", { boards: [{ platform: "lever", id: "acme" }] })],
    candidates: [
      candidate({ name: "Acme", origin: "gone", evidence: "board ashby/acme answered gone" }),
    ],
  });

  const { lines } = await run(store, [], {
    responses: {
      ...leverBoard("acme", "Acme"),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": JSON.stringify({
        jobs: [{ id: "1", company_name: "Acme" }],
      }),
    },
  });

  assert.deepEqual(await candidates(store), ["gone Acme -> added Acme"]);
  assert.deepEqual(lines, ["gone: added Acme greenhouse::acme"]);
  assert.deepEqual(
    await companyRow(store, "Acme"),
    company("Acme", {
      boards: [
        { platform: "lever", id: "acme" },
        { platform: "greenhouse", id: "acme" },
      ],
    }),
  );
});

// Breaks if a gone candidate returns no_board before logging its refusals.
test("discover: a gone candidate whose only answering board names another company is no_board, and the refusal is logged", async () => {
  const store = memoryStore({
    companies: [company("Evolve")],
    candidates: [
      candidate({ name: "Evolve", origin: "gone", evidence: "board ashby/evolve answered gone" }),
    ],
  });

  const { lines } = await run(store, [], { responses: leverBoard("evolve", "Contoso") });

  assert.deepEqual(await candidates(store), ["gone Evolve -> no_board null"]);
  assert.deepEqual(lines, ['gone Evolve: wrong_company lever::evolve names "Contoso"']);
});

// Breaks if a found board is reported added while no row took it.
test("discover: a gone candidate whose company row is missing is no_board and writes no company", async () => {
  const store = memoryStore({
    candidates: [
      candidate({ name: "Ghost", origin: "gone", evidence: "board ashby/ghost answered gone" }),
    ],
  });

  const { lines } = await run(store, [], { responses: leverBoard("ghost", "Ghost") });

  assert.deepEqual(await candidates(store), ["gone Ghost -> no_board null"]);
  assert.deepEqual(lines, []);
  assert.deepEqual(await companyNames(store), []);
});

// Projected and sorted: the store returns candidates by random id.
async function goneRows(store: Store): Promise<object[]> {
  const rows = await store.select<Candidate>("candidates");
  return rows
    .map((row) => ({
      name: row.name,
      url: row.url,
      origin: row.origin,
      evidence: row.evidence,
      outcome: row.outcome,
      company: row.company,
    }))
    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
}

// Breaks if the name is parsed back out of a display label, which cut a
// multi-word name at its first space.
test("suggestAgain: one candidate per company, named in full and carrying the board as evidence", async () => {
  const store = memoryStore();

  const inserted = await suggestAgain(store, [
    { company: "Wellspring Health", board: { platform: "greenhouse", id: "wellspring" } },
    { company: "Globex", board: { platform: "lever", id: "globex-lv" } },
  ]);

  assert.equal(inserted, 2);
  assert.deepEqual(await goneRows(store), [
    {
      name: "Globex",
      url: null,
      origin: "gone",
      evidence: "board lever/globex-lv answered gone",
      outcome: null,
      company: null,
    },
    {
      name: "Wellspring Health",
      url: null,
      origin: "gone",
      evidence: "board greenhouse/wellspring answered gone",
      outcome: null,
      company: null,
    },
  ]);
});

// Breaks if suggestAgain stops grouping by company.
test("suggestAgain: two gone boards of one company give one candidate naming both", async () => {
  const store = memoryStore();

  const inserted = await suggestAgain(store, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
    { company: "Acme", board: { platform: "lever", id: "acme-lv" } },
  ]);

  assert.equal(inserted, 1);
  assert.deepEqual(await goneRows(store), [
    {
      name: "Acme",
      url: null,
      origin: "gone",
      evidence: "boards greenhouse/acme-gh lever/acme-lv answered gone",
      outcome: null,
      company: null,
    },
  ]);
});

// Counts every write by table, passing each through.
function countingWrites(inner: Store): { store: Store; writes: string[] } {
  const writes: string[] = [];
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      writes.push(table);
      return inner.upsert(table, rows);
    },
  };
  return { store, writes };
}

// Breaks if the removal drops the sibling, deletes the emptied row, stops
// suggesting the company again, stops naming the company left with no
// board, or removes a board before the candidates are written.
test("unbind: each gone board leaves its company, siblings and rows kept, and each company is suggested once", async () => {
  const { store, writes } = countingWrites(
    memoryStore({
      companies: [
        company("Acme", {
          boards: [
            { platform: "greenhouse", id: "acme-gh" },
            { platform: "lever", id: "acme-lv" },
          ],
        }),
        company("Wellspring Health", { boards: [{ platform: "ashby", id: "wellspring" }] }),
      ],
    }),
  );

  const result = await unbind(store, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
    { company: "Wellspring Health", board: { platform: "ashby", id: "wellspring" } },
  ]);

  assert.deepEqual(result, {
    ok: true,
    value: { removed: 2, suggested: 2, boardless: ["Wellspring Health"], errors: [] },
  });
  assert.deepEqual(await store.select<Company>("companies"), [
    company("Acme", { boards: [{ platform: "lever", id: "acme-lv" }] }),
    company("Wellspring Health"),
  ]);
  assert.deepEqual((await store.select<Candidate>("candidates")).map((row) => row.name).sort(), [
    "Acme",
    "Wellspring Health",
  ]);
  assert.deepEqual(writes, ["candidates", "companies", "companies"]);
});

// Breaks if two gone boards of one company cost two read-modify-writes,
// where the second, from a stale row, would put the first board back.
test("unbind: two gone boards of one company are removed in one write", async () => {
  const { store, writes } = countingWrites(
    memoryStore({
      companies: [
        company("Acme", {
          boards: [
            { platform: "greenhouse", id: "acme-gh" },
            { platform: "lever", id: "acme-lv" },
            { platform: "ashby", id: "acme" },
          ],
        }),
      ],
    }),
  );

  const result = await unbind(store, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
    { company: "Acme", board: { platform: "lever", id: "acme-lv" } },
  ]);

  assert.deepEqual(result, {
    ok: true,
    value: { removed: 2, suggested: 1, boardless: [], errors: [] },
  });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "ashby", id: "acme" }]);
  assert.deepEqual(writes, ["candidates", "companies"]);
});

// Breaks if a board is matched by id alone, or if an already-absent board
// costs a write.
test("unbind: a board already off its company costs no write and the company is still suggested", async () => {
  const { store, writes } = countingWrites(
    memoryStore({
      companies: [company("Acme", { boards: [{ platform: "lever", id: "acme" }] })],
    }),
  );

  const result = await unbind(store, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme" } },
  ]);

  assert.deepEqual(result, {
    ok: true,
    value: { removed: 0, suggested: 1, boardless: [], errors: [] },
  });
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.deepEqual(row?.boards, [{ platform: "lever", id: "acme" }]);
  assert.deepEqual(writes, ["candidates"]);
});

// Breaks if a company deleted since the list phase is written back or
// suggested again.
test("unbind: a company whose row is gone is neither written nor suggested", async () => {
  const { store, writes } = countingWrites(memoryStore());

  const result = await unbind(store, [
    { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
  ]);

  assert.deepEqual(result, {
    ok: true,
    value: { removed: 0, suggested: 0, boardless: [], errors: [] },
  });
  assert.deepEqual(await store.select<Company>("companies"), []);
  assert.deepEqual(writes, []);
});

// Refuses every write to `table` that `refuses` matches, passing the rest
// through.
function refusing(
  inner: Store,
  table: string,
  refuses: (rows: readonly unknown[]) => boolean,
): Store {
  return {
    ...inner,
    async upsert(written, rows) {
      if (written === table && refuses(rows)) throw new Error(`${table}: refused`);
      return inner.upsert(written, rows);
    },
  };
}

function twoOneBoardCompanies(): Store {
  return memoryStore({
    companies: [
      company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
      company("Globex", { boards: [{ platform: "lever", id: "globex-lv" }] }),
    ],
  });
}

const BOTH_GONE = [
  { company: "Acme", board: { platform: "greenhouse", id: "acme-gh" } },
  { company: "Globex", board: { platform: "lever", id: "globex-lv" } },
] as const;

// Breaks if a refused removal ends the call, which left every company
// after it bound, or if removals come before the candidates, which left
// every company before it boardless with no candidate: lost for good.
test("unbind: a refused removal is one error line, that board stays bound, and every company still has its candidate", async () => {
  const store = refusing(twoOneBoardCompanies(), "companies", (rows) =>
    rows.some((row) => (row as Company).name === "Globex"),
  );

  const result = await unbind(store, BOTH_GONE);

  assert.deepEqual(result, {
    ok: true,
    value: {
      removed: 1,
      suggested: 2,
      boardless: ["Acme"],
      errors: ["Globex: removing lever/globex-lv: companies: refused"],
    },
  });
  assert.deepEqual(await store.select<Company>("companies"), [
    company("Acme"),
    company("Globex", { boards: [{ platform: "lever", id: "globex-lv" }] }),
  ]);
  assert.deepEqual((await store.select<Candidate>("candidates")).map((row) => row.name).sort(), [
    "Acme",
    "Globex",
  ]);
});

// Breaks if a board is removed before its company's candidate is written,
// or if the refused write is thrown instead of returned.
test("unbind: a refused candidates write removes no board and is returned as the reason", async () => {
  const store = refusing(twoOneBoardCompanies(), "candidates", () => true);

  const result = await unbind(store, BOTH_GONE);

  assert.deepEqual(result, { ok: false, reason: "candidates: refused" });
  assert.deepEqual(await store.select<Company>("companies"), [
    company("Acme", { boards: [{ platform: "greenhouse", id: "acme-gh" }] }),
    company("Globex", { boards: [{ platform: "lever", id: "globex-lv" }] }),
  ]);
});

// Breaks if the count line drops the error count, or a company left with
// no board or a refused removal goes unlogged.
test("unbindLines: the counts, then each company left with no board, then each error", () => {
  assert.deepEqual(
    unbindLines({
      removed: 3,
      suggested: 4,
      boardless: ["Acme", "Wellspring Health"],
      errors: ["Globex: removing lever/globex-lv: companies: refused"],
    }),
    [
      "unbind: 3 boards removed, 4 suggested, 1 errors",
      "  no board left: Acme",
      "  no board left: Wellspring Health",
      "  Globex: removing lever/globex-lv: companies: refused",
    ],
  );
});

test("suggestAgain: no gone boards writes nothing", async () => {
  const inner = memoryStore();
  let writes = 0;
  const store: Store = {
    ...inner,
    async upsert(table, rows) {
      writes += 1;
      return inner.upsert(table, rows);
    },
  };

  const inserted = await suggestAgain(store, []);

  assert.equal(inserted, 0);
  assert.equal(writes, 0);
});

test("discover: one origin naming a name twice, in one run or two, is one row", async () => {
  const store = memoryStore();

  const first = await run(store, [nameSource("hn", ["Nobody", "NOBODY"])]);
  const second = await run(store, [nameSource("hn", ["Nobody"])]);

  assert.equal(first.result.suggested, 1);
  assert.equal(second.result.suggested, 0);
  assert.deepEqual(second.requested, []);
  assert.deepEqual(await candidates(store), ["hn Nobody -> no_board null"]);
});

test("discover: a name whose probe finds a board another company carries is an alias, with no company row", async () => {
  const store = memoryStore({
    companies: [company("Tessera", { boards: [{ platform: "lever", id: "pocketly" }] })],
  });

  const { result, lines } = await run(store, [nameSource("hn", ["Pocketly"])], {
    responses: leverBoard("pocketly", "Pocketly"),
  });

  assert.deepEqual(await candidates(store), ["hn Pocketly -> alias Tessera"]);
  assert.equal(result.resolved.alias, 1);
  assert.deepEqual(await companyNames(store), ["Tessera"]);
  assert.deepEqual(lines, []);
});

// Breaks if a company written in this run is not indexed by its boards
// before the next candidate: "Acme" would become a second company.
test("discover: two names probing to one board in one run are one company and one alias", async () => {
  const store = memoryStore();

  const { lines } = await run(store, [nameSource("hn", ["Acme Inc", "Acme"])], {
    responses: leverBoard("acme", "Acme Inc"),
  });

  assert.deepEqual(await candidates(store), [
    "hn Acme -> alias Acme Inc",
    "hn Acme Inc -> watched Acme Inc",
  ]);
  assert.deepEqual(await companyNames(store), ["Acme Inc"]);
  assert.deepEqual(lines, ["hn: new Acme Inc lever::acme"]);
});

test("discover: a URL whose board another company carries is that company's alias", async () => {
  const store = memoryStore({
    companies: [company("Tessera", { boards: [{ platform: "lever", id: "pocketly" }] })],
    candidates: [candidate({ name: "Pocketly", url: "https://jobs.lever.co/pocketly/abc-123" })],
  });

  const { asked } = await run(store, []);

  assert.deepEqual(asked, [], "a carried board is not read");
  assert.deepEqual(await candidates(store), ["ui Pocketly -> alias Tessera"]);
  assert.deepEqual(await companyNames(store), ["Tessera"]);
});

test("discover: a URL with no name whose board a company now carries is known to it", async () => {
  const store = memoryStore({
    companies: [company("Tessera", { boards: [{ platform: "lever", id: "pocketly" }] })],
    candidates: [candidate({ origin: "commoncrawl", url: "https://jobs.lever.co/pocketly" })],
  });

  await run(store, []);

  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.lever.co/pocketly -> known Tessera",
  ]);
});

for (const before of [[{ platform: "lever", id: "acme-old" } as const], []]) {
  test(`discover: a URL candidate named like a company with ${before.length} boards adds the board to it`, async () => {
    const store = memoryStore({
      companies: [company("Acme", { boards: before })],
      candidates: [candidate({ name: "A.C.M.E", url: "https://jobs.ashbyhq.com/acme-hq" })],
    });

    const { result, lines, asked } = await run(store, []);

    assert.deepEqual(asked, ["ashby::acme-hq"]);
    assert.deepEqual(await candidates(store), ["ui A.C.M.E -> added Acme"]);
    assert.equal(result.resolved.added, 1);
    assert.deepEqual(lines, ["ui: added Acme ashby::acme-hq"]);
    assert.deepEqual(await companyNames(store), ["Acme"]);
    assert.deepEqual(
      await companyRow(store, "Acme"),
      company("Acme", { boards: [...before, { platform: "ashby", id: "acme-hq" }] }),
    );
  });
}

test("discover: a dropped company's name is dropped, not probed, and the company untouched", async () => {
  const dropped = company("Acme", {
    boards: [{ platform: "lever", id: "acme" }],
    dropped_at: "2026-09-01T00:00:00Z",
    reason: "no staff-level roles",
  });
  const store = memoryStore({
    companies: [dropped],
    candidates: [candidate({ name: "Acme" })],
  });

  const { result, requested } = await run(store, [nameSource("hn", ["acme"])]);

  assert.deepEqual(requested, []);
  assert.deepEqual(await candidates(store), ["hn acme -> dropped Acme", "ui Acme -> dropped Acme"]);
  assert.equal(result.resolved.dropped, 2);
  assert.deepEqual(await store.select<Company>("companies"), [dropped]);
});

test("discover: a board whose page names a dropped company is dropped and the board not added", async () => {
  const dropped = company("Acme", {
    boards: [{ platform: "lever", id: "acme" }],
    dropped_at: "2026-09-01T00:00:00Z",
  });
  const store = memoryStore({ companies: [dropped] });

  const { lines } = await run(
    store,
    [boardSource("commoncrawl", [{ platform: "greenhouse", id: "acmehq" }])],
    {
      responses: {
        "https://boards-api.greenhouse.io/v1/boards/acmehq": JSON.stringify({ name: "Acme" }),
      },
    },
  );

  assert.deepEqual(await candidates(store), [
    "commoncrawl https://job-boards.greenhouse.io/acmehq -> dropped Acme",
  ]);
  assert.deepEqual(lines, []);
  assert.deepEqual(await store.select<Company>("companies"), [dropped]);
});

test("discover: a gone board is gone, writes no company, and is not suggested or read again", async () => {
  const store = memoryStore();
  const source = boardSource("commoncrawl", [{ platform: "ashby", id: "ghostco" }]);

  const first = await run(store, [source], { answers: { ghostco: "gone" } });
  const second = await run(store, [source], { answers: { ghostco: "gone" } });

  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.ashbyhq.com/ghostco -> gone null",
  ]);
  assert.equal(first.result.resolved.gone, 1);
  assert.deepEqual(await companyNames(store), []);
  assert.equal(second.result.suggested, 0);
  assert.deepEqual(second.asked, []);
});

test("discover: an unreachable board stays unresolved, is logged, and the next call retries it", async () => {
  const store = memoryStore();
  const source = boardSource("commoncrawl", [{ platform: "lever", id: "flaky" }]);

  const first = await run(store, [source], { answers: { flaky: "down" } });

  assert.equal(first.result.pending, 1);
  assert.deepEqual(first.result.errors, []);
  assert.deepEqual(first.lines, ["commoncrawl flaky lever::flaky: HTTP 503"]);
  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.lever.co/flaky -> null null",
  ]);
  assert.deepEqual(await companyNames(store), []);

  const second = await run(store, [source]);

  assert.equal(second.result.suggested, 0, "the board is not suggested twice");
  assert.deepEqual(second.asked, ["lever::flaky"]);
  assert.equal(second.result.pending, 0);
  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.lever.co/flaky -> watched flaky",
  ]);
  assert.deepEqual(second.lines, ["commoncrawl: new flaky lever::flaky"]);
});

// The board's listing answered but its name page answered 429: the vendor
// declined to name it, so the name is asked for again rather than the board
// being watched under its id. Breaks if boardName reads a 429 as no name.
test("discover: a URL candidate whose name page answers 429 stays pending, and the next call names it", async () => {
  const store = memoryStore();
  const source = boardSource("commoncrawl", [{ platform: "lever", id: "zenco" }]);

  const first = await run(store, [source], {
    statuses: { "https://jobs.lever.co/zenco": 429 },
  });

  assert.equal(first.result.pending, 1);
  assert.deepEqual(first.lines, ["commoncrawl lever::zenco: HTTP 429"]);
  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.lever.co/zenco -> null null",
  ]);
  assert.deepEqual(await companyNames(store), []);

  const second = await run(store, [source], {
    responses: { "https://jobs.lever.co/zenco": "<title>Zen Co</title>" },
  });

  assert.deepEqual(await candidates(store), [
    "commoncrawl https://jobs.lever.co/zenco -> watched Zen Co",
  ]);
  assert.deepEqual(second.lines, ["commoncrawl: new Zen Co lever::zenco"]);
});

test("discover: a URL naming no board a reader can read is bad_url and nothing is asked", async () => {
  const store = memoryStore({
    candidates: [candidate({ name: "Acme", url: "https://acme.example/careers" })],
  });

  const { result, asked, requested } = await run(store, []);

  assert.deepEqual(asked, []);
  assert.deepEqual(requested, []);
  assert.equal(result.resolved.bad_url, 1);
  assert.deepEqual(await candidates(store), ["ui Acme -> bad_url null"]);
});

test("discover: two boards naming one new company in one run make one company with both boards", async () => {
  const store = memoryStore();
  const source = boardSource("commoncrawl", [
    { platform: "ashby", id: "newco" },
    { platform: "greenhouse", id: "newcoinc" },
  ]);

  const { result, lines } = await run(store, [source], {
    responses: {
      "https://jobs.ashbyhq.com/newco": "<html><title>NewCo Jobs</title></html>",
      "https://boards-api.greenhouse.io/v1/boards/newcoinc": JSON.stringify({ name: "Newco" }),
    },
  });

  assert.deepEqual(lines, [
    "commoncrawl: new NewCo ashby::newco",
    "commoncrawl: added NewCo greenhouse::newcoinc",
  ]);
  assert.deepEqual(await companyNames(store), ["NewCo"]);
  assert.deepEqual((await companyRow(store, "NewCo"))?.boards, [
    { platform: "ashby", id: "newco" },
    { platform: "greenhouse", id: "newcoinc" },
  ]);
  assert.equal(result.resolved.watched, 1);
  assert.equal(result.resolved.added, 1);
});

test("discover: a board already carried, in any case, is not suggested", async () => {
  const store = memoryStore({
    companies: [company("Thyme", { boards: [{ platform: "lever", id: "thyme" }] })],
  });

  const { result, asked } = await run(store, [
    boardSource("commoncrawl", [{ platform: "lever", id: "Thyme" }]),
  ]);

  assert.equal(result.suggested, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(await candidates(store), []);
});

test("discover: a board whose page gives no name is watched under its id", async () => {
  const store = memoryStore();

  const { lines } = await run(store, [
    boardSource("commoncrawl", [{ platform: "lever", id: "zenco" }]),
  ]);

  assert.deepEqual(lines, ["commoncrawl: new zenco lever::zenco"]);
  assert.deepEqual(
    await companyRow(store, "zenco"),
    company("zenco", { boards: [{ platform: "lever", id: "zenco" }] }),
  );
});

test("discover: a failing source is one error line and the next source still suggests", async () => {
  const store = memoryStore();
  const broken = nameSource("hn", async () => {
    throw new Error("thread not found");
  });

  const { result } = await run(store, [broken, nameSource("remoteok", ["Nobody"])]);

  assert.deepEqual(result.errors, ["hn: thread not found"]);
  assert.deepEqual(await candidates(store), ["remoteok Nobody -> no_board null"]);
});

// Breaks if a company's line is logged only after every candidate is
// resolved: the first company landed, so its line is the only record of it.
test("discover: a store throw on the second company still logs the first and surfaces the throw", async () => {
  const inner = memoryStore();
  let companyUpserts = 0;
  const store: Store = {
    select: (...args) => inner.select(...args),
    upsert: async (table, rows) => {
      if (table === "companies") {
        companyUpserts += 1;
        if (companyUpserts === 2) throw new Error("connection reset");
      }
      return inner.upsert(table, rows);
    },
    update: (table, key, patch) => inner.update(table, key, patch),
    delete: (table, keys) => inner.delete(table, keys),
  };
  const source = boardSource("commoncrawl", [
    { platform: "lever", id: "first" },
    { platform: "lever", id: "second" },
  ]);

  const lines: string[] = [];
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  await assert.rejects(
    discover(
      store,
      [source],
      { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
      fakeReaders({}).readers,
      (line) => lines.push(line),
    ),
    /connection reset/,
  );

  assert.deepEqual(lines, ["commoncrawl: new first lever::first"]);
  assert.deepEqual(await companyNames(inner), ["first"]);
});

test("discoverLine: names every outcome's count, then pending and errors", () => {
  const result: DiscoverResult = {
    suggested: 12,
    resolved: {
      watched: 2,
      added: 1,
      known: 5,
      alias: 1,
      no_board: 3,
      wrong_company: 0,
      gone: 0,
      dropped: 0,
      bad_url: 0,
    },
    pending: 1,
    errors: ["hn: thread not found"],
  };

  assert.equal(
    discoverLine(result),
    "discover: 12 suggested, 2 watched, 1 added, 5 known, 1 alias, 3 no_board, " +
      "0 wrong_company, 0 gone, 0 dropped, 0 bad_url, 1 pending, 1 errors",
  );
});
