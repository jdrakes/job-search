import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseAvatureListing, parseAvatureDetail, avatureReader } from "../src/ats/avature.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// All three fixtures are written from Avature's markup schema, not captured
// from a board, and every company, id and place in them is invented. Avature
// is skinned per tenant, so the two detail fixtures deliberately disagree on
// every field the reader touches: avature-detail.html labels its location
// "Location" and writes its description as nested <div>s, while
// avature-detail-alt.html labels it "Location(s)", hangs an extra utility
// class on the field wrapper, and writes its description as <p>/<font>
// markup. Each fixture's own header comment says which shape each block is
// there to prove.
function fixtureHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("Avature: a listing maps id/title/url for every row, carries no location/comp/postedAt/body/workplace", () => {
  const listings = parseAvatureListing(fixtureHtml("avature-listing.html"), "fourthcoffee");
  assert.equal(listings.length, 5);
  for (const listing of listings) {
    assert.equal(listing.location, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.postedAt, null);
    assert.equal(listing.body, null);
    assert.equal(listing.workplace, null);
  }

  // Row one's anchor text is spread over three lines and its href is
  // absolute, so this reads through both the whitespace collapse and the
  // absolute-href case.
  const staffEngineer = listings.find((listing) => listing.id === "40101");
  assert.equal(staffEngineer?.title, "Staff Platform Engineer - Remote - Contract");
  assert.equal(
    staffEngineer?.url,
    "https://fourthcoffee.avature.net/careers/JobDetail/Staff-Platform-Engineer/40101",
  );

  // A title carrying a literal, un-escaped "&" (the shape live markup uses,
  // not entity-encoded) reads through untouched.
  const securityAnalyst = listings.find((listing) => listing.id === "40102");
  assert.equal(securityAnalyst?.title, "Senior Security Operations & Forensics Analyst");
  // ...and its href is relative, so the board slug supplies the origin.
  assert.equal(
    securityAnalyst?.url,
    "https://fourthcoffee.avature.net/careers/JobDetail/Senior-Security-Operations/40102",
  );
});

test("Avature: the id is the href's trailing digits, the slug segment before it ignored, and the footer's Apply anchor never counts as a second row", () => {
  const listings = parseAvatureListing(fixtureHtml("avature-listing.html"), "fourthcoffee");
  const ids = listings.map((listing) => listing.id).sort();
  // Rows one and two repeat their href in a footer Apply anchor; five ids,
  // each once, is what says the title class is what the regex anchors on.
  assert.deepEqual(ids, ["40101", "40102", "40113", "40124", "40150"].sort());
});

test("Avature: a detail's location comes from the field__value paired with a field__label starting 'Location', case-insensitively - a bare 'Location' and a tenant's 'Location(s)' both match", () => {
  const detail = parseAvatureDetail(fixtureHtml("avature-detail.html"), "40101");
  assert.equal(detail.location, "Springfield");

  const alternate = parseAvatureDetail(fixtureHtml("avature-detail-alt.html"), "770412");
  assert.equal(alternate.location, "Riverbend, Kansas");
});

test("Avature: a detail's title comes from og:title, not the field data", () => {
  const detail = parseAvatureDetail(fixtureHtml("avature-detail.html"), "40101");
  assert.equal(detail.title, "Staff Platform Engineer - Remote - Contract");

  const alternate = parseAvatureDetail(fixtureHtml("avature-detail-alt.html"), "770412");
  assert.equal(alternate.title, "Grid Maintenance Planner");
});

test("Avature: body joins every field__value block (labelled fields and the unlabelled description alike), htmlToText'd, other labels' text never mistaken for location", () => {
  const detail = parseAvatureDetail(fixtureHtml("avature-detail.html"), "40101");
  // A sentence from a nested <div> deep inside the description block - only
  // reachable if the field__value scanner's nested-div balancing found the
  // real matching close, not the first `</div>` it saw.
  assert.ok(detail.body?.includes("owning a service end to end"));
  // The trailing closer block, itself a *third*, separately unlabelled
  // field__value block after the description - proves every value block is
  // joined, not just the first one found.
  assert.ok(detail.body?.includes("quarterly engineering newsletter"));
  // Business Area's value is folded into body text like every other field,
  // but never read as the location.
  assert.ok(detail.body?.includes("Platform Engineering"));
  assert.equal(detail.location, "Springfield");
  assert.ok(!detail.body?.includes("<div>"));

  const alternate = parseAvatureDetail(fixtureHtml("avature-detail-alt.html"), "770412");
  assert.ok(alternate.body?.includes("City Power and Light"));
  assert.ok(alternate.body?.includes("Equal Opportunity Employer"));
});

test("Avature: dollar-ish figures short of a four-digit range never clear compInText, so comp reads null", () => {
  // The first states "Salary Range = 45 - 50 USD Hourly" - two-digit
  // figures, below compInText's four-digit minimum.
  const detail = parseAvatureDetail(fixtureHtml("avature-detail.html"), "40101");
  assert.equal(detail.compLow, null);
  assert.equal(detail.compHigh, null);

  // The second states "more than $50 million" - one dollar figure, no paired
  // second amount for a range.
  const alternate = parseAvatureDetail(fixtureHtml("avature-detail-alt.html"), "770412");
  assert.equal(alternate.compLow, null);
  assert.equal(alternate.compHigh, null);
});

test("Avature: a body edited to carry a real four-digit dollar range still matches via compInText", () => {
  // No tenant shape checked states one - edited so the fallback path itself
  // is exercised, not just its real-world absence.
  const withRange = fixtureHtml("avature-detail.html").replace(
    "Salary Range = 45&nbsp;- 50 USD&nbsp;Hourly",
    "Salary Range = $45,000 - $50,000 USD Annually",
  );
  const listing = parseAvatureDetail(withRange, "40101");
  assert.equal(listing.compLow, 45_000);
  assert.equal(listing.compHigh, 50_000);
});

test("Avature: no field__label at all (an edited, minimal detail) reads location and comp/postedAt null, never throws", () => {
  const minimal =
    '<html><head><meta property="og:title" content="Bare Posting" /></head>' +
    '<body><div class="article__content__view__field"><div class="article__content__view__field__value">Just a description, no fields.</div></div></body></html>';
  const listing = parseAvatureDetail(minimal, "99999");
  assert.equal(listing.title, "Bare Posting");
  assert.equal(listing.location, null);
  assert.equal(listing.postedAt, null);
  assert.ok(listing.body?.includes("Just a description"));
});

test("Avature: no og:title tag at all reads title null, not a throw", () => {
  const listing = parseAvatureDetail("<html><body>no meta here</body></html>", "1");
  assert.equal(listing.title, null);
  assert.equal(listing.body, null);
});

test("Avature: list pages by the count actually returned (five rows, short of a 100-per-page request) and stops on an empty page; body hits the detail URL and fills id/url", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("jobOffset=0")) {
      return new Response(fixtureHtml("avature-listing.html"), { status: 200 });
    }
    if (url.includes("jobOffset=5")) {
      return new Response("<html><body>no more results</body></html>", { status: 200 });
    }
    if (url.endsWith("/en_US/careers/JobDetail/x/40101")) {
      return new Response(fixtureHtml("avature-detail.html"), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "avature" as const, id: "fourthcoffee" };

  const listings = await avatureReader.list(board, options);
  assert.equal(listings.length, 5);
  assert.deepEqual(requested, [
    "https://fourthcoffee.avature.net/careers/SearchJobs/?jobRecordsPerPage=100&jobOffset=0",
    "https://fourthcoffee.avature.net/careers/SearchJobs/?jobRecordsPerPage=100&jobOffset=5",
  ]);

  const detail = await avatureReader.body?.(board, "40101", options);
  assert.equal(detail?.id, "40101");
  assert.equal(detail?.title, "Staff Platform Engineer - Remote - Contract");
  assert.equal(detail?.url, "https://fourthcoffee.avature.net/en_US/careers/JobDetail/x/40101");
});

// The shape the title-anchor regex reads, hand-written from the fixture's
// markup: the shared class token, a per-tenant suffix after it, and the href
// whose trailing digits are the id.
function listingPage(ids: readonly string[]): string {
  const rows = ids
    .map(
      (id) =>
        `<h3 class="article__header__text__title title--04">` +
        `<a href="/careers/JobDetail/Role-${id}/${id}">Role ${id}</a></h3>`,
    )
    .join("\n");
  return `<html><body>${rows}</body></html>`;
}

test("Avature: a tenant that ignores jobOffset and repeats the identical page stops the walk after one repeat, not at MAX_PAGES", async () => {
  // Every tenant checked ignores the `jobRecordsPerPage` asked for; one that
  // likewise ignores `jobOffset` answers the same first page forever. Without
  // an id-repeat stop that is 500 fetches (MAX_PAGES) for one board per run.
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixtureHtml("avature-listing.html"), { status: 200 });
  };
  const board = { platform: "avature" as const, id: "fourthcoffee" };

  const listings = await avatureReader.list(board, {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: async () => {},
  });

  assert.equal(requested.length, 2);
  assert.deepEqual(requested, [
    "https://fourthcoffee.avature.net/careers/SearchJobs/?jobRecordsPerPage=100&jobOffset=0",
    "https://fourthcoffee.avature.net/careers/SearchJobs/?jobRecordsPerPage=100&jobOffset=5",
  ]);
  // The five rows once, not ten.
  assert.equal(listings.length, 5);
  assert.equal(new Set(listings.map((listing) => listing.id)).size, 5);
});

test("Avature: pages that overlap return each posting once, and the walk runs on while a page carries an unseen id", async () => {
  // Page two repeats two of page one's ids and adds two of its own; page
  // three repeats page two exactly, which is where the walk stops.
  const pages: Record<string, readonly string[]> = {
    "jobOffset=0": ["101", "102", "103", "104"],
    "jobOffset=4": ["103", "104", "105", "106"],
    "jobOffset=8": ["103", "104", "105", "106"],
  };
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const ids = Object.entries(pages).find(([query]) => url.includes(query))?.[1];
    return new Response(listingPage(ids ?? []), { status: 200 });
  };

  const listings = await avatureReader.list(
    { platform: "avature" as const, id: "fourthcoffee" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );

  assert.equal(requested.length, 3);
  assert.deepEqual(
    listings.map((listing) => listing.id),
    ["101", "102", "103", "104", "105", "106"],
  );
  assert.equal(listings[4]?.url, "https://fourthcoffee.avature.net/careers/JobDetail/Role-105/105");
});
