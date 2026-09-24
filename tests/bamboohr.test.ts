import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseBambooHrListing, parseBambooHrDetail, bambooHrReader } from "../src/ats/bamboohr.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Both fixtures are written from BambooHR's own board schemas and never
// captured; every id, title, place and sentence in them is invented and Best
// For You Organics is not a real employer. The listing keeps two rows, which
// is one per shape it has to prove - the `atsLocation` join and BambooHR's
// own "All" placeholder city, which every posting on the live board checked
// stated rather than leaving city null. The detail is the same posting 32,
// keeping the fields the parser reads (description, compensation,
// datePosted, jobOpeningName, jobOpeningShareUrl, atsLocation, location) and
// dropping the lengthy, unread `formFields` block the live response carries.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("BambooHR: a listing maps id/title/location for every row, carries no comp/postedAt/body/url", () => {
  const listings = parseBambooHrListing(fixture("bamboohr-listing.json"));
  assert.equal(listings.length, 2);
  for (const listing of listings) {
    assert.equal(listing.url, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.postedAt, null);
    assert.equal(listing.body, null);
    assert.equal(listing.workplace, null);
    // Every row states city "All" (BambooHR's own placeholder, dropped)
    // and state/country Wisconsin/United States, which is the state a whole
    // live board was found in, not a parser shortcut.
    assert.equal(listing.location, "Wisconsin, United States");
  }

  const byId = new Map(listings.map((listing) => [listing.id, listing]));
  assert.equal(byId.get("32")?.title, "Delivery Driver/Heavy Equipment Transporter");
  assert.equal(byId.get("35")?.title, "Packhouse Line Lead");
});

test("BambooHR: atsLocation's placeholder city ('All') is dropped, not read as a place", () => {
  const listings = parseBambooHrListing(fixture("bamboohr-listing.json"));
  const raw = fixture("bamboohr-listing.json") as { result: Array<{ atsLocation: unknown }> };
  assert.equal((raw.result[0]?.atsLocation as { city: string }).city, "All");
  assert.ok(!listings[0]?.location?.includes("All"));
});

test("BambooHR: when atsLocation states nothing usable, location falls back to location.city/.state", () => {
  // No live posting checked exercises this path - every row on the board
  // checked states a usable atsLocation. Edited: atsLocation's fields
  // blanked out, location given a city/state, per the field mapping
  // table's stated fallback.
  const raw = fixture("bamboohr-listing.json") as { result: Array<Record<string, unknown>> };
  const edited = {
    ...raw.result[0],
    atsLocation: { city: null, state: null, province: null, country: null },
    location: { city: "Athens", state: "Wisconsin" },
  };
  const [listing] = parseBambooHrListing({ result: [edited] });
  assert.equal(listing?.location, "Athens, Wisconsin");
});

test("BambooHR: a detail maps title/url/location/postedAt from posting 32", () => {
  const listing = parseBambooHrDetail(fixture("bamboohr-detail.json"));
  assert.equal(listing.title, "Delivery Driver/Heavy Equipment Transporter");
  assert.equal(listing.url, "https://bestforyou.bamboohr.com/careers/32");
  assert.equal(listing.location, "Wisconsin, United States");
  assert.equal(listing.postedAt, "2025-01-02");
  assert.ok(listing.body?.includes("Roles and Responsibilities"));
  assert.ok(!listing.body?.includes("<p>"));
});

test("BambooHR: compensation folds into body as a sentence but states no structured comp (two-digit figures never clear compInText's four-digit minimum)", () => {
  const listing = parseBambooHrDetail(fixture("bamboohr-detail.json"));
  assert.ok(listing.body?.includes("Compensation: $30.00 -$70.00."));
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test("BambooHR: a body edited to carry a four-digit dollar range still matches via compInText", () => {
  const raw = fixture("bamboohr-detail.json") as {
    result: { jobOpening: Record<string, unknown> };
  };
  const edited = {
    result: {
      jobOpening: { ...raw.result.jobOpening, compensation: "$3,000 - $5,000" },
    },
  };
  const listing = parseBambooHrDetail(edited);
  assert.equal(listing.compLow, 3_000);
  assert.equal(listing.compHigh, 5_000);
});

test("BambooHR: a detail's own jobOpening states no id; parseBambooHrDetail reads it empty and the caller (body) fills it in", () => {
  const listing = parseBambooHrDetail(fixture("bamboohr-detail.json"));
  assert.equal(listing.id, "");
});

test("BambooHR: result.jobOpening: null and an absent/malformed result array both read empty, never throw", () => {
  assert.deepEqual(parseBambooHrListing({ meta: {}, result: null }), []);
  assert.deepEqual(parseBambooHrListing({}), []);

  const listing = parseBambooHrDetail({ meta: {}, result: { jobOpening: null } });
  assert.equal(listing.title, null);
  assert.equal(listing.url, null);
  assert.equal(listing.location, null);
  assert.equal(listing.compLow, null);
  assert.equal(listing.postedAt, null);
  assert.equal(listing.body, null);

  const noResult = parseBambooHrDetail({});
  assert.equal(noResult.title, null);
});

test("BambooHR: list hits the board's careers/list endpoint and fills each row's url; body hits the detail endpoint and fills the id", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/careers/list")) {
      return new Response(JSON.stringify(fixture("bamboohr-listing.json")), { status: 200 });
    }
    if (url.endsWith("/careers/32/detail")) {
      return new Response(JSON.stringify(fixture("bamboohr-detail.json")), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "bamboohr" as const, id: "bestforyou" };

  const listings = await bambooHrReader.list(board, options);
  assert.equal(listings.length, 2);
  assert.equal(
    listings.find((listing) => listing.id === "32")?.url,
    "https://bestforyou.bamboohr.com/careers/32",
  );

  const detail = await bambooHrReader.body?.(board, "32", options);
  assert.equal(detail?.id, "32");
  assert.equal(detail?.title, "Delivery Driver/Heavy Equipment Transporter");

  assert.deepEqual(requested, [
    "https://bestforyou.bamboohr.com/careers/list",
    "https://bestforyou.bamboohr.com/careers/32/detail",
  ]);
});
