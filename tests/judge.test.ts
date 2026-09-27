import assert from "node:assert/strict";
import { test } from "node:test";

import { fullJudgment, judge, needsJudging, representativeByKey } from "../src/judge/judge.ts";
import { boardIndex, NO_BOARDS } from "../src/judge/listing.ts";
import type { Company, Criteria, Posting } from "../src/schema.ts";

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    id: 1,
    level_words: ["staff", "senior staff", "principal", "distinguished", "architect", "lead"],
    role_words: ["backend", "full stack", "platform"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: ["Wyoming"],
    missing_languages: ["cobol", "fortran", "delphi"],
    comp_floor: 120000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

// `gone_at` is not yet a `Posting` column (it lands with the gone_at
// migration), so it is carried here as an ad hoc extra field, the same way
// `listing.ts`'s `GoneAtColumn` stands in for it.
function posting(
  overrides: Partial<Posting> & { readonly gone_at?: string | null } = {},
): Posting & { readonly gone_at: string | null } {
  return {
    key: "acme::1",
    company: "Acme",
    platform: "greenhouse",
    board: "board",
    title: null,
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2020-01-01T00:00:00.000Z",
    last_seen: "2020-01-01T00:00:00.000Z",
    live: null,
    body: null,
    kept: null,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    gone_at: null,
    ...overrides,
  };
}

function company(name: string, overrides: Partial<Company> = {}): Company {
  return {
    name,
    state: "watched",
    boards: [],
    source: "test",
    reason: null,
    first_seen: "2026-09-15T00:00:00.000Z",
    last_seen: "2026-09-15T00:00:00.000Z",
    dropped_at: null,
    alias_of: null,
    ...overrides,
  };
}

// The fixture posting's board, `greenhouse/board`, read on the 16th.
const READ_ON_16TH = boardIndex([
  company("Acme", {
    boards: [{ platform: "greenhouse", id: "board", last_read: "2026-09-16T06:00:00.000Z" }],
  }),
]);

test("fullJudgment: text criteria are not consulted for a posting the listing criteria dropped", () => {
  const result = fullJudgment(
    posting({
      title: "Staff Engineer", // no role word: listing drops it
      body: "This is a hybrid role, not remote, and requires Delphi.",
    }),
    criteria(),
  );

  assert.equal(result.kept, false);
  const criterionNames = result.reasons.map((reason) => reason.criterion);
  assert.deepEqual(criterionNames, [
    "level",
    "role",
    "excluded_words",
    "country",
    "comp_floor",
    "age",
    "gone",
    "unwatched",
    "duplicate",
  ]);
});

test("fullJudgment: text criteria run and can keep a posting the listing criteria kept", () => {
  const result = fullJudgment(
    posting({
      title: "Staff Backend Engineer",
      comp_high: 250000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
    }),
    criteria(),
  );

  assert.equal(result.kept, true);
  const criterionNames = result.reasons.map((reason) => reason.criterion);
  assert.deepEqual(criterionNames, [
    "level",
    "role",
    "excluded_words",
    "country",
    "comp_floor",
    "age",
    "gone",
    "unwatched",
    "duplicate",
    "remote",
    "excluded_states",
    "country_restriction",
    "missing_languages",
    "bonus",
  ]);
});

// A foreign location label has to stop the posting before the text
// criteria run, or the fetch is paid for nothing.
test("fullJudgment: a foreign location label drops a posting without consulting its text", () => {
  const result = fullJudgment(
    posting({
      title: "Staff Backend Engineer",
      location: "Bengaluru, India",
      comp_high: 250000,
      body: "This is a fully remote position.",
    }),
    criteria(),
  );

  assert.equal(result.kept, false);
  assert.deepEqual(
    result.reasons.find((reason) => reason.criterion === "country"),
    {
      criterion: "country",
      verdict: "out",
      detail: 'location "Bengaluru, India" names "India", not the United States',
    },
  );
  assert.equal(
    result.reasons.find((reason) => reason.criterion === "remote"),
    undefined,
  );
});

test("fullJudgment: a body restricting the role abroad drops a posting whose label named no country", () => {
  const result = fullJudgment(
    posting({
      title: "Staff Backend Engineer",
      location: "Remote",
      comp_high: 250000,
      body: "This is a fully remote position. Applicants must be residing in Portugal.",
    }),
    criteria(),
  );

  assert.equal(result.kept, false);
  const detailOf = (criterion: string) =>
    result.reasons.find((reason) => reason.criterion === criterion)?.detail;
  assert.equal(
    detailOf("country"),
    'location "Remote" names no country other than the United States',
  );
  assert.match(String(detailOf("country_restriction")), /Portugal/);
});

test("judge: records the criteria's updated_at as judged_with", () => {
  const result = judge(posting({ title: "Staff Backend Engineer" }), criteria());
  assert.equal(result.judged_with, "2026-09-14T00:00:00Z");
});

// Every criterion the kept fixture posting runs, listing then text.
const KEPT_CRITERIA = [
  "level",
  "role",
  "excluded_words",
  "country",
  "comp_floor",
  "age",
  "gone",
  "unwatched",
  "duplicate",
  "remote",
  "excluded_states",
  "country_restriction",
  "missing_languages",
  "bonus",
];

const KEPT_POSTING = {
  title: "Staff Backend Engineer",
  comp_high: 250000,
  body: "This is a fully remote position open to candidates anywhere in the US.",
};

// Out on `role` (no role word) and `comp_floor` (below 120000), in on the
// rest of the listing criteria.
const TWO_OUT_POSTING = { title: "Staff Engineer", comp_high: 90000 };

test("judge: a kept posting stores no reasons and evidence for every criterion that ran", () => {
  const result = judge(posting(KEPT_POSTING), criteria());
  assert.equal(result.kept, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(Object.keys(result.evidence), KEPT_CRITERIA);
});

test("judge: a posting out and not acted on stores its failed criteria by name and no evidence", () => {
  const result = judge(posting(TWO_OUT_POSTING), criteria());
  assert.equal(result.kept, false);
  assert.deepEqual(result.reasons, ["role", "comp_floor"]);
  assert.deepEqual(result.evidence, {});
});

test("judge: a posting out but acted on keeps the evidence of every criterion that ran", () => {
  const acted = posting({ ...TWO_OUT_POSTING, status: "applied" });
  const result = judge(acted, criteria());
  assert.equal(result.kept, false);
  assert.deepEqual(result.reasons, ["role", "comp_floor"]);
  assert.deepEqual(result.evidence, {
    level: 'title carries level word "staff"',
    role: "title carries no role word",
    excluded_words: "title carries no excluded word outside a team name",
    country: "posting names no location",
    comp_floor: "comp_high 90000 is below the floor 120000",
    age: "no max age set",
    gone: "listed at the board's last read",
    unwatched: "company not on record",
    duplicate: "no later, level-admitted posting shares its board, date, band, place and title",
  });
});

test("judge: evidence is keyed by criterion, quoting the same text as its reason", () => {
  const result = judge(
    posting({
      title: "Staff Backend Engineer",
      comp_high: 250000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
    }),
    criteria(),
  );
  const remoteReason = fullJudgment(
    posting({
      title: "Staff Backend Engineer",
      comp_high: 250000,
      body: "This is a fully remote position open to candidates anywhere in the US.",
    }),
    criteria(),
  ).reasons.find((reason) => reason.criterion === "remote");
  assert.ok(remoteReason);
  assert.equal(result.evidence["remote"], remoteReason.detail);
});

test("judge: passes now through to the listing criteria", () => {
  const result = judge(
    posting({
      title: "Staff Backend Engineer",
      comp_high: 250000,
      posted_at: "2026-06-09T00:00:00Z",
    }),
    criteria({ max_age_days: 90 }),
    "2026-09-17T00:00:00Z",
  );
  assert.deepEqual(result.reasons, ["age"]);
});

test("judge: a posting not acted on past the max age is decided on age alone", () => {
  const result = judge(
    posting({
      status: null,
      posted_at: "2026-08-08T00:00:00Z", // 40 days before now
    }),
    criteria({ max_age_days: 35 }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(result.kept, false);
  assert.deepEqual(result.reasons, ["age"]);
  assert.deepEqual(
    fullJudgment(
      posting({ status: null, posted_at: "2026-08-08T00:00:00Z" }),
      criteria({ max_age_days: 35 }),
      "2026-09-17T00:00:00Z",
    ).reasons,
    [{ criterion: "age", verdict: "out", detail: "posted 40 days ago, past the max age 35" }],
  );
});

test("fullJudgment: a posting acted on past the max age still runs the full judgment", () => {
  const result = fullJudgment(
    posting({
      status: "applied",
      posted_at: "2026-08-08T00:00:00Z", // 40 days before now
    }),
    criteria({ max_age_days: 35 }),
    "2026-09-17T00:00:00Z",
  );
  assert.ok(result.reasons.length > 1);
});

test("fullJudgment: a posting past the max age with no posted_at still runs the full judgment", () => {
  const result = fullJudgment(
    posting({
      status: null,
      posted_at: null,
    }),
    criteria({ max_age_days: 35 }),
    "2026-09-17T00:00:00Z",
  );
  assert.ok(result.reasons.length > 1);
});

test("fullJudgment: a posting past what would be the max age runs the full judgment when no max age is set", () => {
  const result = fullJudgment(
    posting({
      status: null,
      posted_at: "2026-08-08T00:00:00Z", // 40 days before now
    }),
    criteria({ max_age_days: null }),
    "2026-09-17T00:00:00Z",
  );
  assert.ok(result.reasons.length > 1);
});

test("fullJudgment: a posting not acted on but within the max age runs the full judgment", () => {
  const result = fullJudgment(
    posting({
      status: null,
      posted_at: "2026-09-07T00:00:00Z", // 10 days before now
    }),
    criteria({ max_age_days: 35 }),
    "2026-09-17T00:00:00Z",
  );
  assert.ok(result.reasons.length > 1);
});

test("needsJudging: true when the posting has never been judged", () => {
  assert.equal(needsJudging(posting({ judged_with: null }), criteria()), true);
});

test("needsJudging: false when judged_with matches the criteria's updated_at", () => {
  assert.equal(needsJudging(posting({ judged_with: "2026-09-14T00:00:00Z" }), criteria()), false);
});

test("needsJudging: a criteria change (a newer updated_at) makes an already-judged posting need judging again", () => {
  const stale = posting({ judged_with: "2026-09-01T00:00:00Z" });
  assert.equal(needsJudging(stale, criteria({ updated_at: "2026-09-14T00:00:00Z" })), true);
});

test("needsJudging: false when the posting was judged after the criteria's updated_at", () => {
  const fresh = posting({ judged_with: "2026-09-20T00:00:00Z" });
  assert.equal(needsJudging(fresh, criteria({ updated_at: "2026-09-14T00:00:00Z" })), false);
});

// Only a kept row whose age has passed the max is picked up.
test("needsJudging: a kept posting now past the max age needs judging again with nothing edited", () => {
  const aged = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    posted_at: "2026-06-09T00:00:00Z",
  });
  assert.equal(needsJudging(aged, criteria({ max_age_days: 90 }), "2026-09-17T00:00:00Z"), true);
});

test("needsJudging: a kept posting still within the max age does not need judging again", () => {
  const recent = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    posted_at: "2026-08-18T00:00:00Z",
  });
  assert.equal(needsJudging(recent, criteria({ max_age_days: 90 }), "2026-09-17T00:00:00Z"), false);
});

test("needsJudging: a dropped posting past the max age does not need judging again", () => {
  const dropped = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: false,
    posted_at: "2026-06-09T00:00:00Z",
  });
  assert.equal(
    needsJudging(dropped, criteria({ max_age_days: 90 }), "2026-09-17T00:00:00Z"),
    false,
  );
});

test("needsJudging: no max age set never makes an already-judged posting need judging again", () => {
  const ancient = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    posted_at: "2020-01-01T00:00:00Z",
  });
  assert.equal(
    needsJudging(ancient, criteria({ max_age_days: null }), "2026-09-17T00:00:00Z"),
    false,
  );
});

test("needsJudging: a kept posting the board gave no date for never ages out", () => {
  const undated = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    posted_at: null,
  });
  assert.equal(
    needsJudging(undated, criteria({ max_age_days: 90 }), "2026-09-17T00:00:00Z"),
    false,
  );
});

// The gone criterion has no check of its own in `needsJudging` any more:
// `listCompany` (ingest.ts) already sets `judged_with: null` on every row
// whose `gone_at` changes, gone or returned, so this is caught by the
// staleness check alone, the same as any other stored verdict gone stale.
test("needsJudging: a kept posting with gone_at newly set and judged_with cleared is re-judged", () => {
  const justMarkedGone = posting({
    judged_with: null,
    kept: true,
    gone_at: "2026-09-17T06:00:00.000Z",
  });
  assert.equal(needsJudging(justMarkedGone, criteria(), "2026-09-17T00:00:00Z"), true);
});

test("needsJudging: a kept posting whose company is now an alias needs judging again", () => {
  const nowAlias = posting({ judged_with: "2026-09-14T00:00:00Z", kept: true });
  const alias = boardIndex([company("Acme", { state: "alias" })]);
  assert.equal(needsJudging(nowAlias, criteria(), "2026-09-17T00:00:00Z", alias), true);
});

// Only its stored unwatched-out reason marks a dropped-company posting back
// in when James puts the company back.
const UNWATCHED_OUT = "unwatched";

test("needsJudging: an unwatched-out posting whose board is watched again needs judging again", () => {
  const relisted = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: false,
    reasons: [UNWATCHED_OUT],
  });
  assert.equal(needsJudging(relisted, criteria(), "2026-09-17T00:00:00Z", READ_ON_16TH), true);
});

test("needsJudging: a posting out on another criterion is not re-judged just because its company is later an alias", () => {
  const levelOut = posting({
    judged_with: "2026-09-14T00:00:00Z",
    kept: false,
    reasons: ["level"],
  });
  const alias = boardIndex([company("Acme", { state: "alias" })]);
  assert.equal(needsJudging(levelOut, criteria(), "2026-09-17T00:00:00Z", alias), false);
});

// The map is built by `representativeByKey` itself, as `ingest.ts` builds
// the real one: the key's exact format is `duplicateKey`'s to decide.
const DUPLICATE_OUT = "duplicate";

test("needsJudging: a kept posting that is no longer its group's representative needs judging again", () => {
  const representativeRow = posting({
    key: "acme::1",
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
  });
  const olderKept = posting({
    key: "acme::2",
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const representative = representativeByKey([representativeRow, olderKept], criteria());
  assert.equal(
    needsJudging(olderKept, criteria(), "2026-09-17T00:00:00Z", NO_BOARDS, representative),
    true,
  );
});

test("needsJudging: a kept posting still its group's representative does not need judging again", () => {
  const representativeRow = posting({
    key: "acme::1",
    judged_with: "2026-09-14T00:00:00Z",
    kept: true,
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
  });
  const older = posting({
    key: "acme::2",
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const representative = representativeByKey([representativeRow, older], criteria());
  assert.equal(
    needsJudging(representativeRow, criteria(), "2026-09-17T00:00:00Z", NO_BOARDS, representative),
    false,
  );
});

test("needsJudging: a duplicate-out row that became its group's representative needs judging again", () => {
  // The earlier representative's own key moved, so this row is now the
  // sole survivor at its key.
  const becameRepresentative = posting({
    key: "acme::2",
    judged_with: "2026-09-14T00:00:00Z",
    kept: false,
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    reasons: [DUPLICATE_OUT],
  });
  const representative = representativeByKey([becameRepresentative], criteria());
  assert.equal(
    needsJudging(
      becameRepresentative,
      criteria(),
      "2026-09-17T00:00:00Z",
      NO_BOARDS,
      representative,
    ),
    true,
  );
});

test("needsJudging: a duplicate-out row still not its group's representative does not need judging again", () => {
  const representativeRow = posting({
    key: "acme::1",
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
  });
  const stillDuplicate = posting({
    key: "acme::2",
    judged_with: "2026-09-14T00:00:00Z",
    kept: false,
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
    reasons: [DUPLICATE_OUT],
  });
  const representative = representativeByKey([representativeRow, stillDuplicate], criteria());
  assert.equal(
    needsJudging(stillDuplicate, criteria(), "2026-09-17T00:00:00Z", NO_BOARDS, representative),
    false,
  );
});

test("representativeByKey: picks the row with the latest first_seen at a shared key", () => {
  const later = posting({
    key: "acme::2",
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
  });
  const earlier = posting({
    key: "acme::1",
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const map = representativeByKey([later, earlier], criteria());
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0], "acme::2");
});

test("representativeByKey: a tie on first_seen is broken by the larger posting key", () => {
  const higherKey = posting({
    key: "acme::2",
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const lowerKey = posting({
    key: "acme::1",
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const map = representativeByKey([higherKey, lowerKey], criteria());
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0], "acme::2");
});

// "The latest seen that the level criterion admits", not simply the
// latest: a pay-less "Software Engineer II" posted after a "Principal
// Software Engineer" at the same key does not outrank it.
test("representativeByKey: a group whose latest row the level criterion refuses is represented by the earlier, admitted row", () => {
  const principal = posting({
    key: "acme::1",
    title: "Principal Software Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const payless = posting({
    key: "acme::2",
    title: "Software Engineer II",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
  });
  const map = representativeByKey([principal, payless], criteria());
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0], "acme::1");
});

// A representative gone by `goneBy` must not hold its group, or every
// other row at its key stays out as a duplicate of a row nothing will
// bring back.
test("representativeByKey: a gone representative is skipped, so the next latest at its key takes over", () => {
  const latestButGone = posting({
    key: "acme::1",
    title: "Staff Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-15T00:00:00.000Z",
    gone_at: "2026-09-16T06:00:00.000Z",
  });
  const earlierStillHere = posting({
    key: "acme::2",
    title: "Lead Product Engineer",
    posted_at: "2026-08-14",
    first_seen: "2026-08-14T00:00:00.000Z",
  });
  const map = representativeByKey([latestButGone, earlierStillHere], criteria());
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0], "acme::2");
});
