import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failingCriterion,
  findCompany,
  missCause,
  titleMatches,
  workdaySearchHit,
  type Match,
  type MissInput,
} from "../scripts/explain-miss.ts";
import type { Board, Criteria } from "../src/schema.ts";

const base: MissInput = {
  companyKnown: true,
  boardCount: 1,
  failedReads: 0,
  matches: [],
  searchHit: null,
};

const admitted: Match = { rejectedBy: null, stored: null };
const rejected: Match = {
  rejectedBy: { criterion: "role", detail: "title carries no role word" },
  stored: null,
};

test("an unknown company is named before anything else", () => {
  assert.equal(missCause({ ...base, companyKnown: false, boardCount: 0 }), "company unknown");
});

const pantheons = [{ name: "Pantheon Systems, Inc" }, { name: "Pantheon Platform" }];

test("a company is found by its whole name, ignoring case", () => {
  assert.deepEqual(findCompany(pantheons, "pantheon platform"), {
    ok: true,
    value: { name: "Pantheon Platform" },
  });
});

test("a company is found by the start of its name when only one starts so", () => {
  assert.deepEqual(findCompany(pantheons, "Pantheon Systems"), {
    ok: true,
    value: { name: "Pantheon Systems, Inc" },
  });
});

test("a name no company carries is null", () => {
  assert.deepEqual(findCompany(pantheons, "Systems"), { ok: true, value: null });
});

test("a name that starts several companies is returned, not guessed", () => {
  const result = findCompany(pantheons, "Pantheon");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /starts 2 company names/);
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

// Breaks if missCause stops checking failedReads before "not on board".
test("no match after a failed read is unknown, not absent", () => {
  assert.equal(
    missCause({ ...base, boardCount: 2, failedReads: 1 }),
    "unknown, 1 board read(s) failed",
  );
});

// Breaks if the failed-read check moves ahead of the stored match.
test("a stored match decides the cause despite a failed read", () => {
  const match: Match = { rejectedBy: null, stored: { kept: true, hiddenReasons: [] } };
  assert.equal(missCause({ ...base, boardCount: 2, failedReads: 1, matches: [match] }), "stored");
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

const workdayBoard = { platform: "workday", id: "wd5/Careers/acme" } as Board;
const httpOptions = {
  userAgent: "test-bot (+https://example.com)",
  sleep: async () => {},
  retries: 0,
};

// Breaks if workdaySearchHit lets a failed POST throw out of the board loop.
test("a failing Workday title search is returned, not thrown", async () => {
  const fetchImpl: typeof fetch = async () => new Response("down", { status: 500 });
  const result = await workdaySearchHit(workdayBoard, "Staff Engineer", {
    ...httpOptions,
    fetchImpl,
  });
  assert.equal(result.ok, false);
});

// Breaks if the search URL stops coming from the reader's cxsUrl.
test("a Workday title search posts to the tenant's CXS jobs URL", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ jobPostings: [{ title: "Staff Engineer, Search" }] }));
  };
  const result = await workdaySearchHit(workdayBoard, "staff engineer", {
    ...httpOptions,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, value: true });
  assert.deepEqual(urls, ["https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs"]);
});
