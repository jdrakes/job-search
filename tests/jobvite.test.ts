import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  parseJobviteListing,
  parseJobviteDetail,
  showMoreUrls,
  jobviteReader,
} from "../src/ats/jobvite.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// The first three fixtures are written from Jobvite's schemas and never captured;
// each carries its own header comment saying which shape it proves. Every
// id, title, place and sentence in them is invented, and neither Margie's
// Travel nor Lamna Healthcare is a real employer. jobvite-detail-comp.json
// states a numeric baseSalary (155000-175000 USD/Annually) and a bare-string
// hiringOrganization; jobvite-detail.json states all three of
// currency/minValue/maxValue as "" (read as absent, which is the live shape
// on most boards) and an object hiringOrganization, and its body goes on to
// state "$80k - $110k base + $40k VC", which is what compInText finds once
// the structured path is refused.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function fixtureHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("Jobvite: a listing row maps id/title/url/location, carries no comp/postedAt/body", () => {
  const listings = parseJobviteListing(fixtureHtml("jobvite-listing.html"), "margiestravel");
  assert.equal(listings.length, 5);
  for (const listing of listings) {
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.postedAt, null);
    assert.equal(listing.body, null);
  }

  const clientRelations = listings.find((listing) => listing.id === "oaB1CfwD");
  assert.ok(clientRelations);
  assert.equal(clientRelations?.title, "Client Relations Manager");
  assert.equal(clientRelations?.url, "https://jobs.jobvite.com/margiestravel/job/oaB1CfwD");
  assert.equal(clientRelations?.location, "Springfield, Illinois");
  assert.equal(clientRelations?.workplace, null);
});

test('Jobvite: a jv-meta-only row ("N Locations", no place name) reads location null, not the caption text', () => {
  const listings = parseJobviteListing(fixtureHtml("jobvite-listing.html"), "margiestravel");
  const seniorAnalyst = listings.find((listing) => listing.id === "oDh2Zfw7");
  assert.ok(seniorAnalyst);
  assert.equal(seniorAnalyst?.title, "Senior Business Analyst, Commercial Economics");
  assert.equal(seniorAnalyst?.location, null);
  assert.equal(seniorAnalyst?.workplace, null);
});

test("Jobvite: a country-only row's location is the bare country", () => {
  const listings = parseJobviteListing(fixtureHtml("jobvite-listing.html"), "margiestravel");
  const nationalMarketing = listings.find((listing) => listing.id === "orG3Zfwd");
  assert.equal(nationalMarketing?.location, "United States");
});

test("Jobvite: workplace is a prefix check on location, catching both live remote shapes and refusing everything else", () => {
  const listings = parseJobviteListing(fixtureHtml("jobvite-listing.html"), "margiestravel");

  // The clean shape: a "Remote" segment then a place chain.
  const payroll = listings.find((listing) => listing.id === "o3E4Afwh");
  assert.equal(payroll?.location, "Remote, Setiabudi, Kota Jakarta Selatan, DKI Jakarta");
  assert.equal(payroll?.workplace, "remote");

  // The jv-meta-stripped "N Locations" shape: a bare trailing comma,
  // "Remote,". An exact-match rule ("location === 'Remote'") would fail
  // this case even though it fails the clean case too - neither live
  // remote row ever reduces to the bare word "Remote".
  const engineer = listings.find((listing) => listing.id === "orH5AfwW");
  assert.equal(engineer?.location, "Remote,");
  assert.equal(engineer?.workplace, "remote");

  // Every non-remote row in the fixture stays null.
  const nonRemote = listings.filter(
    (listing) => listing.id !== "o3E4Afwh" && listing.id !== "orH5AfwW",
  );
  for (const listing of nonRemote) {
    assert.equal(listing.workplace, null);
  }
});

test("Jobvite: a detail's structured USD/Annually baseSalary wins as the comp (155000-175000)", () => {
  const listing = parseJobviteDetail(fixture("jobvite-detail-comp.json"), "fallback-id");
  assert.equal(listing.id, "oyX6Afwc");
  assert.equal(listing.title, "Senior Scientist I, Assay Development");
  assert.equal(listing.location, "Fairhaven, Oregon");
  assert.equal(listing.compLow, 155_000);
  assert.equal(listing.compHigh, 175_000);
  assert.equal(listing.postedAt, "2026-06-19");
  // No jobLocationType on this posting.
  assert.equal(listing.workplace, null);
  assert.ok(listing.body?.includes("Who You Are"));
  assert.ok(!listing.body?.includes("<div>"));
});

test('Jobvite: a detail with no structured baseSalary (all fields "") falls to compInText over the body text', () => {
  const listing = parseJobviteDetail(fixture("jobvite-detail.json"), "fallback-id");
  assert.equal(listing.id, "oaB1CfwD");
  assert.equal(listing.title, "Client Relations Manager");
  assert.equal(listing.location, "Springfield, Illinois");
  // This posting's baseSalary states "" for currency/minValue/maxValue, so
  // the structured path is refused; the body goes on to state
  // "$80k - $110k base + $40k VC", which compInText (ats.ts) does match.
  assert.equal(listing.compLow, 80_000);
  assert.equal(listing.compHigh, 110_000);
  assert.equal(listing.postedAt, "2026-08-18");
});

test("Jobvite: a baseSalary stated in a non-USD currency is not read as structured comp, even with numeric min/max", () => {
  const raw = fixture("jobvite-detail.json") as Record<string, unknown>;
  const cad = {
    ...raw,
    baseSalary: {
      currency: "CAD",
      value: { minValue: "100000", maxValue: "120000", unitText: "Annually" },
    },
  };
  const listing = parseJobviteDetail(cad, "fallback-id");
  // Falls through to compInText the same as the unedited fixture.
  assert.equal(listing.compLow, 80_000);
  assert.equal(listing.compHigh, 110_000);
});

test("Jobvite: hiringOrganization's bare-string shape and object shape parse identically, since the field feeds no Listing property", () => {
  const raw = fixture("jobvite-detail-comp.json") as Record<string, unknown>;
  assert.equal(typeof raw["hiringOrganization"], "string");
  const bareString = parseJobviteDetail(raw, "fallback-id");
  const asObject = parseJobviteDetail(
    { ...raw, hiringOrganization: { name: raw["hiringOrganization"] } },
    "fallback-id",
  );
  assert.deepEqual(bareString, asObject);
});

test("Jobvite: jobLocationType TELECOMMUTE reads remote; absent (the real shape on both fixtures) reads null", () => {
  const raw = fixture("jobvite-detail-comp.json") as Record<string, unknown>;
  // Confirmed live on one board's remote postings.
  const telecommute = parseJobviteDetail({ ...raw, jobLocationType: "TELECOMMUTE" }, "fallback-id");
  assert.equal(telecommute.workplace, "remote");
  assert.equal(parseJobviteDetail(raw, "fallback-id").workplace, null);
});

test("Jobvite: a detail with no stated identifier falls back to the caller's id", () => {
  const raw = fixture("jobvite-detail-comp.json") as Record<string, unknown>;
  const noIdentifier = { ...raw };
  delete noIdentifier["identifier"];
  const listing = parseJobviteDetail(noIdentifier, "caller-supplied-id");
  assert.equal(listing.id, "caller-supplied-id");
});

test("Jobvite: list hits the board's jobs page, body hits the job page and fills in the request URL", async () => {
  const requested: string[] = [];
  const detailHtml = `<html><body><script type="application/ld+json">${JSON.stringify(
    fixture("jobvite-detail-comp.json"),
  )}</script></body></html>`;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/lamnahealthcare/jobs")) {
      return new Response(fixtureHtml("jobvite-listing.html"), { status: 200 });
    }
    if (url.endsWith("/lamnahealthcare/job/oyX6Afwc")) {
      return new Response(detailHtml, { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "jobvite" as const, id: "lamnahealthcare" };

  const listings = await jobviteReader.list(board, options);
  assert.equal(listings.length, 5);

  const detail = await jobviteReader.body?.(board, "oyX6Afwc", options);
  assert.equal(detail?.title, "Senior Scientist I, Assay Development");
  assert.equal(detail?.compLow, 155_000);
  assert.equal(detail?.url, "https://jobs.jobvite.com/lamnahealthcare/job/oyX6Afwc");

  assert.deepEqual(requested, [
    "https://jobs.jobvite.com/lamnahealthcare/jobs",
    "https://jobs.jobvite.com/lamnahealthcare/job/oyX6Afwc",
  ]);
});

const NINJA_SEARCH_URL =
  "https://jobs.jobvite.com/ninjaone/search?c=Engineering+%26+Quality+Assurance&p=0";

function fakeNinjaFetch(requested: string[], searchStatus = 200): typeof fetch {
  return async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/ninjaone/jobs")) {
      return new Response(fixtureHtml("jobvite-truncated.html"), { status: 200 });
    }
    if (url === NINJA_SEARCH_URL) {
      return new Response(fixtureHtml("jobvite-search.html"), { status: searchStatus });
    }
    return new Response("", { status: 404 });
  };
}

test("Jobvite: showMoreUrls finds each Show More link, in either label case, and none on a page without one", () => {
  assert.deepEqual(showMoreUrls(fixtureHtml("jobvite-truncated.html"), "ninjaone"), [
    NINJA_SEARCH_URL,
  ]);
  const lowercase = '<a href="/varonis/search?c=Sales&amp;p=0">\n<strong>Show more</strong>\n</a>';
  assert.deepEqual(showMoreUrls(lowercase, "varonis"), [
    "https://jobs.jobvite.com/varonis/search?c=Sales&p=0",
  ]);
  assert.deepEqual(showMoreUrls(fixtureHtml("jobvite-listing.html"), "margiestravel"), []);
});

test("Jobvite: list follows Show More and returns the union, each job once, listing rows first", async () => {
  const requested: string[] = [];
  const options = {
    fetchImpl: fakeNinjaFetch(requested),
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  };
  const listings = await jobviteReader.list({ platform: "jobvite", id: "ninjaone" }, options);
  assert.deepEqual(
    listings.map((listing) => listing.id),
    ["oDNPAfwz", "oA8TAfwV", "oRLRAfwN", "oU7zAfwU"],
  );
  assert.equal(listings[3]?.title, "Senior Software Engineer, Technical Lead");
  assert.deepEqual(requested, ["https://jobs.jobvite.com/ninjaone/jobs", NINJA_SEARCH_URL]);
});

test("Jobvite: a failed Show More fetch throws rather than returning a partial board", async () => {
  const options = {
    fetchImpl: fakeNinjaFetch([], 404),
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  };
  await assert.rejects(jobviteReader.list({ platform: "jobvite", id: "ninjaone" }, options));
});

test("Jobvite: a listing with no Show More link is read from its one page alone", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixtureHtml("jobvite-listing.html"), { status: 200 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const listings = await jobviteReader.list({ platform: "jobvite", id: "margiestravel" }, options);
  assert.equal(listings.length, 5);
  assert.deepEqual(requested, ["https://jobs.jobvite.com/margiestravel/jobs"]);
});

test("Jobvite: a row tag carrying attributes (zones renders an onclick) is still a row", () => {
  const html = `<tr onclick="location.href = '/zones/job/ot8zAfwu'">
    <td class="jv-job-list-name"><a href="/zones/job/ot8zAfwu">Project Manager 1</a></td>
    <td class="jv-job-list-location">Islamabad,</td>
  </tr>`;
  const listings = parseJobviteListing(html, "zones");
  assert.deepEqual(
    listings.map((listing) => [listing.id, listing.title]),
    [["ot8zAfwu", "Project Manager 1"]],
  );
});

// Four layouts beyond the `<tr>` table. Each fixture is written from the
// layout's markup (see its header) with invented rows; the expected values
// below are written by hand from those rows.
function idsTitlesLocations(file: string): string[][] {
  return parseJobviteListing(fixtureHtml(file), "margiestravel").map((listing) => [
    listing.id,
    listing.title ?? "",
    listing.location ?? "null",
  ]);
}

test("Jobvite: the card layout (title div holds the link) parses, and an N-Locations-only cell reads null", () => {
  assert.deepEqual(idsTitlesLocations("jobvite-enverus.html"), [
    ["oAAAAfw1", "Staff Software Developer - 1001", "Springfield, Illinois"],
    ["oBBBBfw2", "Billing Specialist I - 1002", "null"],
  ]);
});

test("Jobvite: the list layout takes the id from the wrapping link (query dropped) and the place from the last span", () => {
  assert.deepEqual(idsTitlesLocations("jobvite-varonis.html"), [
    ["oCCCCfw3", "Detection and Response Engineer", "Springfield, Illinois"],
    ["oDDDDfw4", "Procurement Buyer", "Remote, United States"],
  ]);
});

test("Jobvite: featured blocks wrapped in their own link each take their own id, and list rows keep theirs", () => {
  assert.deepEqual(idsTitlesLocations("jobvite-laborie.html"), [
    ["oEEEEfw5", "Senior Cost Accountant", "Springfield, Illinois"],
    ["oFFFFfw6", "Regional Sales Director", "null"],
    ["oGGGGfw7", "Clinical Project Manager", "Maple Grove, MN"],
    ["oEEEEfw5", "Senior Cost Accountant", "Springfield, Illinois"],
  ]);
});

test("Jobvite: featured blocks with the link after the title, and table rows with an icon in the link and a department cell", () => {
  assert.deepEqual(idsTitlesLocations("jobvite-ziffdavis.html"), [
    ["oHHHHfw8", "Associate Director, Scientific Affairs", "Remote - Florida"],
    ["oIIIIfw9", "Account Director", "null"],
    ["oJJJJfwA", "Financial Accountant", "Helsinki, Finland"],
    ["oHHHHfw8", "Associate Director, Scientific Affairs", "Remote - Florida"],
  ]);
});

test("Jobvite: the Show More link is found when it sits in a bare table cell, in either label case", () => {
  const expected = ["https://jobs.jobvite.com/margiestravel/search?c=Sales&p=0"];
  assert.deepEqual(showMoreUrls(fixtureHtml("jobvite-varonis.html"), "margiestravel"), expected);
  assert.deepEqual(showMoreUrls(fixtureHtml("jobvite-ziffdavis.html"), "margiestravel"), expected);
});

// Breaks if the fallback for a title with no link inside reaches back past
// the row it sits in: the second row would take the first row's id and the
// merge would drop it.
test("Jobvite: a bare title cell takes the link in its own row's later cell, not the previous row's", () => {
  const html = `<table class="jv-job-list">
    <tr><td class="jv-job-list-name">Payroll Analyst</td><td><a href="/margiestravel/job/oKKKKfwB">Apply</a></td></tr>
    <tr><td class="jv-job-list-name">Travel Agent</td><td><a href="/margiestravel/job/oLLLLfwC">Apply</a></td></tr>
  </table>`;
  assert.deepEqual(
    parseJobviteListing(html, "margiestravel").map((listing) => [listing.id, listing.title]),
    [
      ["oKKKKfwB", "Payroll Analyst"],
      ["oLLLLfwC", "Travel Agent"],
    ],
  );
});
