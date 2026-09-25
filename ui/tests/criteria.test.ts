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
  TagInput,
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

// A `confirm` that never blocks a test on a real dialog Node has no
// `window` to show; a test that wants to see the confirm refused passes its
// own `() => false`.
const ALWAYS_CONFIRM = () => true;

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

test("CriteriaView groups every field under a labelled fieldset", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  for (const legend of ["Title", "Location", "Language", "Ranking only", "Pay &amp; freshness"]) {
    assert.match(html, new RegExp(`<legend>${legend}</legend>`));
  }
  assert.equal([...html.matchAll(/<fieldset class="criteria-group"/g)].length, 5);
});

test("CriteriaView prefills every field from the saved criteria row, each item its own chip", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /<li class="tag"><span>senior<\/span>/);
  assert.match(html, /<li class="tag"><span>staff<\/span>/);
  assert.match(html, /<li class="tag"><span>engineer<\/span>/);
  assert.match(html, /<li class="tag"><span>intern<\/span>/);
  assert.match(html, /value="160000"/);
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

test("CriteriaView disables Save until a field actually changes", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /<button type="submit" class="primary" disabled(="")?>Save<\/button>/);
});

test("CriteriaView shows the floor as money next to Comp floor", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Comp floor <em class="money">\$160k<\/em>/);
});

test("CriteriaView carries an Excluded locations tag editor and a Max age input", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /Excluded locations<\/span>/);
  assert.match(html, /placeholder="Add to excluded locations"/);
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

test("CriteriaView carries a Product words tag editor, marked as ranking only", async () => {
  const html = await render(CriteriaView, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });

  assert.match(html, /<legend>Ranking only<\/legend>/);
  assert.match(html, /placeholder="Add to product words"/);
});

// TagInput's `commit`/`removeAt` fire from DOM events SSR never runs, so
// they are exercised directly off `setup()`'s return, the same way
// `CriteriaView`'s `save` is below.
interface TagInputBindings {
  readonly draft: { value: string };
  readonly items: { value: readonly string[] };
  commit(): void;
  removeAt(index: number): void;
}

test("TagInput's commit adds the trimmed draft once and clears it, skipping a blank or duplicate", () => {
  let value = "senior\nstaff";
  const bindings = TagInput.setup!(
    { modelValue: value, addLabel: "Add" } as never,
    { emit: (_event: string, next: string) => (value = next) } as never,
  ) as unknown as TagInputBindings;

  bindings.draft.value = "  lead  ";
  bindings.commit();
  assert.equal(value, "senior\nstaff\nlead");
  assert.equal(bindings.draft.value, "");

  bindings.draft.value = "   ";
  bindings.commit();
  assert.equal(value, "senior\nstaff\nlead", "a blank draft adds nothing");

  bindings.draft.value = "staff";
  bindings.commit();
  assert.equal(value, "senior\nstaff\nlead", "a word already in the list is not added twice");
});

test("TagInput's removeAt drops only the item at that index", () => {
  let value = "senior\nstaff\nlead";
  const bindings = TagInput.setup!(
    { modelValue: value, addLabel: "Add" } as never,
    { emit: (_event: string, next: string) => (value = next) } as never,
  ) as unknown as TagInputBindings;

  bindings.removeAt(1);
  assert.equal(value, "senior\nlead");
});

// SSR never runs the submit handler, so `save` is captured off `setup()`'s
// return via a thin wrapper and called directly; fake timers keep the
// toast's auto-dismiss from leaving a real 4s timer pending.

interface CriteriaViewBindings {
  readonly toast: { value: ToastState | null };
  readonly fields: { value: Record<string, string> };
  readonly dirty: { value: boolean };
  save(): Promise<void>;
}

type CriteriaViewSetupParams = Parameters<NonNullable<typeof CriteriaView.setup>>;

function capture(): { bindings?: CriteriaViewBindings; component: object } {
  const captured: { bindings?: CriteriaViewBindings } = {};
  const component = {
    ...CriteriaView,
    setup(props: CriteriaViewSetupParams[0], ctx: CriteriaViewSetupParams[1]) {
      const bindings = CriteriaView.setup!(props, ctx) as unknown as CriteriaViewBindings;
      captured.bindings = bindings;
      return bindings;
    },
  };
  return {
    get bindings() {
      return captured.bindings;
    },
    component,
  } as {
    bindings?: CriteriaViewBindings;
    component: object;
  };
}

test("CriteriaView shows a Saved. toast after a successful save, and Save disables again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const captured = capture();
  await render(captured.component, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    confirm: ALWAYS_CONFIRM,
  });

  captured.bindings!.fields.value = { ...captured.bindings!.fields.value, compFloor: "175000" };
  assert.equal(captured.bindings!.dirty.value, true, "changing a field marks the form dirty");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{}]), { status: 200 })) as typeof fetch;
  try {
    await captured.bindings!.save();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.bindings!.dirty.value, false, "a saved value is the new baseline");

  const Prefilled = { ...CriteriaView, setup: () => captured.bindings };
  const html = await render(Prefilled, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
  });
  assert.match(html, /<p class="toast notice" role="status">Saved\.<\/p>/);
});

test("CriteriaView asks to confirm before saving, and a refusal writes nothing", async () => {
  const captured = capture();
  await render(captured.component, {
    criteria: CRITERIA,
    config: CONFIG,
    accessToken: ACCESS_TOKEN,
    confirm: () => false,
  });

  captured.bindings!.fields.value = { ...captured.bindings!.fields.value, compFloor: "175000" };

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify([{}]), { status: 200 });
  }) as typeof fetch;
  try {
    await captured.bindings!.save();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false, "a refused confirm never reaches the store");
  assert.equal(captured.bindings!.dirty.value, true, "the unsaved change is still there");
});
