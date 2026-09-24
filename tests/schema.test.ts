import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COMPANY_FIELDS,
  COMPANY_STATES,
  CRITERIA_FIELDS,
  PLATFORMS,
  POSTING_FIELDS,
  postingKey,
  REPROBE_RUN_FIELDS,
  STATUSES,
  TABLES,
} from "../src/schema.ts";
import { PRIMARY_KEYS } from "../src/store/store.ts";

const MIGRATIONS_DIR = "supabase/migrations";
const MIGRATION_PATH = `${MIGRATIONS_DIR}/20260915000000_three_stores.sql`;

// Each column lives on its own line as `"name" ...` inside the CREATE
// TABLE block, the convention every migration here follows. The block is
// looked up across every migration rather than in one fixed file, because
// a table is declared wherever it is declared: `reprobe_runs` has a
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

// The CREATE TABLE columns, then every column a later migration adds with
// `ALTER TABLE "<table>" ADD COLUMN [IF NOT EXISTS] "<name>"`, in
// migration filename order.
function columnsOf(table: string): string[] {
  const created = columnLinesOf(table).map(nameOf);
  const added = new RegExp(`ALTER TABLE "${table}" ADD COLUMN( IF NOT EXISTS)? "([^"]+)"`);
  const appended = statementsOf()
    .map((statement) => statement.match(added)?.[2])
    .filter((name): name is string => name !== undefined);
  return [...created, ...appended];
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

test("the migration's reprobe_runs columns match REPROBE_RUN_FIELDS, in order", () => {
  assert.deepEqual(columnsOf("reprobe_runs"), [...REPROBE_RUN_FIELDS]);
});

test("the migrations' ADD COLUMN statements append to POSTING_FIELDS in order", () => {
  assert.equal(columnsOf("postings").at(-1), "workplace");
});

test("the migrations' ADD COLUMN statements append to CRITERIA_FIELDS in order", () => {
  assert.equal(columnsOf("criteria").at(-1), "assumed_bonus_pct");
});

test("the migrations' postings.platform CHECK matches PLATFORMS, in order", () => {
  assert.deepEqual(vocabularyOf("postings", "platform"), [...PLATFORMS]);
});

test("the migrations' postings.status CHECK matches STATUSES, in order", () => {
  assert.deepEqual(vocabularyOf("postings", "status"), [...STATUSES]);
});

test("the migrations' companies.state CHECK matches COMPANY_STATES, in order", () => {
  assert.deepEqual(vocabularyOf("companies", "state"), [...COMPANY_STATES]);
});

test("the last companies.state CHECK names discovered, watched, alias: a drop is no longer a state", () => {
  // Pinned by hand, not through COMPANY_STATES: the company_drop migration
  // moved the drop to `dropped_at`, so a later migration that re-admits
  // 'dropped' (or drops 'alias') fails here even if schema.ts follows it.
  assert.deepEqual(vocabularyOf("companies", "state"), ["discovered", "watched", "alias"]);
});

test("the migrations' ADD COLUMN statements append to COMPANY_FIELDS in order", () => {
  assert.deepEqual(columnsOf("companies").slice(-2), ["dropped_at", "alias_of"]);
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
