import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  parseJazzhrListing,
  parseJazzhrDetail,
  jazzhrWorkplace,
  jazzhrReader,
} from "../src/ats/jazzhr.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Both fixtures are written from JazzHR's markup schema and never captured;
// each carries its own header comment saying which shape each row or block
// is there to prove. Every id, title, place and the tenant itself are
// invented.
function fixtureHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("JazzHR: a plain row maps id/title/url/location, carries no comp/postedAt/body, workplace null", () => {
  const listings = parseJazzhrListing(fixtureHtml("jazzhr-listing.html"), "fincherarchitects");
  assert.equal(listings.length, 7);

  const qa = listings.find((listing) => listing.id === "Ka7nTq2Wb4");
  assert.ok(qa);
  assert.equal(qa?.title, "Associate Software QA Engineer");
  assert.equal(
    qa?.url,
    "https://fincherarchitects.applytojob.com/apply/Ka7nTq2Wb4/Associate-Software-QA-Engineer",
  );
  assert.equal(qa?.location, "Fairhaven, North Yard, United States");
  assert.equal(qa?.compLow, null);
  assert.equal(qa?.compHigh, null);
  assert.equal(qa?.postedAt, null);
  assert.equal(qa?.body, null);
  assert.equal(qa?.workplace, null);

  for (const listing of listings) {
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.equal(listing.postedAt, null);
    assert.equal(listing.body, null);
  }
});

test('JazzHR: workplace is an exact comma-segment match - Remote and Hybrid catch real shapes, a leading "(Remote" segment does not', () => {
  const listings = parseJazzhrListing(fixtureHtml("jazzhr-listing.html"), "fincherarchitects");

  // "Remote, remote, Mexico" - first segment exact, second lower-cased.
  const procurement = listings.find((listing) => listing.id === "Zt3mPd9Xr5");
  assert.equal(procurement?.location, "Remote, remote, Mexico");
  assert.equal(procurement?.workplace, "remote");

  // A bare single-segment "Remote".
  const canadaPr = listings.find((listing) => listing.id === "Nq8sLv1Hy6");
  assert.equal(canadaPr?.location, "Remote");
  assert.equal(canadaPr?.workplace, "remote");

  // A Remote segment, with a sibling Department Code <li>
  // (fa-sitemap icon) that must not leak into location.
  const customerAccount = listings.find((listing) => listing.id === "Lx2fB6Dg77");
  assert.equal(customerAccount?.location, "Fairview, Remote, Philippines");
  assert.equal(customerAccount?.workplace, "remote");
  assert.ok(!customerAccount?.location?.includes("Department Code"));

  // A Hybrid segment.
  const globalContract = listings.find((listing) => listing.id === "Lr9qHx3Em2");
  assert.equal(globalContract?.location, "Harbour East, Hybrid, Hong Kong");
  assert.equal(globalContract?.workplace, "hybrid");

  // The shape a live board was found stating: the leading segment is
  // literally "(Remote", not "Remote", so an exact-segment rule reads this
  // posting's workplace as null. A substring rule would wrongly read it as
  // remote; this proves the rule isn't one.
  const successAssociate = listings.find((listing) => listing.id === "Gg4yKk5p18");
  assert.equal(successAssociate?.location, "(Remote, PHILIPPINES), Fairview, Philippines");
  assert.equal(successAssociate?.workplace, null);
});

test("JazzHR: an HTML entity in a location decodes before the comma-split", () => {
  const listings = parseJazzhrListing(fixtureHtml("jazzhr-listing.html"), "fincherarchitects");
  const hrbp = listings.find((listing) => listing.id === "Co0uXk7Jq3");
  assert.equal(hrbp?.title, "Executive / Senior Executive HRBP");
  assert.equal(hrbp?.location, "North & South Campus, India");
  assert.equal(hrbp?.workplace, null);
});

test("jazzhrWorkplace: exact-segment match against the comma-joined location string directly", () => {
  assert.equal(jazzhrWorkplace("Remote"), "remote");
  assert.equal(jazzhrWorkplace("Austin, TX"), null);
  assert.equal(jazzhrWorkplace("Harbour East, Hybrid, Hong Kong"), "hybrid");
  assert.equal(jazzhrWorkplace("(Remote, PHILIPPINES), Fairview, Philippines"), null);
});

test("JazzHR: a title anchor missing its closing </a> before </h3> still parses - real JazzHR markup has been seen without it", () => {
  // Not the shape this board's own live fetch happened to carry today (see
  // the fixture header) - a minimal row built to prove the parser doesn't
  // require the closing tag, per the plan's own warning not to assume
  // well-formed nesting here.
  const html = `<ul class='list-group'><li class="list-group-item">
    <h3 class='list-group-item-heading'>
        <a href="https://fincherarchitects.applytojob.com/apply/abc123/Some-Title">
            Some Title
    </h3>
    <ul class='list-inline list-group-item-text'>
        <li><i class='fa fa-map-marker'></i>Austin, Texas</li>
    </ul>
</li></ul>`;
  const listings = parseJazzhrListing(html, "fincherarchitects");
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.id, "abc123");
  assert.equal(listings[0]?.title, "Some Title");
  assert.equal(listings[0]?.location, "Austin, Texas");
});

test("JazzHR: a row whose href is only account-relative (not the real absolute shape) still resolves a correct url", () => {
  const html = `<ul class='list-group'><li class="list-group-item">
    <h3 class='list-group-item-heading'>
        <a href="/apply/xyz789/Relative-Title">Relative Title</a>
    </h3>
    <ul class='list-inline list-group-item-text'>
        <li><i class='fa fa-map-marker'></i>Remote</li>
    </ul>
</li></ul>`;
  const listings = parseJazzhrListing(html, "fincherarchitects");
  assert.equal(listings[0]?.id, "xyz789");
  assert.equal(
    listings[0]?.url,
    "https://fincherarchitects.applytojob.com/apply/xyz789/Relative-Title",
  );
  assert.equal(listings[0]?.workplace, "remote");
});

test("JazzHR: a row with no map-marker <li> reads location and workplace both null, not a throw", () => {
  const html = `<ul class='list-group'><li class="list-group-item">
    <h3 class='list-group-item-heading'>
        <a href="/apply/noloc1/No-Location">No Location</a>
    </h3>
    <ul class='list-inline list-group-item-text'></ul>
</li></ul>`;
  const listings = parseJazzhrListing(html, "fincherarchitects");
  assert.equal(listings[0]?.location, null);
  assert.equal(listings[0]?.workplace, null);
});

test('JazzHR detail: the board-suffixed <title> ("{title} - {board} - Career Page") strips clean, location is not read, workplace is null', () => {
  const listing = parseJazzhrDetail(fixtureHtml("jazzhr-detail.html"), "Vz7PrJj9Cr");
  assert.equal(listing.id, "Vz7PrJj9Cr");
  assert.equal(listing.title, "Client Success Partner, Civic Vertical (US Remote)");
  assert.equal(listing.location, null);
  assert.equal(listing.workplace, null);
  assert.equal(listing.postedAt, null);
  assert.ok(listing.body?.includes("100% work from home"));
  assert.ok(!listing.body?.includes("<span"));
});

test('JazzHR detail: the "$75- 90K" salary sentence does not match compInText\'s regex, so comp reads null', () => {
  const listing = parseJazzhrDetail(fixtureHtml("jazzhr-detail.html"), "Vz7PrJj9Cr");
  assert.ok(listing.body?.includes("$75- 90K"));
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test('JazzHR detail: the plain, board-less <title> shape ("{title} - Career Page", also confirmed live on this tenant) strips clean too', () => {
  // A second real shape (fincherarchitects.applytojob.com/apply/lx8yF2DdCg/...,
  // fetched live 2026-09-22): this tenant's own detail pages state the
  // suffix both ways, not always with the board name. Built inline rather
  // than as a second fixture file, so the fixtures directory keeps one JazzHR detail page.
  const html =
    "<html><head><title>Customer Account Specialist (PHILIPPINES Hybrid) - Career Page</title></head>" +
    "<body><div class='col col-xs-7 description' id=\"job-description\">Some body text." +
    '<div class="resumator-mobile-apply-wrapper"></div></body></html>';
  const listing = parseJazzhrDetail(html, "Lx2fB6Dg77");
  assert.equal(listing.title, "Customer Account Specialist (PHILIPPINES Hybrid)");
});

test("JazzHR detail: an edited body carrying a comma-grouped dollar range matches compInText, proving the wiring, not just its absence", () => {
  // Detail bodies checked live never state pay in the comma-grouped shape
  // compInText matches (see the fixture's "$75- 90K" sentence, which
  // doesn't); this body is edited to carry one,
  // stated plainly, the same way other readers' tests exercise this branch
  // (e.g. bamboohr.test.ts, jobvite.test.ts's edited "cad" case).
  const html =
    "<html><head><title>Edited Comp Posting - Career Page</title></head>" +
    "<body><div class='col col-xs-7 description' id=\"job-description\">" +
    "The salary range for this role is $70,000 - $90,000 per year." +
    '<div class="resumator-mobile-apply-wrapper"></div></body></html>';
  const listing = parseJazzhrDetail(html, "edited-id");
  assert.equal(listing.compLow, 70_000);
  assert.equal(listing.compHigh, 90_000);
});

test("JazzHR detail: a tenant whose page carries no resumator-mobile-apply-wrapper still reads a body, and stops at the description's own close", () => {
  // The sibling wrapper div appears nowhere in this page - only one
  // tenant's skin was ever checked for it, and reading up to a sibling's
  // class name cost the whole body on any tenant rendering it differently.
  const html =
    "<html><head><title>Skinless Tenant Role - Career Page</title></head><body>" +
    "<div class='col col-xs-7 description' id=\"job-description\">Real description text.</div>" +
    '<div class="footer-chrome">Apply for this Position</div>' +
    "</body></html>";
  const listing = parseJazzhrDetail(html, "skinless-1");
  assert.equal(listing.body, "Real description text.");
});

test("JazzHR detail: a description whose own markup nests divs is read whole, not cut at the first </div>", () => {
  const html =
    "<html><head><title>Nested Role - Career Page</title></head><body>" +
    "<div id=\"job-description\" class='description'>" +
    "<div><p>First paragraph.</p><div>Nested deeper.</div></div>" +
    "<div>Last block.</div>" +
    "</div>" +
    '<div class="resumator-mobile-apply-wrapper mobile"></div>' +
    "</body></html>";
  const listing = parseJazzhrDetail(html, "nested-1");
  assert.equal(listing.body, "First paragraph.\nNested deeper.\nLast block.");
});

test("JazzHR detail: a description div left unclosed reads the rest of the page rather than nothing - this vendor drops closing tags", () => {
  // Same shape as the unclosed `</a>` the listing parser already tolerates
  // (see this reader's header comment): an over-long body still feeds the
  // judge and compInText, where an empty one feeds neither.
  const html =
    "<html><head><title>Unclosed Role - Career Page</title></head><body>" +
    "<div class='description' id=\"job-description\">Description that never closes." +
    "</body></html>";
  const listing = parseJazzhrDetail(html, "unclosed-1");
  assert.equal(listing.body, "Description that never closes.");
});

test("JazzHR detail: no <title> or no #job-description reads null/empty, never a throw", () => {
  const listing = parseJazzhrDetail("<html><body>no title here</body></html>", "some-id");
  assert.equal(listing.title, null);
  assert.equal(listing.body, null);
  assert.equal(listing.compLow, null);
});

test("JazzHR: list hits the board's apply page, body hits /apply/{id}/x and fills in the request URL", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://fincherarchitects.applytojob.com/apply/") {
      return new Response(fixtureHtml("jazzhr-listing.html"), { status: 200 });
    }
    if (url === "https://fincherarchitects.applytojob.com/apply/Vz7PrJj9Cr/x") {
      return new Response(fixtureHtml("jazzhr-detail.html"), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "jazzhr" as const, id: "fincherarchitects" };

  const listings = await jazzhrReader.list(board, options);
  assert.equal(listings.length, 7);

  const detail = await jazzhrReader.body?.(board, "Vz7PrJj9Cr", options);
  assert.equal(detail?.title, "Client Success Partner, Civic Vertical (US Remote)");
  assert.equal(detail?.url, "https://fincherarchitects.applytojob.com/apply/Vz7PrJj9Cr/x");

  assert.deepEqual(requested, [
    "https://fincherarchitects.applytojob.com/apply/",
    "https://fincherarchitects.applytojob.com/apply/Vz7PrJj9Cr/x",
  ]);
});
