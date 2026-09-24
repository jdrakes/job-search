import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseBreezyListing, parseBreezyDetail, breezyReader } from "../src/ats/breezy.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Both fixtures are written from Breezy's schemas and never captured; each
// carries its own header comment saying which shape each entry proves.
// Every id, URL, date and sentence in them is invented. The listing holds
// one entry per live shape checked: `is_remote: true` with the place name
// "Worldwide", `is_remote: true` with a city name instead (proving
// `location` and `workplace` are read independently), `is_remote: false`,
// and `is_remote` absent entirely. The two boards the shapes were first
// seen on were folded into one, because nothing in the parser reads the
// tenant.
function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function fixtureHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("Breezy: a listing maps id/title/url/postedAt, carries no comp/body", () => {
  const listings = parseBreezyListing(fixtureJson("breezy-listing.json"));
  assert.equal(listings.length, 4);
  for (const listing of listings) {
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.body, null);
  }

  const securityLead = listings.find((listing) => listing.id === "0a1b2c3d4e5f01");
  assert.ok(securityLead);
  assert.equal(securityLead?.title, "Staff Application Security Engineer");
  assert.equal(
    securityLead?.url,
    "https://consolidatedmessenger.breezy.hr/p/0a1b2c3d4e5f01-staff-application-security-engineer",
  );
  assert.equal(securityLead?.location, "Worldwide");
  assert.equal(securityLead?.postedAt, "2026-07-30");
  assert.equal(securityLead?.workplace, "remote");
});

test("Breezy: workplace reads location.is_remote, independently of the place name - a remote posting can still state a real city", () => {
  const listings = parseBreezyListing(fixtureJson("breezy-listing.json"));

  // is_remote: true, name: "Thessaloniki, GR" - not "Worldwide". A rule
  // that inferred remote from the place name alone would miss this.
  const vulnResearcher = listings.find((listing) => listing.id === "1b2c3d4e5f6a02");
  assert.equal(vulnResearcher?.location, "Thessaloniki, GR");
  assert.equal(vulnResearcher?.workplace, "remote");

  // is_remote: false.
  const salesSpecialist = listings.find((listing) => listing.id === "2c3d4e5f6a7b03");
  assert.equal(salesSpecialist?.location, "Athens, GR");
  assert.equal(salesSpecialist?.workplace, null);

  // is_remote absent entirely, with a published_date years old - the
  // listing's date is read whatever its age.
  const salesRep = listings.find((listing) => listing.id === "3d4e5f6a7b8c04");
  assert.equal(salesRep?.location, "Lisbon, PT");
  assert.equal(salesRep?.workplace, null);
  assert.equal(salesRep?.postedAt, "2019-09-23");
});

test("Breezy: a detail reads title/location/workplace/body from the JobPosting ld+json block, picked by @type rather than position", () => {
  const listing = parseBreezyDetail(fixtureHtml("breezy-detail.html"), "0a1b2c3d4e5f01");
  assert.equal(listing.id, "0a1b2c3d4e5f01");
  assert.equal(listing.title, "Staff Application Security Engineer");
  // jobLocation.address.addressCountry, verbatim - lower-cased "worldwide"
  // exactly as the live JSON-LD states it, not the listing's "Worldwide".
  assert.equal(listing.location, "worldwide");
  assert.equal(listing.workplace, "remote");
  assert.ok(listing.body?.includes("About Consolidated Messenger"));
  assert.ok(listing.body?.includes("Minimum Qualifications"));
  assert.ok(!listing.body?.includes("<h1>"));
});

test("Breezy: a detail's url drops Breezy's own ?source=GoogleJobs query", () => {
  const listing = parseBreezyDetail(fixtureHtml("breezy-detail.html"), "0a1b2c3d4e5f01");
  assert.equal(
    listing.url,
    "https://consolidatedmessenger.breezy.hr/p/0a1b2c3d4e5f01-staff-application-security-engineer",
  );
});

test("Breezy: a detail's postedAt is never read from datePosted, even though the fixture states one - the listing's date is the only one ever kept", () => {
  const listing = parseBreezyDetail(fixtureHtml("breezy-detail.html"), "0a1b2c3d4e5f01");
  // The fixture's raw JSON-LD states "2023-11-20" (see the fixture's own
  // header comment); a reader that read it would fail this assertion.
  assert.equal(listing.postedAt, null);
});

test("Breezy: a detail with no baseSalary field falls to compInText over the description text, which states no range, so comp is null", () => {
  const listing = parseBreezyDetail(fixtureHtml("breezy-detail.html"), "0a1b2c3d4e5f01");
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test("Breezy: compInText does fire on a detail body that states a dollar range", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"JobPosting","title":"Edited","description":"Pay: $120,000 - $150,000 a year.","url":"https://example.breezy.hr/p/x"}</script></head><body></body></html>`;
  const listing = parseBreezyDetail(html, "x");
  assert.equal(listing.compLow, 120_000);
  assert.equal(listing.compHigh, 150_000);
});

test("Breezy: a detail with no JobPosting-typed ld+json block (only the WebSite one, or none at all) reads every field null/empty, never throws", () => {
  const websiteOnly = `<html><head><script type="application/ld+json">{"@type":"WebSite","name":"Breezy HR"}</script></head><body></body></html>`;
  const listing = parseBreezyDetail(websiteOnly, "fallback-id");
  assert.equal(listing.id, "fallback-id");
  assert.equal(listing.title, null);
  assert.equal(listing.url, null);
  assert.equal(listing.location, null);
  assert.equal(listing.body, null);
  assert.equal(listing.workplace, null);
  assert.equal(listing.postedAt, null);

  const none = parseBreezyDetail("<html><head></head><body></body></html>", "fallback-id");
  assert.equal(none.title, null);

  const malformed = parseBreezyDetail(
    `<html><head><script type="application/ld+json">not json</script></head></html>`,
    "fallback-id",
  );
  assert.equal(malformed.title, null);
});

test("Breezy: jobLocationType TELECOMMUTE reads remote; any other value reads null", () => {
  const remote = `<html><head><script type="application/ld+json">{"@type":"JobPosting","jobLocationType":"TELECOMMUTE"}</script></head></html>`;
  assert.equal(parseBreezyDetail(remote, "x").workplace, "remote");

  const onsite = `<html><head><script type="application/ld+json">{"@type":"JobPosting"}</script></head></html>`;
  assert.equal(parseBreezyDetail(onsite, "x").workplace, null);
});

test("Breezy: list hits the board's /json endpoint, body hits the board's /p/${id} page", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://consolidatedmessenger.breezy.hr/json") {
      return new Response(JSON.stringify(fixtureJson("breezy-listing.json")), { status: 200 });
    }
    if (url === "https://consolidatedmessenger.breezy.hr/p/0a1b2c3d4e5f01") {
      return new Response(fixtureHtml("breezy-detail.html"), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "breezy" as const, id: "consolidatedmessenger" };

  const listings = await breezyReader.list(board, options);
  assert.equal(listings.length, 4);

  const detail = await breezyReader.body?.(board, "0a1b2c3d4e5f01", options);
  assert.equal(detail?.title, "Staff Application Security Engineer");
  // The list phase's own postedAt (2026-07-30) is what ends up stored;
  // ingest.ts never reads a two-phase detail's postedAt for any platform,
  // and this reader additionally never states one on the detail either.
  assert.equal(detail?.postedAt, null);

  assert.deepEqual(requested, [
    "https://consolidatedmessenger.breezy.hr/json",
    "https://consolidatedmessenger.breezy.hr/p/0a1b2c3d4e5f01",
  ]);
});
