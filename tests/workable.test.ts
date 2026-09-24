import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  parseWorkableListing,
  parseWorkableDetail,
  workableReader,
  workableWorkplace,
} from "../src/ats/workable.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// workable-listing.json is a synthetic Fernbridge listing in the shape
// apply.workable.com/api/v1/widget/accounts/<account> answers with, cut to
// three jobs. workable-detail.json is the matching detail for shortcode
// H7RGXN2VLD, in the shape apply.workable.com/api/v2/accounts/<account>/jobs/
// <shortcode> answers with, with short description/requirements/benefits;
// every field the parser reads is present. It states structured USD/year pay,
// as an account with pay transparency on does, so the structured path is
// covered here; the "fields absent" and "non-USD" branches are exercised
// below by spreading this object and deleting or overriding fields in the
// test, not by a second committed fixture.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("Workable: a listing entry carries no body or comp, and maps title/url/location/postedAt/workplace", () => {
  const listings = parseWorkableListing(fixture("workable-listing.json"));
  assert.equal(listings.length, 3);
  for (const listing of listings) {
    assert.equal(listing.body, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
  }

  const designer = listings.find((listing) => listing.id === "P8LKX2WVQR");
  assert.ok(designer);
  assert.equal(designer?.title, "Senior Product Designer");
  assert.equal(designer?.url, "https://apply.workable.com/j/P8LKX2WVQR");
  // city and state are both "" on this job; only country is non-empty.
  assert.equal(designer?.location, "United States");
  assert.equal(designer?.postedAt, "2026-09-15");
  // telecommuting: true records remote.
  assert.equal(designer?.workplace, "remote");

  const accountExecutive = listings.find((listing) => listing.id === "M3TZQ9DKBH");
  assert.ok(accountExecutive);
  assert.equal(accountExecutive?.title, "Account Executive");
  assert.equal(accountExecutive?.location, "Dallas, Texas, United States");
  // telecommuting: false records null, not onsite: the listing states no
  // on-site/hybrid word, only whether it is remote (Ruling 4).
  assert.equal(accountExecutive?.workplace, null);

  const backend = listings.find((listing) => listing.id === "H7RGXN2VLD");
  assert.ok(backend);
  assert.equal(backend?.title, "Backend Software Engineer");
  assert.equal(backend?.location, "San Francisco, California, United States");
  assert.equal(backend?.workplace, null);
});

test("Workable: location joins city/state/country dropping empty parts, null when all are empty", () => {
  const listings = parseWorkableListing({
    jobs: [{ shortcode: "x", title: "No location", city: "", state: "", country: "" }],
  });
  assert.equal(listings[0]?.location, null);
});

test("Workable: a detail response's body is text, not HTML", () => {
  const listing = parseWorkableDetail(fixture("workable-detail.json"));
  assert.ok(listing.body !== null);
  assert.ok(!listing.body?.includes("<p>"));
  assert.ok(listing.body?.includes("About the company"));
  assert.ok(listing.body?.includes("What we're looking for"));
  assert.ok(listing.body?.includes("Compensation and benefits"));
});

test("Workable: a USD-year detail's structured salary wins as the comp", () => {
  const listing = parseWorkableDetail(fixture("workable-detail.json"));
  assert.equal(listing.title, "Backend Software Engineer");
  assert.equal(listing.location, "San Francisco, California, United States");
  assert.equal(listing.compLow, 165_000);
  assert.equal(listing.compHigh, 205_000);
  assert.equal(listing.postedAt, "2026-09-15");
  assert.equal(listing.workplace, "onsite");
});

test("Workable: a detail with no structured salary falls back to compInText, null when the body states no $ figure", () => {
  const raw = fixture("workable-detail.json") as Record<string, unknown>;
  const noSalary = { ...raw };
  delete noSalary["salary_from"];
  delete noSalary["salary_to"];
  delete noSalary["salary_currency_iso_code"];
  delete noSalary["salary_frequency"];
  const listing = parseWorkableDetail(noSalary);
  // The benefits text states "USD 165,000 to 205,000 per year", no
  // "$" sign, so compInText's dollar-sign pattern does not match it either.
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test("Workable: a detail stated in CAD is not read as USD, comp is null", () => {
  const raw = fixture("workable-detail.json") as Record<string, unknown>;
  const cad = { ...raw, salary_currency_iso_code: "CAD" };
  const listing = parseWorkableDetail(cad);
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
});

test("workableWorkplace: on_site spells onsite, remote and hybrid pass through, anything else is null", () => {
  assert.equal(workableWorkplace("remote"), "remote");
  assert.equal(workableWorkplace("hybrid"), "hybrid");
  assert.equal(workableWorkplace("on_site"), "onsite");
  assert.equal(workableWorkplace("unspecified"), null);
  assert.equal(workableWorkplace(undefined), null);
});

test("Workable: list hits the v1 widget URL, body hits the v2 URL", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/api/v1/widget/accounts/")) {
      return new Response(JSON.stringify(fixture("workable-listing.json")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v2/accounts/")) {
      return new Response(JSON.stringify(fixture("workable-detail.json")), {
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
  const board = { platform: "workable" as const, id: "fernbridge" };

  const listings = await workableReader.list(board, options);
  assert.equal(listings.length, 3);

  const detail = await workableReader.body?.(board, "H7RGXN2VLD", options);
  assert.equal(detail?.title, "Backend Software Engineer");

  assert.deepEqual(requested, [
    "https://apply.workable.com/api/v1/widget/accounts/fernbridge",
    "https://apply.workable.com/api/v2/accounts/fernbridge/jobs/H7RGXN2VLD",
  ]);
});
