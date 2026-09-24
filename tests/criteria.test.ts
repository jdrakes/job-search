import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCriteria } from "../src/criteria.ts";
import type { Criteria } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

// A stand-in for a live criteria row; the point of this test is that
// loadCriteria round-trips whatever row is seeded, so the specific values
// below carry no meaning beyond being generic and illustrative.
const SEEDED_CRITERIA: Criteria = {
  id: 1,
  level_words: ["staff", "senior"],
  role_words: ["backend", "platform"],
  excluded_title_words: ["recruiter", "sales"],
  team_name_words: ["marketing"],
  excluded_states: ["Ohio"],
  missing_languages: ["cobol", "fortran"],
  comp_floor: 120000,
  max_age_days: null,
  excluded_locations: [],
  product_words: [],
  assumed_bonus_pct: null,
  updated_at: "2026-09-14T00:00:00Z",
};

test("loadCriteria: refuses when the criteria table is empty", async () => {
  const store = memoryStore();

  const result = await loadCriteria(store);

  assert.equal(result.ok, false);
});

test("loadCriteria: returns every field from the seeded row", async () => {
  const store = memoryStore({ criteria: [SEEDED_CRITERIA] });

  const result = await loadCriteria(store);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : undefined, SEEDED_CRITERIA);
});
