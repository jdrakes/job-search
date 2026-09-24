import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

import pg from "pg";

import type { Company, Posting } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import { openStore } from "../src/store/open.ts";
import { postgresStore } from "../src/store/postgres.ts";
import { storeStats } from "../src/store/stats.ts";
import type { Store } from "../src/store/store.ts";

// The contract: one set of cases, run against every adapter. Each case
// touches only rows whose key starts with a prefix unique to (adapter,
// case), so the Postgres half can share a real database. `criteria` is the
// single live row James's pipeline reads, so the contract exercises
// `postings` and `companies` only.

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

function posting(key: string, overrides: Partial<Posting> = {}): Posting {
  return {
    key,
    company: key.split("::")[0] ?? key,
    platform: "greenhouse",
    board: "acme",
    title: "Engineer",
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2026-09-15T00:00:00Z",
    last_seen: "2026-09-15T00:00:00Z",
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

interface ContractCase {
  readonly name: string;
  readonly run: (store: Store, prefix: string) => Promise<void>;
}

const CASES: readonly ContractCase[] = [
  {
    name: "select returns the row upsert wrote, filtered by eq",
    run: async (store, prefix) => {
      const name = `${prefix}-acme`;
      await store.upsert("companies", [company(name, { state: "watched" })]);

      const read = await store.select<Company>("companies", { name });
      assert.equal(read.length, 1);
      assert.equal(read[0]?.state, "watched");

      const missed = await store.select<Company>("companies", { name: `${prefix}-nobody` });
      assert.equal(missed.length, 0);
    },
  },
  {
    name: "upsert replaces the row holding that primary key instead of adding a second one",
    run: async (store, prefix) => {
      const name = `${prefix}-acme`;
      await store.upsert("companies", [company(name, { state: "discovered", source: "seed" })]);
      await store.upsert("companies", [company(name, { state: "watched", source: "seed" })]);

      const read = await store.select<Company>("companies", { name });
      assert.equal(read.length, 1, "a second upsert of the same key must not add a row");
      assert.equal(read[0]?.state, "watched");
    },
  },
  {
    // `src/ingest.ts` writes a partial row on every re-list, so the two
    // adapters have to agree on what an absent column means. Postgres is
    // the authority: the upsert writes the columns the object names and
    // leaves the rest alone.
    name: "upsert of a partial row writes the named columns and leaves the absent ones stored",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [
        posting(key, { title: "Old Title", body: "stored body", status: "applied" }),
      ]);

      await store.upsert("postings", [
        {
          key,
          company: key.split("::")[0],
          title: "New Title",
          last_seen: "2026-09-16T00:00:00Z",
        },
      ]);

      const read = await store.select<Posting>("postings", { key });
      assert.equal(read.length, 1, "a partial upsert must not add a second row");
      assert.equal(read[0]?.title, "New Title");
      assert.equal(read[0]?.body, "stored body", "a column absent from the payload must be kept");
      assert.equal(read[0]?.status, "applied");
    },
  },
  {
    // `src/ingest.ts` sends one batch per company, mixing shapes (a body,
    // a comp only, neither); each adapter is what groups a mixed batch,
    // not the caller.
    name: "upsert of a mixed batch writes every row its own shape, and an omitted column keeps its stored value",
    run: async (store, prefix) => {
      const withBody = `${prefix}::body`;
      const withComp = `${prefix}::comp`;
      const bare = `${prefix}::bare`;
      const company = withBody.split("::")[0];
      const lastSeen = "2026-09-18T00:00:00Z";

      await store.upsert("postings", [
        posting(withBody, { title: "Body Role", body: "a long body", status: "applied" }),
        {
          key: withComp,
          company,
          last_seen: lastSeen,
          title: "Comp Role",
          comp_low: 100_000,
          comp_high: 150_000,
        },
        { key: bare, company, last_seen: lastSeen, title: "Bare Role" },
      ]);

      const [rowBody] = await store.select<Posting>("postings", { key: withBody });
      const [rowComp] = await store.select<Posting>("postings", { key: withComp });
      const [rowBare] = await store.select<Posting>("postings", { key: bare });
      assert.equal(rowBody?.title, "Body Role");
      assert.equal(rowBody?.body, "a long body");
      assert.equal(rowComp?.comp_low, 100_000);
      assert.equal(rowComp?.comp_high, 150_000);
      assert.equal(rowBare?.title, "Bare Role");
      assert.equal(rowBare?.comp_low, null);

      // A second upsert of a different shape again, omitting a column the
      // first call wrote: that column keeps its stored value.
      await store.upsert("postings", [
        { key: withBody, company, last_seen: lastSeen, title: "Body Role, revised" },
      ]);

      const [revised] = await store.select<Posting>("postings", { key: withBody });
      assert.equal(revised?.title, "Body Role, revised");
      assert.equal(revised?.body, "a long body", "the omitted column must keep its stored value");
    },
  },
  {
    // Written out of order so an adapter returning insertion order would
    // fail. `source` carries the prefix because a filter on the key itself
    // would return one row.
    name: "select returns rows in ascending primary-key order",
    run: async (store, prefix) => {
      await store.upsert("companies", [
        company(`${prefix}-c`, { source: prefix }),
        company(`${prefix}-a`, { source: prefix }),
        company(`${prefix}-b`, { source: prefix }),
      ]);

      const read = await store.select<Company>("companies", { source: prefix });

      assert.deepEqual(
        read.map((row) => row.name),
        [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`],
      );
    },
  },
  {
    // `src/sync.ts` maps every row it reads by that key.
    name: "select returns the columns the caller named plus the primary key",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [posting(key, { title: "Engineer", body: "a long body" })]);

      const read = await store.select<Pick<Posting, "key" | "title">>("postings", { key }, [
        "title",
      ]);

      assert.equal(read.length, 1);
      assert.deepEqual(Object.keys(read[0] ?? {}).sort(), ["key", "title"]);
      assert.equal(read[0]?.title, "Engineer");
    },
  },
  {
    name: "update patches only the named columns, leaving the rest of the row untouched",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [posting(key, { title: "Old Title", status: null })]);

      const result = await store.update("postings", key, { status: "applied" });
      assert.deepEqual(result, { ok: true });

      const read = await store.select<Posting>("postings", { key });
      assert.equal(read[0]?.status, "applied");
      assert.equal(read[0]?.title, "Old Title", "update must not touch a column it was not given");
    },
  },
  {
    name: "update refuses when no row matches the key, and changes nothing",
    run: async (store, prefix) => {
      const key = `${prefix}::missing`;
      const result = await store.update("postings", key, { status: "applied" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /no row/);

      const read = await store.select<Posting>("postings", { key });
      assert.equal(read.length, 0);
    },
  },
  {
    // The engine never writes `first_seen`: the column DEFAULT sets it on
    // insert, so an adapter whose upsert assigned every column would make
    // each re-listed posting look new.
    name: "upsert leaves first_seen alone when the payload omits it",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [posting(key, { first_seen: "2026-09-15T00:00:00Z" })]);

      await store.upsert("postings", [
        { key, company: key.split("::")[0], last_seen: "2026-09-16T00:00:00Z" },
      ]);

      const read = await store.select<Posting>("postings", { key });
      assert.equal(
        new Date(read[0]?.first_seen ?? "").toISOString(),
        "2026-09-15T00:00:00.000Z",
        "a re-list must not move first_seen",
      );
    },
  },
  {
    // `pg` parses a timestamptz into a JS `Date`; `judge` slices the day
    // straight out of the string.
    name: "a timestamp column reads back as a string naming the instant written",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [posting(key, { last_seen: "2026-09-16T13:45:00Z" })]);

      const read = await store.select<Posting>("postings", { key });
      assert.equal(typeof read[0]?.last_seen, "string");
      assert.equal(new Date(read[0]?.last_seen ?? "").toISOString(), "2026-09-16T13:45:00.000Z");
    },
  },
  {
    // A `date` parsed into a `Date` is midnight local, so the day it renders
    // back as is not always the day Postgres stored.
    name: "a date column reads back as the day written, whatever the machine's timezone",
    run: async (store, prefix) => {
      const key = `${prefix}::123`;
      await store.upsert("postings", [posting(key, { posted_at: "2025-12-22" })]);

      const read = await store.select<Posting>("postings", { key });
      assert.equal(read[0]?.posted_at, "2025-12-22");
    },
  },
  {
    name: "delete removes the rows named by key and leaves every other row standing",
    run: async (store, prefix) => {
      const kept = `${prefix}-keep`;
      const gone = `${prefix}-gone`;
      await store.upsert("companies", [
        company(kept, { source: prefix }),
        company(gone, { source: prefix }),
      ]);

      await store.delete("companies", [gone]);

      const read = await store.select<Company>("companies", { source: prefix });
      assert.deepEqual(
        read.map((row) => row.name),
        [kept],
      );
    },
  },
  {
    // Unlike `update`, a key with no row is not a refusal.
    name: "delete of a key no row holds removes nothing and does not refuse",
    run: async (store, prefix) => {
      const name = `${prefix}-acme`;
      await store.upsert("companies", [company(name, { source: prefix })]);

      await store.delete("companies", [`${prefix}-never`]);

      const read = await store.select<Company>("companies", { source: prefix });
      assert.deepEqual(
        read.map((row) => row.name),
        [name],
      );
    },
  },
];

const CONTRACT_TABLES = [
  ["postings", "key"],
  ["companies", "name"],
] as const;

// No URL, every Postgres case skipped with its reason printed, so a green
// run never reads as "the database agreed". Cleanup goes around the adapter
// under test (a raw `pg` query) so a broken `delete` cannot tidy up after
// itself.
const LOCAL_URL = process.env["JOB_SEARCH_DB_URL"] ?? "";
const localSkip = LOCAL_URL === "" ? "JOB_SEARCH_DB_URL unset" : null;

let local: Store | null = null;
function openLocal(): Store {
  local ??= postgresStore({ url: LOCAL_URL });
  return local;
}

async function deleteLocalRows(prefix: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: LOCAL_URL });
  try {
    for (const [table, column] of CONTRACT_TABLES) {
      await pool.query(`DELETE FROM "${table}" WHERE "${column}" LIKE $1`, [`${prefix}%`]);
    }
  } finally {
    await pool.end();
  }
}

interface Adapter {
  readonly name: string;
  readonly skip: string | null;
  readonly open: () => Store;
  readonly clean: (prefix: string) => Promise<void>;
}

const memory = memoryStore();

const ADAPTERS: readonly Adapter[] = [
  { name: "memory", skip: null, open: () => memory, clean: async () => {} },
  { name: "postgres", skip: localSkip, open: openLocal, clean: deleteLocalRows },
];

for (const [index, contractCase] of CASES.entries()) {
  for (const adapter of ADAPTERS) {
    test(
      `${adapter.name}: ${contractCase.name}`,
      adapter.skip === null ? {} : { skip: adapter.skip },
      async () => {
        const prefix = `${adapter.name}${index}x${Date.now().toString(36)}`;
        try {
          await contractCase.run(adapter.open(), prefix);
        } finally {
          await adapter.clean(prefix);
        }
      },
    );
  }
}

// The adapter's own statements against an injected query, no database:
// the contract cases prove Postgres agrees, these pin the SQL that makes
// it agree, above all the `ON CONFLICT DO UPDATE SET` list that leaves
// `first_seen` alone.

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

function recordingQuery(
  rows: readonly Record<string, unknown>[] = [],
  rowCount: number | null = null,
): { statements: Statement[]; store: Store } {
  const statements: Statement[] = [];
  const store = postgresStore({
    url: "postgres://never-dialled",
    queryImpl: async (text, values) => {
      statements.push({ text, values });
      return { rows, rowCount: rowCount ?? rows.length };
    },
  });
  return { statements, store };
}

test("postgres upsert assigns only the columns the payload carries, so first_seen is never written", async () => {
  const { statements, store } = recordingQuery();

  await store.upsert("postings", [
    { key: "Acme::1", company: "Acme", title: "Engineer", last_seen: "2026-09-16T00:00:00Z" },
  ]);

  assert.equal(statements.length, 1, "one payload shape is one statement");
  assert.equal(
    statements[0]?.text,
    'INSERT INTO "postings" ("key", "company", "title", "last_seen") ' +
      "VALUES ($1, $2, $3, $4) " +
      'ON CONFLICT ("key") DO UPDATE SET "company" = EXCLUDED."company", ' +
      '"title" = EXCLUDED."title", "last_seen" = EXCLUDED."last_seen"',
  );
  assert.deepEqual(statements[0]?.values, ["Acme::1", "Acme", "Engineer", "2026-09-16T00:00:00Z"]);
});

test("postgres upsert of nothing but the primary key asks for the row to exist and no more", async () => {
  const { statements, store } = recordingQuery();

  await store.upsert("companies", [{ name: "Acme" }]);

  assert.equal(
    statements[0]?.text,
    'INSERT INTO "companies" ("name") VALUES ($1) ON CONFLICT ("name") DO NOTHING',
  );
});

test("postgres upsert writes a jsonb column as JSON text, not as a Postgres array literal", async () => {
  const { statements, store } = recordingQuery();

  await store.upsert("postings", [
    { key: "Acme::1", reasons: [{ criterion: "level", verdict: "in" }] },
  ]);

  assert.deepEqual(statements[0]?.values, [
    "Acme::1",
    '[{"criterion":"level","verdict":"in"}]',
    // `pg` would render the array as {…} and jsonb would refuse it.
  ]);
});

test("postgres upsert splits a batch that would bind more than 65,535 parameters", async () => {
  const { statements, store } = recordingQuery();
  // Three columns, so 21,845 rows is exactly the protocol's limit.
  const rows = Array.from({ length: 21_846 }, (_, index) => ({
    key: `Acme::${index}`,
    company: "Acme",
    last_seen: "2026-09-16T00:00:00Z",
  }));

  await store.upsert("postings", rows);

  assert.equal(statements.length, 2);
  assert.equal(statements[0]?.values.length, 65_535);
  assert.equal(statements[1]?.values.length, 3);
});

test("postgres upsert sends one statement per column set, so a mixed batch writes each row's own columns", async () => {
  const { statements, store } = recordingQuery();

  await store.upsert("postings", [
    { key: "Acme::1", title: "A" },
    { key: "Acme::2", body: "b" },
    { key: "Acme::3", title: "C" },
  ]);

  assert.equal(statements.length, 2);
  assert.match(statements[0]?.text ?? "", /\("key", "title"\)/);
  assert.deepEqual(statements[0]?.values, ["Acme::1", "A", "Acme::3", "C"]);
  assert.match(statements[1]?.text ?? "", /\("key", "body"\)/);
  assert.deepEqual(statements[1]?.values, ["Acme::2", "b"]);
});

test("postgres select orders by the primary key, spells a null filter IS NULL, and reads unpaged", async () => {
  const { statements, store } = recordingQuery();

  await store.select("postings", { company: "Acme", live: null }, ["title"]);

  assert.equal(
    statements[0]?.text,
    'SELECT "title", "key" FROM "postings" WHERE "company" = $1 AND "live" IS NULL ' +
      'ORDER BY "key" ASC',
  );
  assert.deepEqual(statements[0]?.values, ["Acme"]);
});

test("postgres select reads every column when the caller names none", async () => {
  const { statements, store } = recordingQuery();

  await store.select("companies");

  assert.equal(statements[0]?.text, 'SELECT * FROM "companies" ORDER BY "name" ASC');
});

test("postgres update patches the named columns and refuses when no row matched", async () => {
  const { statements, store } = recordingQuery([], 0);

  const result = await store.update("companies", "Acme", { state: "alias" });

  assert.equal(statements[0]?.text, 'UPDATE "companies" SET "state" = $1 WHERE "name" = $2');
  assert.deepEqual(statements[0]?.values, ["alias", "Acme"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no row/);
});

test("postgres update reports ok when a row matched", async () => {
  const { store } = recordingQuery([], 1);

  assert.deepEqual(await store.update("companies", "Acme", { state: "alias" }), { ok: true });
});

test("postgres delete removes every key in one statement", async () => {
  const { statements, store } = recordingQuery();

  await store.delete("postings", ["Acme::1", "Acme::2"]);

  assert.equal(statements.length, 1, "no chunking: there is no URL to outgrow");
  assert.equal(statements[0]?.text, 'DELETE FROM "postings" WHERE "key"::text = ANY($1::text[])');
  assert.deepEqual(statements[0]?.values, [["Acme::1", "Acme::2"]]);
});

test("postgres delete of no keys sends no statement", async () => {
  const { statements, store } = recordingQuery();

  await store.delete("postings", []);

  assert.equal(statements.length, 0);
});

test("postgres update refuses to build a SET with no columns, which is a caller's bug", async () => {
  const { store } = recordingQuery();

  await assert.rejects(store.update("companies", "Acme", {}), /no columns/);
});

test("openStore throws naming JOB_SEARCH_DB_URL when it is unset", () => {
  assert.throws(() => openStore({}), /JOB_SEARCH_DB_URL/);
});

test("openStore treats an empty JOB_SEARCH_DB_URL as unset, matching GitHub Actions' unset secrets", () => {
  assert.throws(() => openStore({ JOB_SEARCH_DB_URL: "" }), /JOB_SEARCH_DB_URL/);
});

test("openStore builds the local adapter from JOB_SEARCH_DB_URL rather than throwing", async () => {
  // Port 1 is nobody. A store that never dials the URL would not reject.
  const store = openStore({ JOB_SEARCH_DB_URL: "postgres://postgres@127.0.0.1:1/nowhere" });
  await assert.rejects(store.select("companies"));
});

test("storeStats counts the adapter's statements, so a phase line can report them", async () => {
  const { store } = recordingQuery();
  const before = storeStats();

  await store.select("companies");

  const after = storeStats();
  assert.equal(after.requests - before.requests, 1);
  assert.ok(after.ms >= before.ms);
});
