import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadCriteriaFile, parseCriteriaInput } from "../scripts/criteria-load.ts";
import type { Criteria } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

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
