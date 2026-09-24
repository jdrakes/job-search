import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseRipplingListing, parseRipplingDetail, ripplingReader } from "../src/ats/rippling.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// rippling-listing.json holds five entries over three uuids on a synthetic
// board (api.rippling.com/platform/api/ats/v1/board/northgate-careers/jobs),
// shaped like a Rippling board answer and chosen to include a "Remote ("
// label, a "Hybrid (" label and a bare-city label. The "Electrical Engineer"
// uuid (7d2e5a91-...) appears three times, on-site "Boulder, CO" then
// "Hybrid (Boulder, Colorado, US)" then "Remote (Austin, TX, US)", so it
// exercises the rule that remote workplace designation is chosen even when
// not the first listed location.
// rippling-detail.json is the detail for uuid
// 3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58. It carries one heading and one
// paragraph per description section, omits fields the parser never reads
// (activeJobApplication, board, jsonLd, ...), and states payRangeDetails in
// USD by YEAR (118000-142000) so the stated-range path is covered.
// `workLocations` puts "Hybrid (Washington, DC, US)" before
// "Remote (Washington, DC, US)" so the remote-wins-over-first rule is
// exercised here too.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("Rippling: a listing entry carries no body, comp or postedAt, and maps id/title/url/location/workplace", () => {
  const listings = parseRipplingListing(fixture("rippling-listing.json"));
  // Five records, three distinct uuids: one row per posting, not per
  // location; remote workplace is chosen from multiple location entries.
  assert.equal(listings.length, 3);
  for (const listing of listings) {
    assert.equal(listing.body, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    // Ruling 1: the listing states no date.
    assert.equal(listing.postedAt, null);
  }

  const remote = listings.find((listing) => listing.id === "3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58");
  assert.ok(remote);
  // The name carries a trailing space, as Rippling answers do; it is trimmed.
  assert.equal(remote?.title, "Assistant Program Coordinator");
  assert.equal(
    remote?.url,
    "https://ats.rippling.com/northgate-careers/jobs/3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58",
  );
  assert.equal(remote?.location, "Remote (Washington, District of Columbia, US)");
  assert.equal(remote?.workplace, "remote");

  // Three entries for this uuid: on-site, hybrid, then remote. The remote
  // one wins even though it is neither first nor last.
  const threeEntry = listings.find(
    (listing) => listing.id === "7d2e5a91-3f68-4c0a-b917-2e84f6a1d3c7",
  );
  assert.ok(threeEntry);
  assert.equal(threeEntry?.title, "Electrical Engineer");
  assert.equal(threeEntry?.location, "Remote (Austin, TX, US)");
  assert.equal(threeEntry?.workplace, "remote");

  const onsite = listings.find((listing) => listing.id === "b4c8f102-6e39-4a75-9d1c-8f52a70b4e63");
  assert.ok(onsite);
  assert.equal(onsite?.title, "Field Systems Test Engineer");
  assert.equal(onsite?.location, "Reno, NV");
  // A bare city states neither "Remote (" nor "Hybrid (": no workplace.
  assert.equal(onsite?.workplace, null);
});

test("Rippling: a single-entry listing with a hybrid label records hybrid as workplace", () => {
  const listings = parseRipplingListing([
    {
      uuid: "hybrid-only-uuid",
      name: "Hybrid Only Role",
      url: "https://ats.rippling.com/example/jobs/hybrid-only-uuid",
      workLocation: { label: "Hybrid (Denver, CO, US)" },
    },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.location, "Hybrid (Denver, CO, US)");
  assert.equal(listings[0]?.workplace, "hybrid");
});

test("Rippling: a multi-entry listing with on-site first and hybrid second, no remote, records the on-site label and null workplace", () => {
  const listings = parseRipplingListing([
    {
      uuid: "onsite-hybrid-uuid",
      name: "Test Role",
      url: "https://ats.rippling.com/example/jobs/onsite-hybrid-uuid",
      workLocation: { label: "Livermore, CA" },
    },
    {
      uuid: "onsite-hybrid-uuid",
      name: "Test Role",
      url: "https://ats.rippling.com/example/jobs/onsite-hybrid-uuid",
      workLocation: { label: "Hybrid (Livermore, California, US)" },
    },
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.location, "Livermore, CA");
  assert.equal(listings[0]?.workplace, null);
});

test("Rippling: a listing answer that is an object, not an array, parses to no postings", () => {
  const listings = parseRipplingListing({ error_code: "RESOURCE_NOT_FOUND", message: "not found" });
  assert.deepEqual(listings, []);
});

test("Rippling: a detail response's body is text, not HTML, joining company and role", () => {
  const listing = parseRipplingDetail(fixture("rippling-detail.json"));
  assert.ok(listing.body !== null);
  assert.ok(!listing.body?.includes("<p>"));
  assert.ok(listing.body?.includes("About Northgate Robotics"));
  assert.ok(listing.body?.includes("Assistant Program Coordinator"));
});

test("Rippling: a detail's stated USD-year payRangeDetails is the comp", () => {
  const listing = parseRipplingDetail(fixture("rippling-detail.json"));
  assert.equal(listing.title, "Assistant Program Coordinator");
  assert.equal(listing.compLow, 118_000);
  assert.equal(listing.compHigh, 142_000);
  // Ruling 1: createdOn is present in the fixture but not read.
  assert.equal(listing.postedAt, null);
  // workLocations is ["Hybrid (...)", "Remote (...)"]: the remote entry
  // wins even though the hybrid one is first, following the rule that
  // remote is chosen when present among multiple workplace options.
  assert.equal(listing.location, "Remote (Washington, DC, US)");
  assert.equal(listing.workplace, "remote");
});

test("Rippling: a detail with no workLocations records null location and workplace", () => {
  const raw = fixture("rippling-detail.json") as Record<string, unknown>;
  const listing = parseRipplingDetail({ ...raw, workLocations: [] });
  assert.equal(listing.location, null);
  assert.equal(listing.workplace, null);
});

test("Rippling: a detail whose only range is hourly falls back to compInText, null when the body states no $ figure", () => {
  const raw = fixture("rippling-detail.json") as Record<string, unknown>;
  const hourly = {
    ...raw,
    payRangeDetails: [
      {
        location: "Hybrid (Washington, DC, US)",
        currency: "USD",
        frequency: "HOUR",
        rangeStart: 60,
        rangeEnd: 80,
      },
    ],
  };
  const listing = parseRipplingDetail(hourly);
  // The body states no dollar figure, so compInText finds nothing either.
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test("Rippling: list hits the board's jobs URL, body hits the per-id URL", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/jobs/3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58")) {
      return new Response(JSON.stringify(fixture("rippling-detail.json")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/jobs")) {
      return new Response(JSON.stringify(fixture("rippling-listing.json")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };
  // http.ts requires a configured User-Agent now that it no longer carries a
  // built-in one (src/net/http.ts); this test fakes the network entirely,
  // so any value satisfies it.
  const options = {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  };
  const board = { platform: "rippling" as const, id: "northgate-careers" };

  const listings = await ripplingReader.list(board, options);
  assert.equal(listings.length, 3);

  const detail = await ripplingReader.body?.(
    board,
    "3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58",
    options,
  );
  assert.equal(detail?.compLow, 118_000);

  assert.deepEqual(requested, [
    "https://api.rippling.com/platform/api/ats/v1/board/northgate-careers/jobs",
    "https://api.rippling.com/platform/api/ats/v1/board/northgate-careers/jobs/3f61a8d2-9c47-4e15-8b02-6a1f4d7e9c58",
  ]);
});
