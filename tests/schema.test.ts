import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";
import { test } from "node:test";
import pg from "pg";
import {
  CANDIDATE_FIELDS,
  COMPANY_FIELDS,
  CRITERIA_FIELDS,
  OUTCOMES,
  PLATFORMS,
  POSTING_FIELDS,
  postingKey,
  STATUSES,
  TABLES,
} from "../src/schema.ts";
import { PRIMARY_KEYS } from "../src/store/store.ts";

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_PATH = `${MIGRATIONS_DIR}/20260915000000_three_stores.sql`;

// Each column lives on its own line as `"name" ...` inside the CREATE
// TABLE block, the convention every migration here follows. The block is
// looked up across every migration rather than in one fixed file, because
// a table is declared wherever it is declared: `candidates` has a
// migration of its own. The last migration to CREATE a name wins, since
// `criteria` is created by the init, again by its own migration, and again
// by three_stores, which drops the earlier one first.
function columnLinesOf(table: string): string[] {
  const marker = `CREATE TABLE IF NOT EXISTS "${table}" (`;
  const declaring = readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((file) => `${MIGRATIONS_DIR}/${file}`)
    .filter((path) => readFileSync(path, "utf8").includes(marker))
    .at(-1);
  assert.ok(declaring !== undefined, `no CREATE TABLE for "${table}" in ${MIGRATIONS_DIR}`);
  const sql = readFileSync(declaring, "utf8");
  const bodyStart = sql.indexOf(marker) + marker.length;
  const end = sql.indexOf("\n);", bodyStart);
  assert.ok(end !== -1, `no closing ");" for "${table}" in ${declaring}`);
  return sql
    .slice(bodyStart, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'));
}

function nameOf(columnLine: string): string {
  return columnLine.slice(1, columnLine.indexOf('"', 1));
}

// Every statement across every migration, in the order the CLI applies
// them, comments stripped first so prose naming a table cannot attach to
// the statement after it and a `;` inside a comment cannot split one.
function statementsOf(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((file) => readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"))
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";");
}

// The table's columns after every statement has applied, in the order the
// CLI applies them: a CREATE TABLE sets the list to its own column lines
// (so the last CREATE wins, as `columnLinesOf` finds it); `ALTER TABLE
// "<table>" ADD COLUMN [IF NOT EXISTS] "<name>"` appends; `ALTER TABLE
// "<table>" DROP COLUMN [IF EXISTS] "<name>"` removes. One pass, so a
// column added and later dropped nets out.
function columnsOf(table: string): string[] {
  const created = `CREATE TABLE IF NOT EXISTS "${table}" (`;
  const added = new RegExp(`ALTER TABLE "${table}" ADD COLUMN( IF NOT EXISTS)? "([^"]+)"`);
  const dropped = new RegExp(`ALTER TABLE "${table}" DROP COLUMN( IF EXISTS)? "([^"]+)"`);
  let columns: string[] = [];
  for (const statement of statementsOf()) {
    const createdAt = statement.indexOf(created);
    if (createdAt !== -1) {
      columns = statement
        .slice(createdAt + created.length)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith('"'))
        .map(nameOf);
      continue;
    }
    const addedName = statement.match(added)?.[2];
    if (addedName !== undefined) columns.push(addedName);
    const droppedName = statement.match(dropped)?.[2];
    if (droppedName !== undefined) columns = columns.filter((name) => name !== droppedName);
  }
  return columns;
}

function primaryKeyOf(table: string): string {
  const lines = columnLinesOf(table).filter((line) => line.includes("PRIMARY KEY"));
  assert.equal(lines.length, 1, `expected one PRIMARY KEY column on "${table}"`);
  return nameOf(lines[0]);
}

// The last statement that CHECKs the column wins: a CHECK cannot be edited
// in place, so a vocabulary change is a later migration re-declaring it.
function vocabularyOf(table: string, column: string): string[] {
  const statements = statementsOf();
  const names = new RegExp(`(CREATE TABLE( IF NOT EXISTS)?|ALTER TABLE) "${table}"`);
  const check = new RegExp(`CHECK \\("${column}" IN \\(([^)]*)\\)\\)`);
  const lists = statements
    .filter((statement) => names.test(statement))
    .map((statement) => statement.match(check)?.[1])
    .filter((list) => list !== undefined);
  const last = lists.at(-1);
  assert.ok(last !== undefined, `no CHECK on "${table}"."${column}" in ${MIGRATIONS_DIR}`);
  return last.split(",").map((term) => term.trim().slice(1, -1));
}

test("the migration's postings columns match POSTING_FIELDS, in order", () => {
  assert.deepEqual(columnsOf("postings"), [...POSTING_FIELDS]);
});

test("the migration's companies columns match COMPANY_FIELDS, in order", () => {
  assert.deepEqual(columnsOf("companies"), [...COMPANY_FIELDS]);
});

test("the migration's criteria columns match CRITERIA_FIELDS, in order", () => {
  assert.deepEqual(columnsOf("criteria"), [...CRITERIA_FIELDS]);
});

test("the migration's candidates columns match CANDIDATE_FIELDS, in order", () => {
  assert.deepEqual(columnsOf("candidates"), [...CANDIDATE_FIELDS]);
});

test("the migrations' ADD COLUMN statements append to POSTING_FIELDS in order", () => {
  assert.deepEqual(columnsOf("postings").slice(-3), ["body_hash", "workplace", "gone_at"]);
});

test("the gone_at migration's DROP COLUMN statements remove postings.last_seen and live", () => {
  // Pinned by hand: both were CREATE TABLE columns of three_stores, so a
  // columnsOf that ignored DROP COLUMN would still list them.
  const postings = columnsOf("postings");
  assert.equal(postings.includes("last_seen"), false);
  assert.equal(postings.includes("live"), false);
  assert.equal(columnsOf("companies").includes("last_seen"), false);
});

test("the migrations' ADD COLUMN statements append to CRITERIA_FIELDS in order", () => {
  assert.equal(columnsOf("criteria").at(-1), "full_read_at");
});

test("the migrations' postings.platform CHECK matches PLATFORMS, in order", () => {
  assert.deepEqual(vocabularyOf("postings", "platform"), [...PLATFORMS]);
});

test("the migrations' postings.status CHECK matches STATUSES, in order", () => {
  assert.deepEqual(vocabularyOf("postings", "status"), [...STATUSES]);
});

test("the migrations' candidates.outcome CHECK matches OUTCOMES, in order", () => {
  assert.deepEqual(vocabularyOf("candidates", "outcome"), [...OUTCOMES]);
});

test("the companies_derived migration leaves companies with name, boards and the drop", () => {
  // Pinned by hand, not through COMPANY_FIELDS: state, source, first_seen
  // and alias_of were three_stores and company_drop columns, so a
  // columnsOf that ignored their DROP COLUMN would still list them.
  assert.deepEqual(columnsOf("companies"), [
    "name",
    "boards",
    "reason",
    "dropped_at",
    "peers_searched_at",
  ]);
});

test("the migration drops the old criteria table before recreating it", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  const dropIndex = sql.indexOf('DROP TABLE IF EXISTS "criteria"');
  const createIndex = sql.indexOf('CREATE TABLE IF NOT EXISTS "criteria"');
  assert.ok(dropIndex !== -1, "expected a DROP TABLE for the old criteria table");
  assert.ok(dropIndex < createIndex, "expected the DROP before the new CREATE TABLE");
});

test("postingKey spells a key as platform/board::id, with no company name in it", () => {
  // Wellspring and Wellspring Health both reach greenhouse/wellspring.
  assert.equal(
    postingKey({ platform: "greenhouse", id: "wellspring" }, "4123456"),
    "greenhouse/wellspring::4123456",
  );
});

test("postingKey: the same listing id on two boards keys two postings", () => {
  // An ATS listing id alone is not an identity.
  assert.notEqual(
    postingKey({ platform: "greenhouse", id: "acme" }, "77"),
    postingKey({ platform: "greenhouse", id: "globex" }, "77"),
  );
  assert.notEqual(
    postingKey({ platform: "greenhouse", id: "acme" }, "77"),
    postingKey({ platform: "lever", id: "acme" }, "77"),
  );
});

test("PRIMARY_KEYS names the column the migration declares PRIMARY KEY, per table", () => {
  for (const table of TABLES) {
    assert.equal(primaryKeyOf(table), PRIMARY_KEYS[table], table);
  }
});

// The list's INSERT on `candidates` (20260928050000_candidates_list),
// against the test database with that migration applied: the column
// privilege and the policy are Postgres's to enforce, so only Postgres can
// say they hold. One transaction as `authenticated`, every attempt behind
// a savepoint, all of it rolled back, so no row is left behind. Skipped
// with its reason when the URL is unset; never `JOB_SEARCH_DB_URL`.
const TEST_DB_URL = process.env["JOB_SEARCH_TEST_DB_URL"] ?? "";
const testDbSkip = TEST_DB_URL === "" ? "JOB_SEARCH_TEST_DB_URL unset" : null;

type Attempt =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

async function asTheList(statements: readonly string[]): Promise<readonly Attempt[]> {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    const attempts: Attempt[] = [];
    for (const statement of statements) {
      await client.query("SAVEPOINT attempt");
      try {
        const result = await client.query(statement);
        attempts.push({ ok: true, rows: result.rows });
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        attempts.push({ ok: false, code: failure.code ?? "", message: failure.message ?? "" });
      }
      await client.query("ROLLBACK TO SAVEPOINT attempt");
    }
    await client.query("ROLLBACK");
    return attempts;
  } finally {
    await client.end();
  }
}

test(
  "the list may insert a candidate with only name and origin james; the defaults fill id and added_at",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks without the GRANT INSERT, the authenticated_add policy, or
    // either column default (id and added_at are NOT NULL).
    const [added] = await asTheList([
      `INSERT INTO "candidates" ("name", "origin") VALUES ('Example Co', 'james') ` +
        `RETURNING "id", "added_at", "outcome"`,
    ]);
    assert.ok(added?.ok, `insert refused: ${added?.ok === false ? added.message : ""}`);
    const row = added.rows[0];
    assert.match(
      String(row?.["id"]),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.ok(row?.["added_at"] instanceof Date);
    assert.equal(row?.["outcome"], null);
  },
);

test(
  "the list may insert a URL-only candidate from peers",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if the policy's origin list drops 'peers' or the grant drops url.
    const [added] = await asTheList([
      `INSERT INTO "candidates" ("url", "origin", "evidence") ` +
        `VALUES ('https://example.com/jobs/1', 'peers', 'a colleague named it')`,
    ]);
    assert.equal(added?.ok, true);
  },
);

test(
  "the list may not insert a candidate whose origin is a discovery source",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if the policy's WITH CHECK stops pinning origin.
    const [refused] = await asTheList([
      `INSERT INTO "candidates" ("name", "origin") VALUES ('Example Co', 'builtin.com')`,
    ]);
    assert.equal(refused?.ok, false);
    assert.equal(refused?.ok === false && refused.code, "42501");
    assert.match(refused?.ok === false ? refused.message : "", /row-level security/);
  },
);

test(
  "the list may not write a candidate's outcome, company or id",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if the column grant widens past name, url, origin, evidence.
    const attempts = await asTheList([
      `INSERT INTO "candidates" ("name", "origin", "outcome") VALUES ('Example Co', 'james', 'watched')`,
      `INSERT INTO "candidates" ("name", "origin", "company") VALUES ('Example Co', 'james', 'Example Co')`,
      `INSERT INTO "candidates" ("id", "name", "origin") VALUES ('chosen-id', 'Example Co', 'james')`,
    ]);
    assert.deepEqual(
      attempts.map((attempt) => (attempt.ok ? "added" : attempt.code)),
      ["42501", "42501", "42501"],
    );
  },
);

test(
  "the list may neither update nor delete a candidate",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if a later migration grants UPDATE or DELETE on candidates to
    // authenticated: a candidate's input is fixed once added and its outcome
    // is discover's, so the list must not rewrite or remove either. Refused
    // on privilege (42501) before any row is read, so an empty table still
    // proves it.
    const attempts = await asTheList([
      `UPDATE "candidates" SET "name" = 'Renamed Co' WHERE true`,
      `UPDATE "candidates" SET "outcome" = 'watched' WHERE true`,
      `DELETE FROM "candidates" WHERE true`,
    ]);
    assert.deepEqual(
      attempts.map((attempt) => (attempt.ok ? "allowed" : attempt.code)),
      ["42501", "42501", "42501"],
    );
  },
);

test(
  "the list may update a company's peers_searched_at but not its boards",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if the peers_searched_at migration's GRANT is dropped, or if a
    // later grant widens authenticated's UPDATE to `boards`, which only the
    // run writes. Checked on privilege, before any row is read, so an empty
    // table proves both.
    const attempts = await asTheList([
      `UPDATE "companies" SET "peers_searched_at" = now() WHERE true`,
      `UPDATE "companies" SET "boards" = '[]'::jsonb WHERE true`,
    ]);
    assert.deepEqual(
      attempts.map((attempt) => (attempt.ok ? "allowed" : attempt.code)),
      ["allowed", "42501"],
    );
  },
);

test(
  "the list may read criteria.full_read_at and update comp_floor, but not update full_read_at",
  testDbSkip === null ? {} : { skip: testDbSkip },
  async () => {
    // Breaks if the criteria_full_read_at migration is missing (the SELECT
    // names a column that does not exist) or if a later grant adds
    // full_read_at to authenticated's criteria UPDATE list: only the run
    // writes it. comp_floor is the control, an operator column the list
    // does write. Checked on privilege, before any row is read.
    const attempts = await asTheList([
      `SELECT "full_read_at" FROM "criteria"`,
      `UPDATE "criteria" SET "comp_floor" = 1 WHERE true`,
      `UPDATE "criteria" SET "full_read_at" = now() WHERE true`,
    ]);
    assert.deepEqual(
      attempts.map((attempt) => (attempt.ok ? "allowed" : attempt.code)),
      ["allowed", "allowed", "42501"],
    );
  },
);
