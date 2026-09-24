import assert from "node:assert/strict";
import { test } from "node:test";

import { discover } from "../src/discover.ts";
import type { Source } from "../src/discovery/source.ts";
import type { Company } from "../src/schema.ts";
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

  // The drop is James's and stays.
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
