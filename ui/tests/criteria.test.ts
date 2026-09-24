import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { STATUSES, type Criteria } from "../../src/schema.ts";
import type { AppConfig } from "../src/config.ts";
import {
  CriteriaView,
  fieldsFrom,
  floorLabel,
  formatList,
  parseList,
  patchFrom,
  rowsFor,
} from "../src/criteria.ts";
import type { ToastState } from "../src/toast.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

const CRITERIA: Criteria = {
  id: 1,
  level_words: ["senior", "staff"],
  role_words: ["engineer"],
  excluded_title_words: ["intern"],
  team_name_words: [],
  excluded_states: [],
  missing_languages: [],
  comp_floor: 160_000,
  max_age_days: null,
  excluded_locations: [],
  product_words: [],
  assumed_bonus_pct: null,
  updated_at: "2026-09-01T00:00:00Z",
};

const CONFIG: AppConfig = {
  url: "https://project.supabase.co",
  anonKey: "anon-key",
  statuses: [...STATUSES],
};
const ACCESS_TOKEN = "user-jwt";

test("parseList splits on newlines, trims, and drops blank lines", () => {
  assert.deepEqual(parseList("senior\n  staff  \n\nlead\n"), ["senior", "staff", "lead"]);
});

test("parseList on empty text is an empty list", () => {
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList("   \n  "), []);
});

test("formatList joins items with newlines", () => {
  assert.equal(formatList(["senior", "staff"]), "senior\nstaff");
});

test("fieldsFrom turns every list into newline text and the floor into a string", () => {
  assert.deepEqual(fieldsFrom(CRITERIA), {
    levelWords: "senior\nstaff",
    roleWords: "engineer",
    excludedTitleWords: "intern",
    teamNameWords: "",
    excludedStates: "",
    missingLanguages: "",
    compFloor: "160000",
    excludedLocations: "",
    maxAgeDays: "",
    productWords: "",
    assumedBonusPct: "",
  });
});

test("fieldsFrom turns product_words into newline text like the other lists", () => {
  const withProductWords = { ...CRITERIA, product_words: ["product", "growth"] };
  assert.equal(fieldsFrom(withProductWords).productWords, "product\ngrowth");
  assert.equal(fieldsFrom(CRITERIA).productWords, "");
});

test("fieldsFrom spells a null max age as blank and a number as its digits", () => {
  const withMaxAge = { ...CRITERIA, max_age_days: 90 };
  const fields = fieldsFrom(withMaxAge);
  assert.equal(fields.maxAgeDays, "90");
  assert.equal(fieldsFrom(CRITERIA).maxAgeDays, "");
});

test("patchFrom parses every field back into the criteria patch's shape", () => {
  const outcome = patchFrom({
    levelWords: "senior\nstaff",
    roleWords: "engineer",
    excludedTitleWords: "intern",
    teamNameWords: "",
    excludedStates: "CA\nNY",
    missingLanguages: "",
    compFloor: "175000",
    excludedLocations: "",
    maxAgeDays: "",
    productWords: "product\ngrowth",
    assumedBonusPct: "",
  });

  assert.deepEqual(outcome, {
    patch: {
      level_words: ["senior", "staff"],
      role_words: ["engineer"],
      excluded_title_words: ["intern"],
      team_name_words: [],
      excluded_states: ["CA", "NY"],
      missing_languages: [],
      comp_floor: 175_000,
      max_age_days: null,
      excluded_locations: [],
      product_words: ["product", "growth"],
      assumed_bonus_pct: null,
    },
  });
});

test("patchFrom refuses a comp floor that is not a number", () => {
  const outcome = patchFrom({ ...fieldsFrom(CRITERIA), compFloor: "not a number" });
  assert.deepEqual(outcome, { error: "The comp floor must be a number." });
});

test("patchFrom refuses a blank comp floor", () => {
  const outcome = patchFrom({ ...fieldsFrom(CRITERIA), compFloor: "" });
  assert.deepEqual(outcome, { error: "The comp floor must be a number." });
});

test("patchFrom turns blank max age into null and 90 into 90", () => {
  const fields = { ...fieldsFrom(CRITERIA), maxAgeDays: "" };
  const outcome = patchFrom(fields);
  if ("patch" in outcome) {
    assert.equal(outcome.patch.max_age_days, null);
  } else {
    assert.fail("Expected patch, got error");
  }

  const fieldsWithAge = { ...fieldsFrom(CRITERIA), maxAgeDays: "90" };
  const outcomeWithAge = patchFrom(fieldsWithAge);
  if ("patch" in outcomeWithAge) {
    assert.equal(outcomeWithAge.patch.max_age_days, 90);
  } else {
    assert.fail("Expected patch, got error");
  }
});

test("patchFrom refuses a max age that is not decimal digits, including exponent and hex spellings", () => {
  const testCases = ["abc", "-1", "2.5", "1e3", "0x5A"];
  for (const value of testCases) {
    const outcome = patchFrom({ ...fieldsFrom(CRITERIA), maxAgeDays: value });
    assert.deepEqual(outcome, {
      error: "The max age must be a whole number of days, or blank for none.",
    });
  }
});

test("patchFrom accepts a max age typed with surrounding spaces", () => {
  const outcome = patchFrom({ ...fieldsFrom(CRITERIA), maxAgeDays: " 90 " });
  if ("patch" in outcome) {
    assert.equal(outcome.patch.max_age_days, 90);
  } else {
    assert.fail("Expected patch, got error");
  }
});

test("patchFrom turns blank assumed bonus % into null and 12 into 12", () => {
  const fields = { ...fieldsFrom(CRITERIA), assumedBonusPct: "" };
  const outcome = patchFrom(fields);
  if ("patch" in outcome) {
    assert.equal(outcome.patch.assumed_bonus_pct, null);
  } else {
    assert.fail("Expected patch, got error");
  }

  const fieldsWithBonus = { ...fieldsFrom(CRITERIA), assumedBonusPct: "12" };
  const outcomeWithBonus = patchFrom(fieldsWithBonus);
  if ("patch" in outcomeWithBonus) {
    assert.equal(outcomeWithBonus.patch.assumed_bonus_pct, 12);
  } else {
    assert.fail("Expected patch, got error");
  }
});

test("patchFrom refuses an assumed bonus % that is not decimal digits, including exponent and hex spellings", () => {
  const testCases = ["abc", "-1", "2.5", "1e3", "0x5A"];
  for (const value of testCases) {
    const outcome = patchFrom({ ...fieldsFrom(CRITERIA), assumedBonusPct: value });
    assert.deepEqual(outcome, {
      error: "The assumed bonus % must be a whole number 0–100, or blank for none.",
    });
  }
});

test("patchFrom refuses an assumed bonus % above 100", () => {
  const outcome = patchFrom({ ...fieldsFrom(CRITERIA), assumedBonusPct: "101" });
  assert.deepEqual(outcome, {
    error: "The assumed bonus % must be a whole number 0–100, or blank for none.",
  });
});

test("patchFrom accepts an assumed bonus % typed with surrounding spaces", () => {
  const outcome = patchFrom({ ...fieldsFrom(CRITERIA), assumedBonusPct: " 12 " });
  if ("patch" in outcome) {
    assert.equal(outcome.patch.assumed_bonus_pct, 12);
  } else {
    assert.fail("Expected patch, got error");
  }
});

test("rowsFor shows at least three rows even for empty lists", () => {
  assert.equal(rowsFor(""), 3);
  assert.equal(rowsFor("   \n  "), 3);
});

test("rowsFor gives each item a line plus one spare line", () => {
  assert.equal(rowsFor("a\nb\nc\nd"), 5);
  assert.equal(rowsFor("senior\nstaff\nlead"), 4);
});

test("floorLabel formats a number as a money string", () => {
  assert.equal(floorLabel("180000"), "$180k");
  assert.equal(floorLabel("150000"), "$150k");
  assert.equal(floorLabel("250500"), "$251k");
});

test("floorLabel returns null for non-numbers and empty strings", () => {
  assert.equal(floorLabel(""), null);
  assert.equal(floorLabel("x"), null);
  assert.equal(floorLabel("not a number"), null);
  assert.equal(floorLabel("   \n  "), null);
});

test("CriteriaView prefills every field from the saved criteria row", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /senior\nstaff/);
  assert.match(html, /engineer/);
  assert.match(html, /intern/);
  assert.match(html, /160000/);
  assert.match(html, /re-judges every posting at the next run/);
});

test("CriteriaView offers one Save that writes every field at once", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  const saveButtons = [...html.matchAll(/type="submit"/g)];
  assert.equal(saveButtons.length, 1);
});

test("CriteriaView sizes textareas to their list length and shows the floor as money", async () => {
  const html = await render(CriteriaView, {
    criteria: { ...CRITERIA, role_words: ["engineer", "developer", "programmer", "architect"] },
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  // Four role words plus one spare line.
  assert.equal([...html.matchAll(/rows="5"/g)].length, 1);
  assert.match(html, /Role words<\/span><textarea rows="5">/);
  // Two level words plus one spare is the three-row minimum.
  assert.match(html, /Level words<\/span><textarea rows="3">/);
  assert.match(html, /<em class="money">\$160k<\/em>/);
});

test("CriteriaView carries an Excluded locations textarea and a Max age input", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Excluded locations<\/span><textarea/);
  assert.match(html, /Max age.*<input type="text" inputmode="numeric"/);
});

test("CriteriaView carries an Assumed bonus % input", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Assumed bonus %.*<input type="text" inputmode="numeric"/);
});

test("CriteriaView carries a Product words textarea", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Product words<\/span><textarea/);
});

// SSR never runs the submit handler, so `save` is captured off `setup()`'s
// return via a thin wrapper and called directly; fake timers keep the
// toast's auto-dismiss from leaving a real 4s timer pending.

interface CriteriaViewBindings {
  readonly toast: { value: ToastState | null };
  save(): Promise<void>;
}

type CriteriaViewSetupParams = Parameters<NonNullable<typeof CriteriaView.setup>>;

test("CriteriaView shows a Saved. toast after a successful save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const captured: { bindings?: CriteriaViewBindings } = {};
  const TestableCriteriaView = {
    ...CriteriaView,
    setup(props: CriteriaViewSetupParams[0], ctx: CriteriaViewSetupParams[1]) {
      const bindings = CriteriaView.setup!(props, ctx) as unknown as CriteriaViewBindings;
      captured.bindings = bindings;
      return bindings;
    },
  };

  await render(TestableCriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{}]), { status: 200 })) as typeof fetch;
  try {
    await captured.bindings!.save();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const Prefilled = { ...CriteriaView, setup: () => captured.bindings };
  const html = await render(Prefilled, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  assert.match(html, /<p class="toast notice" role="status">Saved\.<\/p>/);
});
