import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  boardIndex,
  duplicateKey,
  goneBy,
  judgeListing,
  NO_BOARDS,
  type Reason,
  unwatchedBy,
} from "../src/judge/listing.ts";
import type { Company, Criteria, Posting } from "../src/schema.ts";

// The seeded criteria values, a plain fixture; each test file owns its own.
function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    id: 1,
    level_words: ["staff", "senior staff", "principal", "distinguished", "architect", "lead"],
    role_words: [
      "backend",
      "back-end",
      "back end",
      "full-stack",
      "full stack",
      "fullstack",
      "platform",
      "infrastructure",
      "infra",
      "distributed",
      "api",
      "services",
      "payments",
      "software engineer",
      "swe",
    ],
    excluded_title_words: [
      "site reliability",
      "sre",
      "developer experience",
      "devex",
      "developer productivity",
      "cloud dx",
      "manager",
      "director",
      "recruiter",
      "sales",
      "marketing",
      "designer",
      "data scientist",
      "data scientists",
      "analyst",
      "support",
      "success",
      "solutions engineer",
      "solutions engineering",
      "customer",
      "technical account",
      "program manager",
      "product manager",
      "ios",
      "android",
      "mobile",
      "frontend",
      "front-end",
      "front end",
      "design",
      "hardware",
      "robotics",
      "machine learning",
      "ml",
      "ai",
      "data engineer",
      "data engineering",
      "data engineers",
      "analytics",
      "security",
      "qa",
      "sdet",
      "test",
      "quality",
      "ux",
      "devops",
      "it",
      "oracle",
      "people",
      "revenue operations",
      "waste",
      "forward deployed",
    ],
    team_name_words: ["customer", "marketing", "support", "success"],
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

function posting(overrides: Partial<Posting> = {}): Posting {
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
    ...overrides,
  };
}

function reasonFor(reasons: readonly Reason[], criterion: string): Reason {
  const found = reasons.find((reason) => reason.criterion === criterion);
  assert.ok(found, `no reason for criterion "${criterion}"`);
  return found;
}

test("level: in when the title carries a level word as a whole word", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Software Engineer" }), criteria());
  assert.equal(reasonFor(reasons, "level").verdict, "in");
});

test("level: in when the title carries a Roman numeral level marker", () => {
  const { reasons } = judgeListing(
    posting({ title: "Software Engineer II", comp_high: 250000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /II/);
});

test("level: out when the title carries a Roman numeral level marker but no pay", () => {
  const { reasons } = judgeListing(posting({ title: "Software Engineer II" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /II/);
  assert.match(level.detail, /no pay/);
});

test("level: out when the title carries a bare number level but no pay", () => {
  const { reasons } = judgeListing(posting({ title: "Engineer 3" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /no pay/);
});

test("level: in when the title carries a bare number level with pay", () => {
  const { reasons } = judgeListing(posting({ title: "Engineer 3", comp_high: 250000 }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
});

test("level: in when the title carries a single-digit bare number with pay", () => {
  const { reasons } = judgeListing(
    posting({ title: "Software Engineer 6", comp_high: 250000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /6/);
});

test("level: out when the title carries a year as a bare number with pay, not treated as a level", () => {
  const { reasons } = judgeListing(
    posting({ title: "Specialist 2027", comp_high: 250000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /no level word or marker/);
});

test("level: in when the title carries a two-digit bare number with pay", () => {
  const { reasons } = judgeListing(
    posting({ title: "Engineer 63", comp_high: 250000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /63/);
});

test("level: out when the title carries no level word or marker", () => {
  const { reasons } = judgeListing(posting({ title: "Software Engineer" }), criteria());
  assert.equal(reasonFor(reasons, "level").verdict, "out");
});

test("level: in when the title carries Senior with pay posted", () => {
  const { reasons } = judgeListing(
    posting({ title: "Senior Software Engineer", comp_high: 260000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /Senior/);
});

test("level: out when the title carries Senior but no pay is posted", () => {
  const { reasons } = judgeListing(posting({ title: "Senior Software Engineer" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /Senior/);
  assert.match(level.detail, /no pay/);
});

test("level: in when the title carries Senior Staff (a level word) even with no pay", () => {
  const { reasons } = judgeListing(
    posting({ title: "Senior Staff Software Engineer" }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
});

test("level: in when the title carries Sr. with pay settled", () => {
  const { reasons } = judgeListing(
    posting({ title: "Sr. Software Engineer", comp_high: 260000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /"Sr\."/);
});

test("level: in when the title carries Sr with pay settled", () => {
  const { reasons } = judgeListing(
    posting({ title: "Sr Software Engineer", comp_high: 260000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /"Sr"/);
});

test("level: in when the title carries Sr. Staff (a level word) even with no pay", () => {
  const { reasons } = judgeListing(posting({ title: "Sr. Staff Software Engineer" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
});

test("level: out when the title carries Sr. with no pay to settle it", () => {
  const { reasons } = judgeListing(posting({ title: "Sr. Software Engineer" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /"Sr\."/);
  assert.match(level.detail, /no pay/);
});

test("level: in when the title names engineering work with no level marker and pay is posted", () => {
  const { reasons } = judgeListing(
    posting({ title: "Software Engineer, Product", comp_high: 405000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /"engineer"/);
});

test("level: out when the title names engineering work with no level marker and no pay is posted", () => {
  const { reasons } = judgeListing(posting({ title: "Software Engineer, Product" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /"engineer"/);
  assert.match(level.detail, /no pay/);
});

test("level: out when the title carries no engineering word even with pay posted", () => {
  const { reasons } = judgeListing(
    posting({ title: "Account Executive, Financial Services", comp_high: 405000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /no level word or marker/);
});

test("level: out when the engineering word sits only in a team suffix, even with pay posted", () => {
  const { reasons } = judgeListing(
    posting({ title: "RVP, SOLUTION ENGINEERING, FINANCIAL SERVICES", comp_high: 346500 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /no level word or marker/);
});

test('level: in when the title names engineering work as "Developer" with pay posted', () => {
  const { reasons } = judgeListing(
    posting({ title: "Full Stack Developer", comp_high: 260000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /"developer"/);
});

test("level: in when the title carries a level word even with no pay, unaffected by the engineering-work rule", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Software Engineer" }), criteria());
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /"staff"/);
});

test("level: in; excluded_words: out when the title is 'Software Engineer Intern 2027' with pay", () => {
  // The engineering-word rule admits it on pay; the excluded word "intern"
  // is what drops it.
  const { kept, reasons } = judgeListing(
    posting({ title: "Software Engineer Intern 2027", comp_high: 250000 }),
    criteria({ excluded_title_words: ["intern"] }),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "in");
  assert.match(level.detail, /names engineering work/);
  assert.equal(kept, false);
  assert.equal(reasonFor(reasons, "excluded_words").verdict, "out");
});

test("level: out when the title is 'Backend Intern 2027' with pay", () => {
  // The title the two-digit rule protects: a role word, no engineering word.
  const { reasons } = judgeListing(
    posting({ title: "Backend Intern 2027", comp_high: 250000 }),
    criteria(),
  );
  const level = reasonFor(reasons, "level");
  assert.equal(level.verdict, "out");
  assert.match(level.detail, /no level word or marker/);
});

test("role: in when the title carries a role word as a whole word", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Backend Engineer" }), criteria());
  assert.equal(reasonFor(reasons, "role").verdict, "in");
});

test("role: out when the title carries no role word", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Engineer" }), criteria());
  assert.equal(reasonFor(reasons, "role").verdict, "out");
});

test("role: out when the role word names an industry, not engineering work", () => {
  const { reasons } = judgeListing(
    posting({ title: "Lead Estimator – Infrastructure & EPC" }),
    criteria(),
  );
  const role = reasonFor(reasons, "role");
  assert.equal(role.verdict, "out");
  assert.match(
    role.detail,
    /title carries role word "infrastructure" but names no engineering work/,
  );
});

test("role: in when the engineering word sits after the role word, past the comma", () => {
  const { reasons } = judgeListing(
    posting({ title: "Member of Technical Staff, Backend Engineer, API" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "role").verdict, "in");
});

test("role: in when architect is the engineering word", () => {
  const { reasons } = judgeListing(posting({ title: "Lead Platform Architect" }), criteria());
  assert.equal(reasonFor(reasons, "role").verdict, "in");
});

test("role: in when technical staff is the engineering word", () => {
  const { reasons } = judgeListing(
    posting({ title: "Member of the Technical Staff - Data Platform" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "role").verdict, "in");
});

test("role: out when the role word names an org unit, not engineering work", () => {
  const { reasons } = judgeListing(
    posting({ title: "Senior Account Executive - Financial Services" }),
    criteria(),
  );
  const role = reasonFor(reasons, "role");
  assert.equal(role.verdict, "out");
  assert.match(role.detail, /title carries role word "services" but names no engineering work/);
});

test("excluded words: out when the title carries an excluded word", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Site Reliability Engineer" }),
    criteria(),
  );
  const excluded = reasonFor(reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /site reliability/);
});

test("excluded words: in when the title carries no excluded word", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Backend Engineer" }), criteria());
  assert.equal(reasonFor(reasons, "excluded_words").verdict, "in");
});

// listing.ts shares the boundary rule with text.ts; `\b.zorp\b` would have
// read this title as carrying no excluded word. ".zorp" is a made-up term
// standing in for a real punctuation-edged word so this stays illustrative.
test("excluded words: out when an excluded word starts with punctuation", () => {
  const { reasons } = judgeListing(
    posting({ title: "Senior .Zorp Engineer" }),
    criteria({ excluded_title_words: [".zorp"] }),
  );
  const excluded = reasonFor(reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /\.zorp/);
});

test("excluded words: a punctuation-edged excluded word still needs its punctuation", () => {
  const { reasons } = judgeListing(
    posting({ title: "Senior ZorpSuite Engineer" }),
    criteria({ excluded_title_words: [".zorp"] }),
  );
  assert.equal(reasonFor(reasons, "excluded_words").verdict, "in");
});

test("excluded words: keeps a team-name word that appears only after the role part", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer, Customer Administration" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: keeps marketing as a team name after a dash without leading space", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer- Growth Performance Marketing" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: keeps a team-name word inside a parenthesis after the role part", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer (Customer & Cloud Solutions)" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: drops a non-team excluded word inside a parenthesis", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer (Developer Experience)" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "out");
});

// A leading "(Remote)" is a tag on the whole title, not the start of a
// suffix: the role part is the title entire, as before.
test("excluded words: a title opening with a parenthesis keeps its whole role part", () => {
  const result = judgeListing(posting({ title: "(Remote) Staff Customer Engineer" }), criteria());
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "out");
});

test("excluded words: keeps a team-name word after a colon in the role part", () => {
  const result = judgeListing(
    posting({ title: "Senior Software Engineer: Customer Platform", comp_high: 260000 }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: drops a team-name word before a colon in the role part", () => {
  const result = judgeListing(
    posting({ title: "Customer Success: Software Engineer" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "out");
});

test("excluded words: keeps a team-name word after an em dash in the role part", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer — Marketing Systems" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: keeps a team-name word after a pipe in the role part", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer | Support Tools" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
  assert.equal(result.kept, true);
});

test("excluded words: drops a non-team excluded word even after the role part", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer, Developer Experience" }),
    criteria(),
  );
  const excluded = reasonFor(result.reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /developer experience/);
  assert.equal(result.kept, false);
});

test("excluded words: keeps a platform role whose title merely names data", () => {
  const result = judgeListing(
    posting({ title: "Staff Software Engineer 5 - Platform Data Products" }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
});

test("excluded words: still drops a data engineer title", () => {
  const result = judgeListing(posting({ title: "Staff Data Engineer" }), criteria());
  const excluded = reasonFor(result.reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /data engineer/);
});

// "data engineer" is an exact-word match, so the gerund and plural forms
// are listed explicitly.
test("excluded words: drops a data engineering title", () => {
  const result = judgeListing(
    posting({ title: "Staff Data Engineering Platform Lead" }),
    criteria(),
  );
  const excluded = reasonFor(result.reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /data engineering/);
});

test("excluded words: drops a plural data engineers title", () => {
  const result = judgeListing(posting({ title: "Staff Data Engineers, Platform" }), criteria());
  const excluded = reasonFor(result.reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /data engineers/);
});

test("excluded words: drops a plural data scientists title", () => {
  const result = judgeListing(posting({ title: "Staff Data Scientists Lead" }), criteria());
  const excluded = reasonFor(result.reasons, "excluded_words");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /data scientists/);
});

test("comp floor: out when comp_high is present and below the floor", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: 90000 }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "comp_floor").verdict, "out");
});

test("comp floor: in when comp_high is at or above the floor", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: 120000 }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "comp_floor").verdict, "in");
});

test("comp floor: a posting with no comp band is kept", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: null }),
    criteria(),
  );
  assert.equal(reasonFor(result.reasons, "comp_floor").verdict, "in");
  assert.equal(result.kept, true);
});

// An assumed bonus that would carry a below-floor base over the line opens
// the door for the body rather than settling the posting.
test("comp floor: an assumed bonus that would reach the floor lets a below-floor base through", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: 115000 }),
    criteria({ comp_floor: 120000, assumed_bonus_pct: 12 }),
  );
  const reason = reasonFor(reasons, "comp_floor");
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    "comp_high 115000 is below the floor 120000; a bonus of 12% would reach it, so the text decides",
  );
});

test("comp floor: the same base is out with no assumed bonus percentage on file", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: 115000 }),
    criteria({ comp_floor: 120000, assumed_bonus_pct: null }),
  );
  assert.equal(reasonFor(reasons, "comp_floor").verdict, "out");
});

test("comp floor: an assumed bonus that would not reach the floor still reads out", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", comp_high: 90000 }),
    criteria({ comp_floor: 120000, assumed_bonus_pct: 5 }),
  );
  assert.equal(reasonFor(reasons, "comp_floor").verdict, "out");
});

// Every label is hand-judged; the ones marked "real label" are out of
// tests/fixtures/*.json. 17 of those 20 name a country or a US state
// outright, which is why this is judged from the listing rather than the
// body.
interface LocationCase {
  readonly location: string;
  readonly verdict: "in" | "out";
  readonly note: string;
}

const LOCATION_CASES: readonly LocationCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/location-labels.json", import.meta.url), "utf8"),
);

test("country: every hand-judged location label falls the way it was judged", () => {
  const wrong = LOCATION_CASES.filter((example) => {
    const { reasons } = judgeListing(
      posting({ title: "Staff Backend Engineer", location: example.location }),
      criteria(),
    );
    return reasonFor(reasons, "country").verdict !== example.verdict;
  });

  assert.deepEqual(
    wrong.map((example) => `${example.location} (expected ${example.verdict}: ${example.note})`),
    [],
  );
});

test("country: 16 of the 43 hand-judged labels are out", () => {
  const out = LOCATION_CASES.filter((example) => example.verdict === "out");
  assert.equal(LOCATION_CASES.length, 43);
  assert.equal(out.length, 16);
});

test("country: a posting with no location is in — the design's no-country default", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: null }),
    criteria(),
  );
  const country = reasonFor(reasons, "country");
  assert.equal(country.verdict, "in");
  assert.equal(country.detail, "posting names no location");
});

test("country: the reason quotes the country and the label that decided it", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Bengaluru, India" }),
    criteria(),
  );
  assert.equal(
    reasonFor(reasons, "country").detail,
    'location "Bengaluru, India" names "India", not the United States',
  );
});

test("country: a label naming the US as well as another country says so in its reason", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Remote US & Canada" }),
    criteria(),
  );
  assert.equal(
    reasonFor(reasons, "country").detail,
    'location "Remote US & Canada" names "Canada" but also the United States ("US")',
  );
});

test("country: a foreign label drops the posting on the listing alone, before any body fetch", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Remote - EMEA", comp_high: 300000 }),
    criteria(),
  );
  assert.equal(result.kept, false);
});

test("country: a location matching excluded_locations is out when not also a US state", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Toronto" }),
    criteria({ excluded_locations: ["Toronto"] }),
  );
  assert.equal(reasonFor(result.reasons, "country").verdict, "out");
  assert.match(reasonFor(result.reasons, "country").detail, /excluded place/);
});

test("country: a location matching excluded_locations stays in when also a US state", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Toronto, OH" }),
    criteria({ excluded_locations: ["Toronto"] }),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "in");
});

test("country: a location matching excluded_locations stays in when a US city sits in a part naming no foreign place", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "San Francisco HQ; Toronto Hub" }),
    criteria({ excluded_locations: ["Toronto"] }),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "in");
});

test("country: a US city in one part rescues a label naming a foreign place in another part", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Seattle; Vancouver, BC, Canada" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "in");
});

test("country: a city sharing its name with a US city stays out when its own part names a foreign place", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "San Francisco de Heredia, Costa Rica" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "out");
});

test("country: a US city name inside a Mexican city name stays out", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "San Francisco Coacalco, Mexico" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "out");
});

test("country: Phoenix is left out of the US city list, so a Mauritian town keeps its verdict", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", location: "Vacoas-Phoenix, Mauritius" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country").verdict, "out");
});

test("age: a posting with no max age is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", posted_at: "2026-09-01T00:00:00Z" }),
    criteria({ max_age_days: null }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(reasonFor(reasons, "age").verdict, "in");
  assert.match(reasonFor(reasons, "age").detail, /no max age/);
});

test("age: a posting with no posted date is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", posted_at: null }),
    criteria({ max_age_days: 90 }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(reasonFor(reasons, "age").verdict, "in");
  assert.match(reasonFor(reasons, "age").detail, /no posting date/);
});

test("age: posted 100 days before max 90 is out", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer", posted_at: "2026-06-09T00:00:00Z" }),
    criteria({ max_age_days: 90 }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(reasonFor(result.reasons, "age").verdict, "out");
  assert.match(reasonFor(result.reasons, "age").detail, /100 days ago/);
  assert.equal(result.kept, false);
});

test("age: posted 30 days before max 90 is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", posted_at: "2026-08-18T00:00:00Z" }),
    criteria({ max_age_days: 90 }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(reasonFor(reasons, "age").verdict, "in");
  assert.match(reasonFor(reasons, "age").detail, /30 days ago/);
});

test("age: a posting one day old reads 1 day ago, not 1 days ago", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", posted_at: "2026-09-16T00:00:00Z" }),
    criteria({ max_age_days: 90 }),
    "2026-09-17T00:00:00Z",
  );
  assert.equal(reasonFor(reasons, "age").detail, "posted 1 day ago, within the max age 90");
});

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

test("boardIndex: a watched company's boards are indexed; only a board with a last_read is in lastRead", () => {
  const index = boardIndex([
    company("Acme", {
      boards: [
        { platform: "greenhouse", id: "acme-gh", last_read: "2026-09-16T06:00:00.000Z" },
        { platform: "lever", id: "acme-lv", gone: 1 },
      ],
    }),
  ]);
  assert.deepEqual([...index.watched], ["greenhouse::acme-gh", "lever::acme-lv"]);
  assert.deepEqual([...index.lastRead], [["greenhouse::acme-gh", "2026-09-16T06:00:00.000Z"]]);
  assert.deepEqual([...index.stateOf], [["Acme", { state: "watched", alias_of: null }]]);
  assert.equal(index.dropped.size, 0);
});

test("boardIndex: an alias or discovered company's boards are in neither lastRead nor watched, but its state is on record", () => {
  const index = boardIndex([
    company("Alias", {
      state: "alias",
      boards: [{ platform: "greenhouse", id: "alias-gh", last_read: "2026-09-16T06:00:00.000Z" }],
    }),
    company("Found", {
      state: "discovered",
      boards: [{ platform: "lever", id: "found-lv", last_read: "2026-09-16T06:00:00.000Z" }],
    }),
  ]);
  assert.equal(index.watched.size, 0);
  assert.equal(index.lastRead.size, 0);
  assert.deepEqual(
    [...index.stateOf],
    [
      ["Alias", { state: "alias", alias_of: null }],
      ["Found", { state: "discovered", alias_of: null }],
    ],
  );
});

test("boardIndex: a dropped company is in dropped, and its boards are in neither lastRead nor watched", () => {
  const index = boardIndex([
    company("Gone", {
      state: "watched",
      dropped_at: "2026-09-18T17:17:00.000Z",
      boards: [{ platform: "greenhouse", id: "gone-gh", last_read: "2026-09-16T06:00:00.000Z" }],
    }),
    company("Acme", { boards: [{ platform: "lever", id: "acme-lv" }] }),
  ]);
  assert.deepEqual([...index.dropped], ["Gone"]);
  assert.deepEqual([...index.watched], ["lever::acme-lv"]);
  assert.equal(index.lastRead.size, 0);
  assert.deepEqual([...index.stateOf.keys()], ["Gone", "Acme"]);
});

test("goneBy: last seen before the board's last read is gone", () => {
  assert.equal(goneBy(posting({ last_seen: "2026-09-16T05:59:59.000Z" }), READ_ON_16TH), true);
});

test("goneBy: last seen at the board's last read is not gone", () => {
  assert.equal(goneBy(posting({ last_seen: "2026-09-16T06:00:00.000Z" }), READ_ON_16TH), false);
});

test("goneBy: a board with no last_read is never gone, however old last_seen", () => {
  const unread = boardIndex([
    company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] }),
  ]);
  assert.equal(goneBy(posting({ last_seen: "2020-01-01T00:00:00.000Z" }), unread), false);
  assert.equal(goneBy(posting({ last_seen: "2020-01-01T00:00:00.000Z" }), NO_BOARDS), false);
});

test("goneBy: a posting with no board is never gone", () => {
  assert.equal(
    goneBy(posting({ board: null, last_seen: "2020-01-01T00:00:00.000Z" }), READ_ON_16TH),
    false,
  );
});

test("goneBy: the board is matched by platform and id together", () => {
  const otherPlatform = posting({ platform: "lever", last_seen: "2020-01-01T00:00:00.000Z" });
  assert.equal(goneBy(otherPlatform, READ_ON_16TH), false);
  const otherId = posting({ board: "other", last_seen: "2020-01-01T00:00:00.000Z" });
  assert.equal(goneBy(otherId, READ_ON_16TH), false);
});

test("gone: a board with no recorded read is in, however old last_seen", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", last_seen: "2020-01-01T00:00:00.000Z" }),
    criteria(),
    "2026-09-17T00:00:00Z",
    boardIndex([company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })]),
  );
  const gone = reasonFor(reasons, "gone");
  assert.equal(gone.verdict, "in");
  assert.equal(gone.detail, "board has no recorded read");
});

test("gone: last seen before the board's last read is out and the detail names both days", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", last_seen: "2026-09-14T06:00:00.000Z" }),
    criteria(),
    "2026-09-17T00:00:00Z",
    READ_ON_16TH,
  );
  const gone = reasonFor(reasons, "gone");
  assert.equal(gone.verdict, "out");
  assert.equal(gone.detail, "last seen 2026-09-14, board read 2026-09-16 without it");
});

test("gone: last seen at the board's last read is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", last_seen: "2026-09-16T06:00:00.000Z" }),
    criteria(),
    "2026-09-17T00:00:00Z",
    READ_ON_16TH,
  );
  const gone = reasonFor(reasons, "gone");
  assert.equal(gone.verdict, "in");
  assert.equal(gone.detail, "listed at the board's last read 2026-09-16");
});

test("gone: last seen after the board's last read is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", last_seen: "2026-09-17T06:00:00.000Z" }),
    criteria(),
    "2026-09-17T00:00:00Z",
    READ_ON_16TH,
  );
  assert.equal(reasonFor(reasons, "gone").verdict, "in");
});

test("gone: a posting with no board is in", () => {
  const { reasons } = judgeListing(
    posting({
      title: "Staff Backend Engineer",
      board: null,
      last_seen: "2020-01-01T00:00:00.000Z",
    }),
    criteria(),
    "2026-09-17T00:00:00Z",
    READ_ON_16TH,
  );
  const gone = reasonFor(reasons, "gone");
  assert.equal(gone.verdict, "in");
  assert.equal(gone.detail, "board has no recorded read");
});

// Omitting the argument and passing `NO_BOARDS` read the same.
test("gone: omitting the board index defaults to no boards, reading in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", last_seen: "2020-01-01T00:00:00Z" }),
    criteria(),
  );
  const gone = reasonFor(reasons, "gone");
  assert.equal(gone.verdict, "in");
  assert.equal(gone.detail, "board has no recorded read");
});

test("unwatchedBy: a posting whose company is not on record is not unwatched", () => {
  assert.equal(unwatchedBy(posting(), NO_BOARDS), false);
});

test("unwatchedBy: an alias's posting is unwatched", () => {
  const alias = boardIndex([company("Acme", { state: "alias" })]);
  assert.equal(unwatchedBy(posting(), alias), true);
});

test("unwatchedBy: a dropped company's posting is unwatched, even on its own board", () => {
  const dropped = boardIndex([
    company("Acme", {
      dropped_at: "2026-09-18T17:17:00.000Z",
      boards: [{ platform: "greenhouse", id: "board" }],
    }),
  ]);
  assert.equal(unwatchedBy(posting(), dropped), true);
});

test("unwatchedBy: a watched company's board not on record is unwatched", () => {
  const otherBoard = boardIndex([
    company("Acme", { boards: [{ platform: "greenhouse", id: "other-board" }] }),
  ]);
  assert.equal(unwatchedBy(posting(), otherBoard), true);
});

test("unwatchedBy: a watched company's own board is not unwatched", () => {
  const ownBoard = boardIndex([
    company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] }),
  ]);
  assert.equal(unwatchedBy(posting(), ownBoard), false);
});

test("unwatchedBy: a posting with no board is never unwatched, whatever the company's state", () => {
  const alias = boardIndex([company("Acme", { state: "alias" })]);
  assert.equal(unwatchedBy(posting({ board: null }), alias), false);
});

test("unwatched: a company not on record is in", () => {
  const { reasons } = judgeListing(posting({ title: "Staff Backend Engineer" }), criteria());
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "in");
  assert.equal(unwatched.detail, "company not on record");
});

test("unwatched: an alias is out, naming it", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer" }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { state: "alias", alias_of: "Acme Inc" })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "out");
  assert.equal(unwatched.detail, "company Acme is an alias of Acme Inc");
});

test("unwatched: a dropped company is out, naming it, whatever its state", () => {
  for (const state of ["watched", "discovered"] as const) {
    const { reasons } = judgeListing(
      posting({ title: "Staff Backend Engineer" }),
      criteria(),
      undefined,
      boardIndex([
        company("Acme", {
          state,
          dropped_at: "2026-09-18T17:17:00.000Z",
          boards: [{ platform: "greenhouse", id: "board" }],
        }),
      ]),
    );
    const unwatched = reasonFor(reasons, "unwatched");
    assert.equal(unwatched.verdict, "out");
    assert.equal(unwatched.detail, "company Acme is dropped");
  }
});

test("unwatched: an alias with no owner on record is out, saying so", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer" }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { state: "alias" })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "out");
  assert.equal(unwatched.detail, "company Acme is an alias of another company");
});

test("unwatched: a company returned to discovered is out, naming it", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer" }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { state: "discovered" })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "out");
  assert.equal(unwatched.detail, "company Acme returned to discovered");
});

test("unwatched: a watched company whose boards do not include this one is out, naming the board", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer" }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { boards: [{ platform: "greenhouse", id: "other-board" }] })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "out");
  assert.equal(unwatched.detail, "board greenhouse/board is no longer on Acme");
});

test("unwatched: a watched company whose boards include this one is in", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer" }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { boards: [{ platform: "greenhouse", id: "board" }] })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "in");
  assert.equal(unwatched.detail, "board greenhouse/board is watched");
});

test("unwatched: a posting with no board is in, however its company stands", () => {
  const { reasons } = judgeListing(
    posting({ title: "Staff Backend Engineer", board: null }),
    criteria(),
    undefined,
    boardIndex([company("Acme", { state: "alias" })]),
  );
  const unwatched = reasonFor(reasons, "unwatched");
  assert.equal(unwatched.verdict, "in");
  assert.equal(unwatched.detail, "posting names no board");
});

test("an empty excluded_title_words list matches nothing, not everything", () => {
  const result = judgeListing(
    posting({ title: "Staff Backend Engineer Recruiter" }),
    criteria({ excluded_title_words: [] }),
  );
  assert.equal(reasonFor(result.reasons, "excluded_words").verdict, "in");
});

// Pragmatike's real shape.
function duplicatePosting(overrides: Partial<Posting> = {}): Posting {
  return posting({
    platform: "ashby",
    board: "pragmatike",
    posted_at: "2026-08-14",
    comp_high: 400000,
    location: "San Francisco",
    ...overrides,
  });
}

test("duplicate key: titles differing only by a level word share a key", () => {
  const staffFounding = duplicatePosting({ key: "a::1", title: "Staff Founding Product Engineer" });
  const lead = duplicatePosting({ key: "a::2", title: "Lead Product Engineer" });
  assert.equal(duplicateKey(staffFounding, criteria()), duplicateKey(lead, criteria()));
});

test("duplicate key: titles differing by more than a level word do not share a key", () => {
  const payments = duplicatePosting({ key: "a::1", title: "Senior Software Engineer, Payments" });
  const billing = duplicatePosting({ key: "a::2", title: "Senior Software Engineer, Billing" });
  assert.notEqual(duplicateKey(payments, criteria()), duplicateKey(billing, criteria()));
});

// No parenthetical strip: Northwind alone carries 476 rows where it names
// the team ("(Online Storage)"), and stripping it merged different teams'
// reqs into one key.
test("duplicate key: titles differing by a parenthetical naming different teams do not share a key", () => {
  const onlineStorage = duplicatePosting({
    key: "a::1",
    title: "Staff Software Engineer, Backend (Online Storage)",
  });
  const orderPlatform = duplicatePosting({
    key: "a::2",
    title: "Staff Software Engineer, Backend (Order Platform)",
  });
  assert.notEqual(duplicateKey(onlineStorage, criteria()), duplicateKey(orderPlatform, criteria()));
});

test("duplicate key: a different location breaks the key", () => {
  const sanFrancisco = duplicatePosting({ key: "a::1", title: "Staff Product Engineer" });
  const remote = duplicatePosting({
    key: "a::2",
    title: "Staff Product Engineer",
    location: "Remote",
  });
  assert.notEqual(duplicateKey(sanFrancisco, criteria()), duplicateKey(remote, criteria()));
});

test("duplicate key: a different band breaks the key", () => {
  const highBand = duplicatePosting({ key: "a::1", title: "Staff Product Engineer" });
  const lowBand = duplicatePosting({
    key: "a::2",
    title: "Staff Product Engineer",
    comp_high: 300000,
  });
  assert.notEqual(duplicateKey(highBand, criteria()), duplicateKey(lowBand, criteria()));
});

test("duplicate key: two postings with no band share a key", () => {
  const noBand1 = duplicatePosting({
    key: "a::1",
    title: "Staff Software Engineer",
    comp_high: null,
  });
  const noBand2 = duplicatePosting({
    key: "a::2",
    title: "Staff Software Engineer",
    comp_high: null,
  });
  assert.equal(duplicateKey(noBand1, criteria()), duplicateKey(noBand2, criteria()));
});

test("duplicate key: no band and a band do not share a key", () => {
  const noBand = duplicatePosting({
    key: "a::1",
    title: "Staff Software Engineer",
    comp_high: null,
  });
  const withBand = duplicatePosting({
    key: "a::2",
    title: "Staff Software Engineer",
    comp_high: 250000,
  });
  assert.notEqual(duplicateKey(noBand, criteria()), duplicateKey(withBand, criteria()));
});

test("duplicate key: a different posted date breaks the key", () => {
  const day1 = duplicatePosting({ key: "a::1", title: "Staff Product Engineer" });
  const day2 = duplicatePosting({
    key: "a::2",
    title: "Staff Product Engineer",
    posted_at: "2026-08-15",
  });
  assert.notEqual(duplicateKey(day1, criteria()), duplicateKey(day2, criteria()));
});

test("duplicate key: two postings with no posted_at never share a key", () => {
  const first = duplicatePosting({ key: "a::1", title: "Staff Product Engineer", posted_at: null });
  const second = duplicatePosting({
    key: "a::2",
    title: "Staff Product Engineer",
    posted_at: null,
  });
  assert.notEqual(duplicateKey(first, criteria()), duplicateKey(second, criteria()));
});

test("duplicate key: two postings with no title never share a key", () => {
  const first = duplicatePosting({ key: "a::1", title: null });
  const second = duplicatePosting({ key: "a::2", title: null });
  assert.notEqual(duplicateKey(first, criteria()), duplicateKey(second, criteria()));
});

test("duplicate: the non-representative row is out naming the representative; the representative is in", () => {
  const representativeRow = duplicatePosting({ key: "a::1", title: "Staff Product Engineer" });
  const other = duplicatePosting({ key: "a::2", title: "Lead Product Engineer" });
  const representative = new Map([
    [duplicateKey(representativeRow, criteria()), representativeRow.key],
  ]);

  const otherReason = reasonFor(
    judgeListing(other, criteria(), undefined, NO_BOARDS, representative).reasons,
    "duplicate",
  );
  assert.equal(otherReason.verdict, "out");
  assert.equal(
    otherReason.detail,
    "duplicate of a::1: same board, date, band and place, title differs only by level words; that posting is the latest the level criterion admits",
  );

  const representativeReason = reasonFor(
    judgeListing(representativeRow, criteria(), undefined, NO_BOARDS, representative).reasons,
    "duplicate",
  );
  assert.equal(representativeReason.verdict, "in");
});

test("duplicate: a posting with no posted_at is never marked a duplicate of a same-titled dated posting", () => {
  const dated = duplicatePosting({ key: "a::1", title: "Staff Product Engineer" });
  const undated = duplicatePosting({
    key: "a::2",
    title: "Staff Product Engineer",
    posted_at: null,
  });
  const representative = new Map([[duplicateKey(dated, criteria()), dated.key]]);
  const result = judgeListing(undated, criteria(), undefined, NO_BOARDS, representative);
  assert.equal(reasonFor(result.reasons, "duplicate").verdict, "in");
});

test("duplicate: an empty representative map reads in, same default as no duplicates known", () => {
  const { reasons } = judgeListing(
    duplicatePosting({ key: "a::1", title: "Staff Product Engineer" }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "duplicate").verdict, "in");
});
