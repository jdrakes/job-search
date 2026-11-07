import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePhenomData,
  parsePhenomDetail,
  parsePhenomSearch,
  phenomReader,
} from "../src/ats/phenom.ts";

// Written from two live sites' pages on 2026-11-07: the field names are
// Phenom's, while the employer, ids and titles are invented.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

function page(data: unknown): string {
  return `<html><script>phApp.ddo = ${JSON.stringify(data)}; phApp.experience = "x";</script></html>`;
}

function search(jobs: unknown[], totalHits: number): string {
  return page({ eagerLoadRefineSearch: { totalHits, hits: jobs.length, data: { jobs } } });
}

const JOB = {
  jobId: "101",
  reqId: "101",
  title: "Program Manager, Quality",
  location: "Austin, TX, 78701",
  multi_location: ["Austin, TX, 78701", "Round Rock, TX, 78664"],
  postedDate: "2026-11-05T00:12:29.000+0000",
  psRemoteStatus: "ORA_ON_SITE",
  salaryPayRange: "$83,090.04 - $115,822.45",
};

test("parsePhenomData: reads the object and stops at its own closing brace", () => {
  const data = parsePhenomData(page({ a: "} not the end", b: { c: 1 } }));
  assert.deepEqual(data, { a: "} not the end", b: { c: 1 } });
});

// Breaks if a site that changed its shape reads as an empty board, which
// would mark every posting on it gone.
test("parsePhenomData: a page with no data throws", () => {
  assert.throws(() => parsePhenomData("<html></html>"), /no phApp\.ddo/);
});

test("parsePhenomSearch: each field, every place, the workplace, no text", () => {
  const { listings, total } = parsePhenomSearch(
    search([JOB, { title: "No id" }], 2338),
    "jobs.example.org",
  );
  assert.equal(total, 2338);
  assert.equal(listings.length, 1);
  const [listing] = listings;
  assert.equal(listing?.id, "101");
  assert.equal(listing?.url, "https://jobs.example.org/us/en/job/101");
  assert.equal(listing?.location, "Austin, TX, 78701; Round Rock, TX, 78664");
  assert.equal(listing?.workplace, "onsite");
  assert.equal(listing?.body, null);
  assert.equal(listing?.compHigh, 115822);
  assert.equal(listing?.postedAt?.slice(0, 10), "2026-11-05");
});

test("parsePhenomSearch: no remote status and no pay read as unknown", () => {
  const { listings } = parsePhenomSearch(
    search([{ jobId: "1", title: "Project Manager", location: "Dallas, Texas, United States" }], 1),
    "jobs.example.org",
  );
  assert.equal(listings[0]?.workplace, null);
  assert.equal(listings[0]?.compHigh, null);
  assert.equal(listings[0]?.location, "Dallas, Texas, United States");
});

test("parsePhenomDetail: the text, and the pay band over one in the prose", () => {
  const html = page({
    jobDetail: {
      data: {
        job: { ...JOB, description: "<p>Lead programs. Pay is $1,000 - $2,000.</p>" },
      },
    },
  });
  const listing = parsePhenomDetail(html, "jobs.example.org", "101");
  assert.match(listing?.body ?? "", /Lead programs/);
  assert.equal(listing?.compHigh, 115822);
});

test("parsePhenomDetail: null for a posting the page no longer has", () => {
  assert.equal(parsePhenomDetail(page({ jobDetail: { data: {} } }), "jobs.example.org", "9"), null);
});

test("phenomReader: walks every page once, stopping at the total", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    const from = Number(new URL(url).searchParams.get("from"));
    const jobs = from === 0 ? [JOB] : [{ ...JOB, jobId: "102" }];
    return new Response(search(jobs, 15), { status: 200 });
  };
  const listings = await phenomReader.list(
    { platform: "phenom", id: "jobs.example.org" },
    { fetchImpl, sleep: async () => {}, userAgent: TEST_USER_AGENT },
  );
  assert.deepEqual(
    listings.map((listing) => listing.id),
    ["101", "102"],
  );
  assert.equal(requests.length, 2);
});
