import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clearcompanyReader,
  parseClearcompanyListing,
  parseClearcompanySiteId,
} from "../src/ats/clearcompany.ts";
import { probe } from "../src/discovery/probe.ts";
import { judgeText } from "../src/judge/text.ts";
import type { Criteria } from "../src/schema.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";
const noSleep = async () => {};

// Both fixtures are captured from live boards on 2026-10-22. The page is
// `apply.clearcompany.com/escalent` whole. The listing is that board's API
// response cut to three of its 21 results (null-typed annual pay and
// remote; "Per Year" pay in one office; "0" pay) plus one result from
// another board's response, because no Escalent job states "Per Hour".
// Each description is cut to its opening paragraphs and each
// `customFieldAnswers` to one entry, to stay under the fixture size
// ceiling; nothing else is changed. The abroad fixture is two more results
// from the same board, captured 2026-10-23: an India job with null-typed
// pay in rupees and a London job with "Per Year" pay in pounds. It is a
// file of its own because the listing fixture has no room under the
// ceiling; each description is cut to its first paragraph and each
// `customFieldAnswers` to none.
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const SITE_ID = "a0345de9-4458-c1d6-a1e2-5568e8f86f13";

test("ClearCompany site id: read from the board page's widget script", () => {
  assert.equal(parseClearcompanySiteId(fixture("clearcompany-page.html")), SITE_ID);
});

test("ClearCompany site id: a page without one reads as null", () => {
  assert.equal(parseClearcompanySiteId("<title>Careers</title>"), null);
});

function listings() {
  return parseClearcompanyListing(JSON.parse(fixture("clearcompany-listing.json")));
}

test("ClearCompany listing: a remote US job with null-typed annual pay", () => {
  const job = listings()[0];
  assert.deepEqual(
    { ...job, body: null },
    {
      id: "8cbc38f3-f46f-b442-2e34-cd83dcb69aa0",
      title: "Insights Director, Consumer/Telecom - Remote (PT/MT zone preferred)",
      url: "https://escalent.clearcompany.com/careers/jobs/8cbc38f3-f46f-b442-2e34-cd83dcb69aa0/apply",
      location: "Remote (US)",
      compLow: 95000,
      compHigh: 150000,
      postedAt: "2026-10-08",
      body: null,
      workplace: "remote",
      requisitionId: null,
    },
  );
  assert.ok(job?.body?.startsWith("Who We Are\nEscalent is an award-winning data analytics"));
});

test("ClearCompany listing: an office job keeps its place and its Per Year pay", () => {
  const job = listings()[1];
  assert.equal(job?.location, "Boston MA");
  assert.equal(job?.workplace, null);
  assert.equal(job?.compLow, 50000);
  assert.equal(job?.compHigh, 58500);
});

test("ClearCompany listing: salary '0' reads as no pay, and the title is trimmed", () => {
  const job = listings()[2];
  assert.equal(job?.title, "Consultant");
  assert.equal(job?.compLow, null);
  assert.equal(job?.compHigh, null);
});

test("ClearCompany listing: Per Hour pay is dropped", () => {
  const job = listings()[3];
  assert.equal(job?.title, "Q.A. Inspector");
  assert.equal(job?.compLow, null);
  assert.equal(job?.compHigh, null);
});

// Breaks if the US-only rule is dropped: the API states no currency, so the
// India band would read as $2.4M and the London band as $90K.
test("ClearCompany listing: pay is dropped for a job outside the US", () => {
  const [india, london] = parseClearcompanyListing(JSON.parse(fixture("clearcompany-abroad.json")));
  assert.equal(india?.title, "Qualtrics Dashboard Specialist");
  assert.equal(india?.compLow, null);
  assert.equal(india?.compHigh, null);
  assert.equal(london?.title, "Qualitative Insight Associate (LATAM Markets)");
  assert.equal(london?.compLow, null);
  assert.equal(london?.compHigh, null);
});

// Breaks if the reader goes back to writing a bare "Remote".
test("ClearCompany listing: a remote job abroad keeps its stated country", () => {
  const [india] = parseClearcompanyListing(JSON.parse(fixture("clearcompany-abroad.json")));
  assert.equal(india?.location, "Remote (IN)");
  assert.equal(india?.workplace, "remote");
});

test("ClearCompany listing: a job with no places states no pay", () => {
  const [result] = parseClearcompanyListing({
    results: [{ id: "x", salaryRangeLow: "95000", salaryRangeHigh: "150000", locations: [] }],
  });
  assert.equal(result?.compLow, null);
  assert.equal(result?.compHigh, null);
});

function criteriaStub(): Criteria {
  return {
    id: 1,
    level_words: [],
    role_words: [],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: [],
    missing_languages: [],
    comp_floor: 120000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-10-23T00:00:00Z",
    full_read_at: "2026-10-23T00:00:00Z",
  };
}

// Breaks if the judge stops reading "Remote (US)" as remote, which would
// leave a remote ClearCompany job relying on its workplace label alone.
test("ClearCompany listing: the judge reads a stated 'Remote (US)' as remote", () => {
  const job = listings()[0];
  const { reasons } = judgeText(
    { body: "", location: job?.location ?? null, comp_high: null, workplace: null },
    criteriaStub(),
  );
  const remote = reasons.find((reason) => reason.criterion === "remote");
  assert.equal(remote?.verdict, "in");
  assert.equal(remote?.detail, 'location affirms remote: "Remote (US)"');
});

test("ClearCompany listing: a non-array results reads as no postings", () => {
  assert.deepEqual(parseClearcompanyListing({ results: null }), []);
  assert.deepEqual(parseClearcompanyListing("not json"), []);
});

test("ClearCompany list: reads the page, then the API for the site it names", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://apply.clearcompany.com/escalent") {
      return new Response(fixture("clearcompany-page.html"), { status: 200 });
    }
    if (url === `https://careers-api.clearcompany.com/v1/${SITE_ID}`) {
      return new Response(fixture("clearcompany-listing.json"), { status: 200 });
    }
    return new Response(null, { status: 404 });
  };

  const result = await clearcompanyReader.list(
    { platform: "clearcompany", id: "escalent" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
  );

  assert.equal(result.length, 4);
  assert.deepEqual(requested, [
    "https://apply.clearcompany.com/escalent",
    `https://careers-api.clearcompany.com/v1/${SITE_ID}`,
  ]);
});

test("ClearCompany list: a page naming no site throws rather than reading as empty", async () => {
  const fetchImpl: typeof fetch = async () => new Response("<title>Careers</title>");

  await assert.rejects(
    clearcompanyReader.list(
      { platform: "clearcompany", id: "escalent" },
      { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ),
    /the page names no ClearCompany site/,
  );
});

test("ClearCompany probe: the name comes from the entity-encoded page title", async () => {
  const fetchImpl: typeof fetch = async (input) =>
    String(input) === "https://apply.clearcompany.com/escalent"
      ? new Response(fixture("clearcompany-page.html"), { status: 200 })
      : new Response(null, { status: 404 });

  const { boards } = await probe(
    "Escalent",
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ["clearcompany"],
  );

  assert.deepEqual(boards, [{ platform: "clearcompany", id: "escalent" }]);
});
