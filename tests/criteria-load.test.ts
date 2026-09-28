import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadCriteriaFile, parseCriteriaInput } from "../scripts/criteria-load.ts";
import type { Criteria } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";
import { postgresStore } from "../src/store/postgres.ts";

const VALID_INPUT = {
  level_words: ["senior", "staff"],
  role_words: ["backend"],
  excluded_title_words: ["intern"],
  team_name_words: [],
  excluded_states: [],
  missing_languages: [],
  comp_floor: 0,
  max_age_days: null,
  excluded_locations: [],
  product_words: [],
  assumed_bonus_pct: null,
};

test("parseCriteriaInput: accepts a fully populated object", () => {
  const result = parseCriteriaInput(VALID_INPUT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : undefined, VALID_INPUT);
});

test("parseCriteriaInput: rejects a missing required key, naming it", () => {
  const { role_words: _role_words, ...withoutRoleWords } = VALID_INPUT;
  const result = parseCriteriaInput(withoutRoleWords);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /role_words/);
});

test("parseCriteriaInput: rejects an unknown key, naming it", () => {
  const result = parseCriteriaInput({ ...VALID_INPUT, mystery_field: true });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /mystery_field/);
});

test("parseCriteriaInput: rejects a wrongly typed field, naming it", () => {
  const result = parseCriteriaInput({ ...VALID_INPUT, comp_floor: "120000" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /comp_floor/);
});

test("loadCriteriaFile: rejects text that is not valid JSON", async () => {
  const store = memoryStore();
  const result = await loadCriteriaFile(store, "{ not json");
  assert.equal(result.ok, false);
});

test("loadCriteriaFile: loads criteria.example.json and reads the row back through the memory store", async () => {
  const store = memoryStore();
  const text = await readFile(new URL("../criteria.example.json", import.meta.url), "utf8");

  const result = await loadCriteriaFile(store, text);
  assert.equal(result.ok, true);

  const [row] = await store.select<Criteria>("criteria", { id: 1 });
  assert.ok(row);
  assert.equal(row.id, 1);
  assert.deepEqual(row.level_words, ["senior", "staff"]);
  assert.deepEqual(row.role_words, ["backend"]);
  assert.equal(row.comp_floor, 0);
  assert.equal(row.max_age_days, null);
  assert.equal(row.assumed_bonus_pct, null);
  assert.equal(typeof row.updated_at, "string");
});

// Breaks if `loadCriteriaFile` puts `full_read_at` in the row it upserts
// (or the memory store's upsert stops merging onto the stored row): a
// reload would then wipe the daily run's marker.
test("loadCriteriaFile: leaves the stored full_read_at alone and moves updated_at past it", async () => {
  const store = memoryStore();
  const stored: Criteria = {
    id: 1,
    updated_at: "2026-09-01T00:00:00.000Z",
    full_read_at: "2026-09-02T00:00:00.000Z",
    ...VALID_INPUT,
  };
  await store.upsert("criteria", [stored]);

  const result = await loadCriteriaFile(store, JSON.stringify(VALID_INPUT));
  assert.equal(result.ok, true);

  const [row] = await store.select<Criteria>("criteria", { id: 1 });
  assert.equal(row?.full_read_at, "2026-09-02T00:00:00.000Z");
  assert.ok(
    (row?.updated_at ?? "") > "2026-09-02T00:00:00.000Z",
    "the load reads as an edit newer than the last full read",
  );
});

// The same claim against the Postgres adapter's statement: its `ON
// CONFLICT DO UPDATE SET` assigns only the columns the row carries, so
// breaks if `loadCriteriaFile` starts sending `full_read_at`.
test("loadCriteriaFile: the Postgres upsert neither inserts nor assigns full_read_at", async () => {
  const statements: string[] = [];
  const store = postgresStore({
    url: "postgres://never-dialled",
    queryImpl: async (text) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
  });

  const result = await loadCriteriaFile(store, JSON.stringify(VALID_INPUT));
  assert.equal(result.ok, true);

  assert.equal(statements.length, 1);
  assert.match(statements[0] ?? "", /^INSERT INTO "criteria" /);
  assert.doesNotMatch(statements[0] ?? "", /full_read_at/);
});
