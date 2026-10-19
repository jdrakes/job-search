import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failingCriterion,
  missCause,
  titleMatches,
  type Match,
  type MissInput,
} from "../scripts/explain-miss.ts";
import type { Criteria } from "../src/schema.ts";

const base: MissInput = { companyKnown: true, boardCount: 1, matches: [], searchHit: null };

const admitted: Match = { rejectedBy: null, stored: null };
const rejected: Match = {
  rejectedBy: { criterion: "role", detail: "title carries no role word" },
  stored: null,
};

test("an unknown company is named before anything else", () => {
  assert.equal(missCause({ ...base, companyKnown: false, boardCount: 0 }), "company unknown");
});

test("a known company with no board has no board", () => {
  assert.equal(missCause({ ...base, boardCount: 0 }), "no board");
});

test("no match and no search hit is not on board", () => {
  assert.equal(missCause(base), "not on board");
  assert.equal(missCause({ ...base, searchHit: false }), "not on board");
});

test("no match but a Workday search hit is outside the reader's search", () => {
  assert.equal(missCause({ ...base, searchHit: true }), "outside the reader's search");
});

test("a rejected match names its criterion and detail", () => {
  assert.equal(
    missCause({ ...base, matches: [rejected] }),
    "judged out: role: title carries no role word",
  );
});

test("a kept stored match is stored", () => {
  const match: Match = { rejectedBy: null, stored: { kept: true, hiddenReasons: [] } };
  assert.equal(missCause({ ...base, matches: [match] }), "stored");
});

test("a stored match that is not kept lists its reasons", () => {
  const match: Match = {
    rejectedBy: null,
    stored: { kept: false, hiddenReasons: ["age", "gone"] },
  };
  assert.equal(missCause({ ...base, matches: [match] }), "stored, hidden: age, gone");
});

test("a stored match wins over a rejected one", () => {
  const match: Match = { rejectedBy: null, stored: { kept: true, hiddenReasons: [] } };
  assert.equal(missCause({ ...base, matches: [rejected, match] }), "stored");
});

test("an admitted match the store lacks is not yet stored", () => {
  assert.equal(missCause({ ...base, matches: [rejected, admitted] }), "admitted, not yet stored");
});

test("title words match in any order, ignoring case and punctuation", () => {
  assert.equal(titleMatches("Staff Engineer, Applied AI", "applied ai STAFF engineer"), true);
  assert.equal(titleMatches("Staff Engineer", "Staff Software Engineer"), false);
  assert.equal(titleMatches(null, "Staff"), false);
});

const criteria = {
  level_words: ["staff"],
  role_words: ["backend"],
  excluded_title_words: [],
  team_name_words: [],
  excluded_locations: [],
  comp_floor: 120000,
} as unknown as Criteria;

test("the first failing rule is named, role before place", () => {
  const reason = failingCriterion(
    { title: "Staff Chef", location: null, compHigh: 200000 },
    false,
    criteria,
  );
  assert.equal(reason?.criterion, "role");
});

test("a title that passes every rule has no failing criterion", () => {
  const reason = failingCriterion(
    { title: "Staff Backend Engineer", location: null, compHigh: null },
    false,
    criteria,
  );
  assert.equal(reason, null);
});
