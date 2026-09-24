import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  parseHrmdirectListing,
  parseHrmdirectDetail,
  hrmdirectReader,
} from "../src/ats/hrmdirect.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Both fixtures are written from HRMDirect's markup schema and never
// captured; each carries its own header comment saying which shape each row
// or block proves. Every req, req_loc, title, place and sentence in them is
// invented, and the board id ("gdinstitute") deliberately disagrees with the
// tenant's display name, which is a live shape.
function fixtureHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("HRMDirect listing: ids carry req_loc, one row states a location, comp/postedAt/body/workplace all null", () => {
  const listings = parseHrmdirectListing(fixtureHtml("hrmdirect-listing.html"), "gdinstitute");
  assert.equal(listings.length, 3);

  const senior = listings.find((listing) => listing.id === "4410001:1500101");
  assert.ok(senior);
  assert.equal(senior?.title, "Senior Account Executive, Corporate Partnerships");
  assert.equal(
    senior?.url,
    "https://gdinstitute.hrmdirect.com/employment/job-opening.php?req=4410001&req_loc=1500101&&#job",
  );
  assert.equal(senior?.location, "Springfield, IL");

  const manager = listings.find((listing) => listing.id === "4410002:1500202");
  assert.ok(manager);
  assert.equal(manager?.title, "Senior Manager, Partnership Marketing");
  assert.equal(manager?.location, null);

  for (const listing of listings) {
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.postedAt, null);
    assert.equal(listing.body, null);
    assert.equal(listing.workplace, null);
  }
});

test("HRMDirect listing: every row's id is its req and req_loc joined with a colon, carried for the detail phase", () => {
  const listings = parseHrmdirectListing(fixtureHtml("hrmdirect-listing.html"), "gdinstitute");
  const ids = listings.map((listing) => listing.id).sort();
  assert.deepEqual(ids, ["4410001:1500101", "4410002:1500202", "4410003:1500303"]);
});

test("HRMDirect listing: a trailing title space trims, and a page with no reqitem rows reads []", () => {
  const listings = parseHrmdirectListing(fixtureHtml("hrmdirect-listing.html"), "gdinstitute");
  const coordinator = listings.find((listing) => listing.id === "4410003:1500303");
  assert.equal(coordinator?.title, "Programme Manager, Media Accreditation");

  assert.deepEqual(
    parseHrmdirectListing("<html><body>no rows here</body></html>", "gdinstitute"),
    [],
  );
});

test("HRMDirect detail: title from <h2>, location from the Location-labelled field, Department left unread", () => {
  const listing = parseHrmdirectDetail(fixtureHtml("hrmdirect-detail.html"), "4410001:1500101");
  assert.equal(listing.id, "4410001:1500101");
  assert.equal(listing.title, "Senior Account Executive, Corporate Partnerships");
  assert.equal(listing.location, "Springfield, IL");
  assert.equal(listing.postedAt, null);
  assert.equal(listing.workplace, null);
  assert.equal(listing.url, null);
});

test('HRMDirect detail: the "$70,000.00 to $90,000.00" salary sentence matches compInText; a non-pay "$2.5M" portfolio mention nearby does not', () => {
  const listing = parseHrmdirectDetail(fixtureHtml("hrmdirect-detail.html"), "4410001:1500101");
  assert.ok(listing.body?.includes("$2.5M"));
  assert.ok(listing.body?.includes("$70,000.00 to $90,000.00"));
  assert.equal(listing.compLow, 70_000);
  assert.equal(listing.compHigh, 90_000);
});

test("HRMDirect detail: an empty viewFieldValue (a live shape on rows with no listing-side location either) reads location null, not an empty string", () => {
  // Not the shape hrmdirect-detail.html carries (that posting states a
  // Location) - a minimal detail page built to
  // prove the empty-value case, the same way jazzhr.test.ts builds small
  // snippets for shapes its one fixture doesn't carry.
  const html = `<html><body>
    <h2>Some Other Posting</h2>
    <table class="viewFields">
      <tr>	<td class="viewFieldName"><b>Location:</b></td>
      <td class="viewFieldValue"><br></td></tr>
      <tr>	<td class="viewFieldName"><b>Department:</b></td>
      <td class="viewFieldValue">Ops<br></td></tr>
    </table>
    <div class="jobDesc"><p>No pay stated.</p></div>
  </body></html>`;
  const listing = parseHrmdirectDetail(html, "1:2");
  assert.equal(listing.title, "Some Other Posting");
  assert.equal(listing.location, null);
  assert.equal(listing.compLow, null);
});

test("HRMDirect detail: a mismatched req_loc answers an empty <h2></h2> (confirmed live) - title reads null, not empty string", () => {
  // Confirmed live 2026-09-22 against one board: the same
  // `req` fetched with a wrong `req_loc` still answers HTTP 200, with an
  // empty heading and every field blank, rather than an error this reader
  // could otherwise see and treat as gone.
  const html = `<html><body>
    <h2></h2>
    <table class="viewFields">
      <tr>	<td class="viewFieldName"><b>Location:</b></td>
      <td class="viewFieldValue"><br></td></tr>
    </table>
    <div class="jobDesc"></div>
  </body></html>`;
  const listing = parseHrmdirectDetail(html, "4410001:999999");
  assert.equal(listing.title, null);
  assert.equal(listing.location, null);
  assert.equal(listing.body, null);
});

test("HRMDirect: list hits the board's job-openings endpoint; body carries req_loc from the listing id, not a reconstructed one", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("job-openings.php")) {
      return new Response(fixtureHtml("hrmdirect-listing.html"), { status: 200 });
    }
    if (url.includes("job-opening.php?req=4410001&req_loc=1500101")) {
      return new Response(fixtureHtml("hrmdirect-detail.html"), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "hrmdirect" as const, id: "gdinstitute" };

  const listings = await hrmdirectReader.list(board, options);
  assert.equal(listings.length, 3);

  const detail = await hrmdirectReader.body?.(board, "4410001:1500101", options);
  assert.equal(detail?.id, "4410001:1500101");
  assert.equal(detail?.title, "Senior Account Executive, Corporate Partnerships");
  assert.equal(
    detail?.url,
    "https://gdinstitute.hrmdirect.com/employment/job-opening.php?req=4410001&req_loc=1500101",
  );

  assert.deepEqual(requested, [
    "https://gdinstitute.hrmdirect.com/employment/job-openings.php?search=true",
    "https://gdinstitute.hrmdirect.com/employment/job-opening.php?req=4410001&req_loc=1500101",
  ]);
});

test("HRMDirect: body given an id with no colon (no req_loc carried) still requests a URL, req_loc left empty, no throw", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixtureHtml("hrmdirect-detail.html"), { status: 200 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "hrmdirect" as const, id: "gdinstitute" };

  const detail = await hrmdirectReader.body?.(board, "4410001", options);
  assert.equal(detail?.id, "4410001");
  assert.deepEqual(requested, [
    "https://gdinstitute.hrmdirect.com/employment/job-opening.php?req=4410001&req_loc=",
  ]);
});
