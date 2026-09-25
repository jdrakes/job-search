import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseIcimsListing, icimsReader } from "../src/ats/icims.ts";
import { MAX_PAGES } from "../src/ats/ats.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Both fixtures are written from the iCIMS job-search API's schema and never
// captured; every tenant, req_id, address and sentence in them is invented.
// They are two files because the two tenant shapes seen live disagree on
// which keys exist at all, and a key-membership difference cannot be carried
// by one document.
//
// icims-listing-remote.json is the shape a fully-remote posting takes:
// `location_type: "ANY"`, a top-level `client_code` alongside the
// `meta_data` one, `salary_value`/`salary_min_value`/`salary_max_value`
// present and `0`, and a compensation paragraph whose currency word sits
// after the dash ("USD $160,200.00 - USD $425,000.00"), which is the shape
// `compInText` refuses.
function fixtureRemote(): unknown {
  return JSON.parse(
    readFileSync(new URL("./fixtures/icims-listing-remote.json", import.meta.url), "utf8"),
  );
}

// icims-listing-onsite.json is the other shape: `location_type: "LAT_LNG"`,
// no top-level `client_code` at all, no `qualifications` key at all, and no
// `salary_value`/`salary_min_value`/`salary_max_value` keys at all - a
// key-membership difference, not a zero value. Its first posting's
// `meta_data.canonical_url` states a host that is not the tenant's, which
// is the live misconfiguration that stops `canonical_url` being trusted.
function fixtureOnsite(): unknown {
  return JSON.parse(
    readFileSync(new URL("./fixtures/icims-listing-onsite.json", import.meta.url), "utf8"),
  );
}

test("iCIMS: a remote posting maps title, location, postedAt and workplace", () => {
  const listings = parseIcimsListing(fixtureRemote());
  assert.equal(listings.length, 1);
  const listing = listings[0];
  assert.equal(listing.id, "6120");
  assert.equal(listing.title, "Principal Engineering Manager, Agent Platform");
  assert.equal(listing.location, "United States");
  assert.equal(listing.postedAt, "2026-09-22");
  assert.equal(listing.workplace, "remote");
});

test("iCIMS: url is built from meta_data.client_code, not canonical_url or apply_url", () => {
  const listing = parseIcimsListing(fixtureRemote())[0];
  assert.equal(listing.url, "https://firstup.jibeapply.com/jobs/6120");

  // The fixture's own stated apply_url, for contrast: it points at the
  // applicant login flow, and is never what `url` reads.
  const raw = fixtureRemote() as { jobs: Array<{ data: Record<string, unknown> }> };
  const job = raw.jobs[0].data;
  assert.equal(job["apply_url"], "https://careers-firstup.icims.com/jobs/6120/login");
  assert.notEqual(listing.url, job["apply_url"]);
});

test("iCIMS: a canonical_url pointing at a host that is not the tenant's is never read", () => {
  const raw = fixtureOnsite() as { jobs: Array<{ data: Record<string, unknown> }> };
  const job = raw.jobs.find((entry) => entry.data["req_id"] === "480101")?.data;
  assert.ok(job);
  const metaData = job?.["meta_data"] as Record<string, unknown>;
  // The shape a live tenant's own iCIMS config was found in: a canonical
  // URL on somebody else's host entirely.
  assert.equal(metaData["canonical_url"], "https://careers.example.org/jobs/480101?lang=en-us");

  const listing = parseIcimsListing(fixtureOnsite()).find((entry) => entry.id === "480101");
  assert.equal(listing?.url, "https://munsons.jibeapply.com/jobs/480101");
});

test("iCIMS: onsite postings map location and workplace", () => {
  const listings = parseIcimsListing(fixtureOnsite());
  assert.equal(listings.length, 2);

  const perishables = listings.find((listing) => listing.id === "480101");
  assert.equal(perishables?.title, "Riverbend 37 (Mill Rd) Market - Perishables Rep - Part time");
  assert.equal(perishables?.location, "Riverbend, Kansas");
  assert.equal(perishables?.postedAt, "2026-09-21");
  assert.equal(perishables?.workplace, "onsite");
  assert.equal(perishables?.url, "https://munsons.jibeapply.com/jobs/480101");

  const stocker = listings.find((listing) => listing.id === "480102");
  assert.equal(stocker?.location, "Fairhaven, Oregon");
  assert.equal(stocker?.workplace, "onsite");
});

test("iCIMS: 0-valued salary fields never produce structured comp", () => {
  const raw = fixtureRemote() as { jobs: Array<{ data: Record<string, unknown> }> };
  const job = raw.jobs[0].data;
  // Present as keys and 0, not absent.
  assert.equal(job["salary_value"], 0);
  assert.equal(job["salary_min_value"], 0);
  assert.equal(job["salary_max_value"], 0);

  const listing = parseIcimsListing(fixtureRemote())[0];
  // iCIMS has no structured comp; its comp comes entirely from prose.
  // The fixture's prose states the range as "USD $160,200.00 - USD $425,000.00"
  // (a currency word before each dollar sign), which compInText reads.
  assert.equal(listing.compLow, 160_200);
  assert.equal(listing.compHigh, 425_000);
});

test("iCIMS: absent salary keys never produce structured comp", () => {
  const raw = fixtureOnsite() as { jobs: Array<{ data: Record<string, unknown> }> };
  const job = raw.jobs.find((entry) => entry.data["req_id"] === "480101")?.data;
  assert.ok(job);
  // The key is missing entirely, not present-and-null.
  assert.equal("salary_value" in (job as Record<string, unknown>), false);
  assert.equal("salary_min_value" in (job as Record<string, unknown>), false);
  assert.equal("salary_max_value" in (job as Record<string, unknown>), false);

  const listings = parseIcimsListing(fixtureOnsite());
  for (const listing of listings) {
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
  }
});

test("iCIMS: qualifications is genuinely absent on the onsite tenant, not just empty, and body still joins description/responsibilities", () => {
  const raw = fixtureOnsite() as { jobs: Array<{ data: Record<string, unknown> }> };
  const job = raw.jobs[0].data;
  assert.equal("qualifications" in job, false);

  const listing = parseIcimsListing(fixtureOnsite())[0];
  assert.ok(listing.body !== null && listing.body.length > 0);
  assert.ok(listing.body?.includes("Perishable Representative"));
  assert.ok(listing.body?.includes("Pull and face the chilled cases"));
});

test("iCIMS: list requests limit/page against the tenant host, and a short page stops the walk", async () => {
  const requested: string[] = [];
  function page(entries: unknown[]): Response {
    return new Response(
      JSON.stringify({ jobs: entries, totalCount: entries.length, count: entries.length }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  function entry(id: number): unknown {
    return {
      data: {
        req_id: String(id),
        title: `Job ${id}`,
        meta_data: { client_code: "acme" },
        full_location: null,
        posted_date: null,
        description: "",
        location_type: null,
      },
    };
  }

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const pageNumber = Number(new URL(url).searchParams.get("page"));
    // Two full 100-entry pages, then a 40-entry final page.
    if (pageNumber === 1) return page(Array.from({ length: 100 }, (_, i) => entry(i)));
    if (pageNumber === 2) return page(Array.from({ length: 100 }, (_, i) => entry(100 + i)));
    if (pageNumber === 3) return page(Array.from({ length: 40 }, (_, i) => entry(200 + i)));
    throw new Error(`unexpected page requested: ${pageNumber}`);
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "icims" as const, id: "acme" };

  const listings = await icimsReader.list(board, options);
  assert.equal(listings.length, 240);
  assert.deepEqual(requested, [
    "https://acme.jibeapply.com/api/jobs?limit=100&page=1",
    "https://acme.jibeapply.com/api/jobs?limit=100&page=2",
    "https://acme.jibeapply.com/api/jobs?limit=100&page=3",
  ]);
});

test("iCIMS: a board that never returns a short page stops at MAX_PAGES", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls > MAX_PAGES + 1) throw new Error(`unbounded paging: ${calls} requests`);
    const entries = Array.from({ length: 100 }, (_, i) => ({
      data: { req_id: String(calls * 1000 + i), title: "Job", meta_data: {} },
    }));
    return new Response(JSON.stringify({ jobs: entries, totalCount: 999_999, count: 999_999 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "icims" as const, id: "endless" };

  const listings = await icimsReader.list(board, options);
  assert.equal(calls, MAX_PAGES);
  assert.equal(listings.length, MAX_PAGES * 100);
});

test("iCIMS: an absent jobs array or malformed payload reads as an empty list, not a throw", () => {
  assert.deepEqual(parseIcimsListing({}), []);
  assert.deepEqual(parseIcimsListing(null), []);
  assert.deepEqual(parseIcimsListing({ jobs: "not an array" }), []);
  assert.deepEqual(parseIcimsListing({ jobs: [{ data: {} }] }).length, 1);
});
