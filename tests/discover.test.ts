import assert from "node:assert/strict";
import { test } from "node:test";

import type { Reader } from "../src/ats/ats.ts";
import { watched } from "../src/companies.ts";
import { discover } from "../src/discover.ts";
import type { BoardSource, Source } from "../src/discovery/source.ts";
import { HttpError } from "../src/net/http.ts";
import type { Board, Company, Platform } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import type { Store } from "../src/store/store.ts";

// http.ts requires a configured User-Agent now that it no longer carries a
// built-in one (src/net/http.ts); these tests fake the network entirely, so
// any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "discovered",
    boards: [],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

function fakeSource(name: string, names: string[] | (() => Promise<string[]>)): Source {
  return {
    name,
    companies: async () => (typeof names === "function" ? names() : names),
  };
}

// Every `select` a run issues, as "table {eq filter}", to count the round
// trips a run costs the store.
function countingStore(inner: Store): { store: Store; selects: string[] } {
  const selects: string[] = [];
  const store: Store = {
    select: async <T>(...args: Parameters<Store["select"]>) => {
      const [table, eq] = args;
      selects.push(`${table} ${JSON.stringify(eq ?? {})}`);
      return inner.select<T>(...args);
    },
    upsert: (table, rows) => inner.upsert(table, rows),
    update: (table, key, patch) => inner.update(table, key, patch),
    delete: (table, keys) => inner.delete(table, keys),
  };
  return { store, selects };
}

// `discover` calls the real `probe`; these tests fake the network
// underneath it (`HttpOptions.fetchImpl`), so the already-present skip,
// the watched/discovered split and the error handling run through the
// real call path.

test("discover: a name with a board becomes watched", async () => {
  const store = memoryStore();
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io")) {
      return new Response(JSON.stringify({ jobs: [{ id: "1", company_name: "Acme" }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Acme"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.seen, 1);
  assert.equal(result.probed, 1);
  assert.equal(result.watched, 1);
  assert.deepEqual(result.errors, []);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.ok(row);
  assert.equal(row?.state, "watched");
  assert.deepEqual(row?.boards, [{ platform: "greenhouse", id: "acme" }]);
});

test("discover: a name with no board stays discovered", async () => {
  const store = memoryStore();
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  const result = await discover(store, [fakeSource("test-source", ["Nobody"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.seen, 1);
  assert.equal(result.probed, 1);
  assert.equal(result.watched, 0);

  const [row] = await store.select<Company>("companies", { name: "Nobody" });
  assert.ok(row);
  assert.equal(row?.state, "discovered");
  assert.deepEqual(row?.boards, []);
});

test("discover: a probe that answers with a board another company already carries records an alias and watches nothing", async () => {
  const store = memoryStore({
    companies: [
      company("Tessera", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "pocketly" }],
      }),
    ],
  });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io/v1/boards/pocketly")) {
      return new Response(JSON.stringify({ jobs: [{ id: "1", company_name: "Pocketly" }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Pocketly"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.probed, 1);
  assert.equal(result.watched, 0, "the alias is never watched");
  assert.equal(result.aliases, 1);

  const [row] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.ok(row);
  assert.equal(row?.state, "alias");
  assert.equal(row?.alias_of, "Tessera");
  assert.equal(row?.reason, null);

  const [tessera] = await store.select<Company>("companies", { name: "Tessera" });
  assert.equal(tessera?.state, "watched");
});

test("discover: a probe that answers with a new board is watched as today", async () => {
  const store = memoryStore({
    companies: [
      company("Tessera", {
        state: "watched",
        boards: [{ platform: "greenhouse", id: "pocketly" }],
      }),
    ],
  });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("boards-api.greenhouse.io/v1/boards/acme")) {
      return new Response(JSON.stringify({ jobs: [{ id: "1", company_name: "Acme" }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Acme"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.watched, 1);
  assert.equal(result.aliases, 0);

  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.state, "watched");
  assert.equal(row?.reason, null);
});

test("discover: two new names probing to one board in the same run are one company and one alias", async () => {
  const store = memoryStore({ companies: [] });
  // "Acme Inc" reduces to the slug `acme`, which is also "Acme"'s own.
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.lever.co/v0/postings/acme?mode=json") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Acme Inc", "Acme"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.probed, 2);
  assert.equal(result.watched, 1, "the second spelling is not watched as a second company");
  assert.equal(result.aliases, 1);

  const [first] = await store.select<Company>("companies", { name: "Acme Inc" });
  assert.equal(first?.state, "watched");
  assert.equal(first?.reason, null);

  const [second] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(second?.state, "alias");
  assert.equal(second?.alias_of, "Acme Inc");
  assert.equal(second?.reason, null);
});

test("discover: a name already recorded as an alias is not probed again", async () => {
  const store = memoryStore({
    companies: [company("Pocketly", { state: "alias", alias_of: "Tessera" })],
  });
  let requested = false;
  const fetchImpl: typeof fetch = async () => {
    requested = true;
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Pocketly"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.probed, 0);
  assert.equal(requested, false);

  const [row] = await store.select<Company>("companies", { name: "Pocketly" });
  assert.equal(row?.state, "alias");
  assert.equal(row?.alias_of, "Tessera");
});

test("discover: a name already in companies is never probed", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        dropped_at: "2026-09-01T00:00:00Z",
        reason: "no staff-level roles",
        last_seen: "2026-09-01T00:00:00Z",
      }),
    ],
  });
  let requested = false;
  const fetchImpl: typeof fetch = async () => {
    requested = true;
    return new Response(null, { status: 404 });
  };

  const result = await discover(store, [fakeSource("test-source", ["Acme"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.seen, 1);
  assert.equal(result.probed, 0);
  assert.equal(requested, false);

  // The drop is the operator's and stays.
  const [row] = await store.select<Company>("companies", { name: "Acme" });
  assert.equal(row?.dropped_at, "2026-09-01T00:00:00Z");
  assert.equal(row?.reason, "no staff-level roles");
});

test("discover: known names cost one query for the whole run, not one each", async () => {
  const { store, selects } = countingStore(
    memoryStore({
      companies: [company("Acme"), company("Beta"), company("Cog", { state: "alias" })],
    }),
  );
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  const result = await discover(store, [fakeSource("test-source", ["Acme", "Beta", "Cog"])], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.seen, 3);
  assert.equal(result.probed, 0);
  // One unfiltered read of `companies`, and nothing per name.
  assert.deepEqual(selects, ["companies {}"]);
});

test("discover: a new name is probed once even when two sources name it", async () => {
  const { store, selects } = countingStore(memoryStore());
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  const result = await discover(
    store,
    [fakeSource("first", ["Nobody"]), fakeSource("second", ["Nobody"])],
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );

  assert.equal(result.seen, 2);
  assert.equal(result.probed, 1, "the second sighting must not spend another probe");
  assert.deepEqual(selects, ["companies {}", 'companies {"name":"Nobody"}']);
});

test("discover: a failing source is one error line naming the cause, and the other source still lands", async () => {
  const store = memoryStore();
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  // The shape Node's fetch throws for a network-level fault: the reason is
  // in `cause`, not `message`.
  const failing = fakeSource("broken", () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  });
  const working = fakeSource("test-source", ["Nobody"]);

  const result = await discover(store, [failing, working], {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0], "broken: fetch failed <- read ECONNRESET (ECONNRESET)");
  assert.equal(result.seen, 1);
  assert.equal(result.probed, 1);

  const rows = await store.select<Company>("companies");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Nobody"],
  );
});

// The board path. A fake board source names boards and, per board id, the
// company name its page states; fake readers answer, 404 (gone) or 503
// (unreachable) per board id. Nothing touches the network.

type Answer = "ok" | "gone" | "down";

function fakeBoardSource(
  name: string,
  boards: Board[] | (() => Promise<Board[]>),
  names: Record<string, string | null> = {},
): { source: BoardSource; namesAsked: string[] } {
  const namesAsked: string[] = [];
  const source: BoardSource = {
    name,
    boards: async () => (typeof boards === "function" ? boards() : boards),
    companyName: async (board) => {
      namesAsked.push(board.id);
      return names[board.id] ?? null;
    },
  };
  return { source, namesAsked };
}

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

async function runBoards(
  store: Store,
  sources: (BoardSource | Source)[],
  answers: Record<string, Answer> = {},
): Promise<{ result: Awaited<ReturnType<typeof discover>>; lines: string[]; asked: string[] }> {
  const { readers, asked } = fakeReaders(answers);
  const lines: string[] = [];
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
  const result = await discover(
    store,
    sources,
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
    readers,
    (line) => lines.push(line),
  );
  return { result, lines, asked };
}

async function row(store: Store, name: string): Promise<Company | undefined> {
  return (await store.select<Company>("companies", { name }))[0];
}

test("discover boards: a board already carried under different case is not asked", async () => {
  const store = memoryStore({
    companies: [
      company("Thyme", { state: "watched", boards: [{ platform: "lever", id: "thyme" }] }),
    ],
  });
  const { source, namesAsked } = fakeBoardSource("crawl", [{ platform: "lever", id: "Thyme" }]);

  const { result, lines, asked } = await runBoards(store, [source]);

  assert.deepEqual(asked, []);
  assert.deepEqual(namesAsked, []);
  assert.deepEqual(lines, []);
  assert.equal(result.seen, 1);
  assert.equal(result.probed, 0);
  assert.equal((await store.select<Company>("companies")).length, 1);
});

test("discover boards: a board naming no company on file is watched under the name its page states", async () => {
  const store = memoryStore({ companies: [company("Other")] });
  const { source } = fakeBoardSource("crawl", [{ platform: "ashby", id: "thyme-care" }], {
    "thyme-care": "Thyme Care",
  });

  const { result, lines } = await runBoards(store, [source]);

  assert.equal(result.watched, 1);
  assert.equal(result.probed, 1);
  assert.deepEqual(lines, ["crawl: new Thyme Care ashby::thyme-care"]);
  const created = await row(store, "Thyme Care");
  assert.equal(created?.state, "watched");
  assert.equal(created?.source, "crawl");
  assert.deepEqual(created?.boards, [{ platform: "ashby", id: "thyme-care" }]);
});

test("discover boards: a board whose name cannot be read is watched under its id", async () => {
  const store = memoryStore();
  const { source } = fakeBoardSource("crawl", [{ platform: "lever", id: "Zenco" }], {
    Zenco: null,
  });

  const { lines } = await runBoards(store, [source]);

  assert.deepEqual(lines, ["crawl: new Zenco lever::Zenco"]);
  const created = await row(store, "Zenco");
  assert.equal(created?.state, "watched");
  assert.deepEqual(created?.boards, [{ platform: "lever", id: "Zenco" }]);
});

for (const existing of [
  company("Acme", { state: "watched", boards: [{ platform: "lever", id: "acme-old" }] }),
  company("Acme", { state: "discovered" }),
]) {
  test(`discover boards: a board naming a ${existing.state} company on file joins it rather than making a second row`, async () => {
    const store = memoryStore({ companies: [existing] });
    // "A.C.M.E" squashes to "acme", as "Acme" does.
    const { source } = fakeBoardSource("crawl", [{ platform: "greenhouse", id: "acmehq" }], {
      acmehq: "A.C.M.E",
    });

    const { result, lines } = await runBoards(store, [source]);

    assert.deepEqual(lines, ["crawl: added Acme greenhouse::acmehq"]);
    assert.deepEqual(
      (await store.select<Company>("companies")).map((company) => company.name),
      ["Acme"],
    );
    const joined = await row(store, "Acme");
    assert.equal(joined?.state, "watched");
    assert.deepEqual(joined?.boards, [
      ...existing.boards,
      { platform: "greenhouse", id: "acmehq" },
    ]);
    assert.equal(joined?.source, "test", "the row keeps the source that first named it");
    assert.equal(result.watched, 1);
  });
}

test("discover boards: a board whose name is an alias joins the company the alias names", async () => {
  const store = memoryStore({
    companies: [
      company("Acme Corp", { state: "watched", boards: [{ platform: "lever", id: "acmecorp" }] }),
      company("Acme", { state: "alias", alias_of: "Acme Corp" }),
    ],
  });
  const { source } = fakeBoardSource("crawl", [{ platform: "ashby", id: "acme" }], {
    acme: "Acme",
  });

  const { lines } = await runBoards(store, [source]);

  assert.deepEqual(lines, ["crawl: added Acme Corp ashby::acme"]);
  assert.deepEqual((await row(store, "Acme Corp"))?.boards, [
    { platform: "lever", id: "acmecorp" },
    { platform: "ashby", id: "acme" },
  ]);
  const alias = await row(store, "Acme");
  assert.equal(alias?.state, "alias");
  assert.deepEqual(alias?.boards, []);
});

test("discover boards: a board naming a dropped company joins it and the drop stays", async () => {
  const store = memoryStore({
    companies: [
      company("Acme", {
        state: "watched",
        boards: [{ platform: "lever", id: "acme-old" }],
        dropped_at: "2026-09-01T00:00:00Z",
        reason: "no staff-level roles",
      }),
    ],
  });
  const { source } = fakeBoardSource("crawl", [{ platform: "greenhouse", id: "acme" }], {
    acme: "Acme",
  });

  const { lines } = await runBoards(store, [source]);

  assert.deepEqual(lines, ["crawl: added Acme greenhouse::acme"]);
  const joined = await row(store, "Acme");
  assert.equal(joined?.dropped_at, "2026-09-01T00:00:00Z");
  assert.equal(joined?.reason, "no staff-level roles");
  assert.deepEqual(joined?.boards, [
    { platform: "lever", id: "acme-old" },
    { platform: "greenhouse", id: "acme" },
  ]);
  assert.deepEqual(await watched(store), []);
});

test("discover boards: two boards naming one new company in one run make one row with both boards", async () => {
  const store = memoryStore();
  const { source } = fakeBoardSource(
    "crawl",
    [
      { platform: "ashby", id: "newco" },
      { platform: "greenhouse", id: "newcoinc" },
    ],
    { newco: "NewCo", newcoinc: "Newco" },
  );

  const { result, lines } = await runBoards(store, [source]);

  assert.deepEqual(lines, [
    "crawl: new NewCo ashby::newco",
    "crawl: added NewCo greenhouse::newcoinc",
  ]);
  const rows = await store.select<Company>("companies");
  assert.deepEqual(
    rows.map((company) => company.name),
    ["NewCo"],
  );
  assert.deepEqual(rows[0]?.boards, [
    { platform: "ashby", id: "newco" },
    { platform: "greenhouse", id: "newcoinc" },
  ]);
  assert.equal(rows[0]?.state, "watched");
  assert.equal(result.errors.length, 0);
});

test("discover boards: a dead board whose id reads like a company on file writes nothing and is asked again", async () => {
  const before = company("Acme", {
    state: "watched",
    boards: [{ platform: "lever", id: "acme-real" }],
  });
  const store = memoryStore({ companies: [before] });
  const { source } = fakeBoardSource("crawl", [{ platform: "ashby", id: "acme" }]);

  const first = await runBoards(store, [source], { acme: "gone" });

  assert.deepEqual(first.lines, []);
  assert.deepEqual(first.result.errors, []);
  assert.deepEqual(await store.select<Company>("companies"), [before]);

  const second = await runBoards(store, [source], { acme: "gone" });
  assert.deepEqual(second.asked, ["ashby::acme"]);
  assert.deepEqual(await store.select<Company>("companies"), [before]);
});

test("discover boards: a dead board naming no company is discovered carrying it and not asked again", async () => {
  const store = memoryStore();
  const { source, namesAsked } = fakeBoardSource("crawl", [{ platform: "ashby", id: "ghostco" }]);

  const first = await runBoards(store, [source], { ghostco: "gone" });

  assert.deepEqual(first.lines, ["crawl: new ghostco ashby::ghostco (gone)"]);
  assert.deepEqual(namesAsked, [], "a dead board's name is not read");
  const created = await row(store, "ghostco");
  assert.equal(created?.state, "discovered");
  assert.equal(created?.source, "crawl");
  assert.deepEqual(created?.boards, [{ platform: "ashby", id: "ghostco" }]);

  const second = await runBoards(store, [source], { ghostco: "gone" });
  assert.deepEqual(second.asked, []);
  assert.deepEqual(second.lines, []);
});

test("discover boards: an unreachable board writes nothing and is one error line", async () => {
  const store = memoryStore();
  const { source } = fakeBoardSource("crawl", [{ platform: "greenhouse", id: "flaky" }]);

  const { result, lines } = await runBoards(store, [source], { flaky: "down" });

  assert.deepEqual(result.errors, ["crawl flaky greenhouse::flaky: HTTP 503"]);
  assert.deepEqual(lines, []);
  assert.deepEqual(await store.select<Company>("companies"), []);
});

test("discover boards: a boards() throw is one error line and the next source still runs", async () => {
  const store = memoryStore();
  const { source: broken } = fakeBoardSource("crawl", async () => {
    throw new Error("collinfo.json names no crawl index");
  });
  const { source: working } = fakeBoardSource("second", [{ platform: "lever", id: "fine" }], {
    fine: "Fine",
  });

  const { result, lines } = await runBoards(store, [broken, working]);

  assert.deepEqual(result.errors, ["crawl: collinfo.json names no crawl index"]);
  assert.deepEqual(lines, ["second: new Fine lever::fine"]);
  assert.equal((await row(store, "Fine"))?.state, "watched");
});

// Breaks if discoverBoards stops passing its `log` to `boards()`: the
// source's own partial-failure line would vanish.
test("discover boards: a source's partial-failure line reaches the log and its boards are still watched", async () => {
  const store = memoryStore();
  const source: BoardSource = {
    name: "crawl",
    boards: async (_options, log) => {
      log?.("test source: partial failure");
      return [{ platform: "lever", id: "fine" }];
    },
    companyName: async () => "Fine",
  };

  const { result, lines } = await runBoards(store, [source]);

  assert.deepEqual(lines, ["test source: partial failure", "crawl: new Fine lever::fine"]);
  assert.deepEqual(result.errors, []);
  assert.equal((await row(store, "Fine"))?.state, "watched");
});

// Breaks if the board lines are logged after the whole batch is written:
// the first board landed, so its line is the only record of it.
test("discover boards: a store throw on the second board still logs the first and surfaces the throw", async () => {
  const inner = memoryStore();
  let upserts = 0;
  const store: Store = {
    select: (...args) => inner.select(...args),
    upsert: async (table, rows) => {
      upserts += 1;
      if (upserts === 2) throw new Error("connection reset");
      return inner.upsert(table, rows);
    },
    update: (table, key, patch) => inner.update(table, key, patch),
    delete: (table, keys) => inner.delete(table, keys),
  };
  const { source } = fakeBoardSource(
    "crawl",
    [
      { platform: "ashby", id: "first" },
      { platform: "lever", id: "second" },
    ],
    { first: "First Co", second: "Second Co" },
  );
  const { readers } = fakeReaders({});
  const lines: string[] = [];

  await assert.rejects(
    discover(
      store,
      [source],
      { userAgent: TEST_USER_AGENT, sleep: async () => {} },
      readers,
      (line) => lines.push(line),
    ),
    /connection reset/,
  );

  assert.deepEqual(lines, ["crawl: new First Co ashby::first"]);
  assert.equal((await row(inner, "First Co"))?.state, "watched");
});
