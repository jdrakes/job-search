// Writes the one criteria row (id 1) from a JSON file: the documented way
// to configure judging without the browser UI, and how an operator restores
// their own criteria after moving instances. `id` and `updated_at` are not
// accepted from the file; this script owns both.
import { readFile } from "node:fs/promises";
import process from "node:process";

import { describeError } from "../src/errors.ts";
import { CRITERIA_FIELDS, type Criteria } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

export type CriteriaInput = Omit<Criteria, "id" | "updated_at">;

// Every Criteria column an operator supplies, in one place, so this list
// and the schema cannot drift apart.
const REQUIRED_KEYS = CRITERIA_FIELDS.filter((field) => field !== "id" && field !== "updated_at");

const STRING_ARRAY_FIELDS = [
  "level_words",
  "role_words",
  "excluded_title_words",
  "team_name_words",
  "excluded_states",
  "missing_languages",
  "excluded_locations",
  "product_words",
] as const satisfies readonly (keyof CriteriaInput)[];

const NULLABLE_NUMBER_FIELDS = [
  "max_age_days",
  "assumed_bonus_pct",
] as const satisfies readonly (keyof CriteriaInput)[];

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Parsed once, at this boundary, into the `Criteria` shape from
// `src/schema.ts`. A missing required key or an unknown one is refused by
// name rather than silently written as a half-populated row.
export function parseCriteriaInput(
  value: unknown,
): { ok: true; value: CriteriaInput } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "criteria file must contain a JSON object" };
  }
  const record = value as Record<string, unknown>;

  const missing = REQUIRED_KEYS.filter((key) => !(key in record));
  if (missing.length > 0) {
    return { ok: false, reason: `missing required key(s): ${missing.join(", ")}` };
  }
  const known: ReadonlySet<string> = new Set(REQUIRED_KEYS);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown key(s): ${unknown.join(", ")}` };
  }

  for (const field of STRING_ARRAY_FIELDS) {
    if (!isStringArray(record[field])) {
      return { ok: false, reason: `field "${field}" must be an array of strings` };
    }
  }
  if (typeof record.comp_floor !== "number") {
    return { ok: false, reason: 'field "comp_floor" must be a number' };
  }
  for (const field of NULLABLE_NUMBER_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue !== null && typeof fieldValue !== "number") {
      return { ok: false, reason: `field "${field}" must be a number or null` };
    }
  }

  return {
    ok: true,
    value: {
      level_words: record.level_words as readonly string[],
      role_words: record.role_words as readonly string[],
      excluded_title_words: record.excluded_title_words as readonly string[],
      team_name_words: record.team_name_words as readonly string[],
      excluded_states: record.excluded_states as readonly string[],
      missing_languages: record.missing_languages as readonly string[],
      comp_floor: record.comp_floor as number,
      max_age_days: record.max_age_days as number | null,
      excluded_locations: record.excluded_locations as readonly string[],
      product_words: record.product_words as readonly string[],
      assumed_bonus_pct: record.assumed_bonus_pct as number | null,
    },
  };
}

// Parses `text`, then upserts the id-1 row through `store`. Reads
// unparsable JSON as a rejection like any other malformed input, rather
// than throwing, since a typo in an operator's file is expected, not a bug.
export async function loadCriteriaFile(
  store: Store,
  text: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const result = parseCriteriaInput(parsed);
  if (!result.ok) return result;

  const row: Criteria = { id: 1, updated_at: new Date().toISOString(), ...result.value };
  await store.upsert("criteria", [row]);
  return { ok: true };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("criteria-load: usage: criteria-load.ts <file>");
    process.exitCode = 1;
    return;
  }
  const text = await readFile(path, "utf8");
  const store = openStore();
  const result = await loadCriteriaFile(store, text);
  if (!result.ok) {
    console.error(`criteria-load: ${path}: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`criteria-load: wrote criteria from ${path}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`criteria-load: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
