import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  parseRecruiteeListing,
  recruiteeReader,
  recruiteeWorkplace,
} from "../src/ats/recruitee.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// recruitee-listing.json is written from Recruitee's offers-API schema and
// never captured; every id, title, place and sentence in it is invented and
// Bellows College is not a real employer. It holds one offer per live
// workplace-flag shape: a clean single flag (2752864, remote only), all
// three true at once (2663303), and hybrid+on_site true together (2513139).
// The top-level `location` field keeps the live shapes too - the literal
// placeholder "Remote job" on the remote offers, a place on the one that
// states no remote flag. Offer 2752864's `salary` carries USD/year figures
// so the structured-comp path has a shape to exercise; the other two carry
// the all-null shape every live offer checked stated, one of them with
// `period`/`currency` set anyway, which on its own must not be read.
function fixtureListing(): unknown {
  return JSON.parse(
    readFileSync(new URL("./fixtures/recruitee-listing.json", import.meta.url), "utf8"),
  );
}

test("Recruitee: field mapping for all three live workplace-flag cases", () => {
  const listings = parseRecruiteeListing(fixtureListing());
  assert.equal(listings.length, 3);

  const dataScientist = listings.find((listing) => listing.id === "2752864");
  assert.ok(dataScientist);
  assert.equal(dataScientist?.title, "Senior Data Scientist - Real-Time Predictions (m/f/x)");
  assert.equal(
    dataScientist?.url,
    "https://bellowscollege.recruitee.com/o/senior-data-scientist-real-time-predictions-mfx",
  );
  assert.equal(dataScientist?.location, "Wroclaw, Dolnośląskie, Poland");
  assert.equal(dataScientist?.postedAt, "2026-09-21");
  assert.equal(dataScientist?.workplace, "remote");

  const backendEngineer = listings.find((listing) => listing.id === "2663303");
  assert.ok(backendEngineer);
  assert.equal(backendEngineer?.location, "Wroclaw, Dolnośląskie, Poland");
  assert.equal(backendEngineer?.postedAt, "2026-09-01");
  // remote, hybrid and on_site all true at once - not a single answer.
  assert.equal(backendEngineer?.workplace, null);

  const labTechnician = listings.find((listing) => listing.id === "2513139");
  assert.ok(labTechnician);
  assert.equal(labTechnician?.location, "Wroclaw, Dolnośląskie, Poland");
  assert.equal(labTechnician?.postedAt, "2026-03-12");
  // hybrid and on_site both true together - not a single answer.
  assert.equal(labTechnician?.workplace, null);
});

test("Recruitee: location reads the city/state_name/country join, not the top-level placeholder", () => {
  const raw = fixtureListing() as { offers: Array<Record<string, unknown>> };
  const dataScientistOffer = raw.offers.find((offer) => offer["id"] === 2752864);
  assert.ok(dataScientistOffer);
  // The board's own top-level field for a remote posting: the literal
  // placeholder, not a place.
  assert.equal(dataScientistOffer?.["location"], "Remote job");

  const listings = parseRecruiteeListing(fixtureListing());
  const dataScientist = listings.find((listing) => listing.id === "2752864");
  // The reader reads the joined city/state_name/country instead.
  assert.equal(dataScientist?.location, "Wroclaw, Dolnośląskie, Poland");
  assert.notEqual(dataScientist?.location, dataScientistOffer?.["location"]);
});

test("Recruitee: structured comp reads over salary.min/max when USD and annual", () => {
  const listings = parseRecruiteeListing(fixtureListing());
  const dataScientist = listings.find((listing) => listing.id === "2752864");
  // This offer's salary carries USD/year figures where every live offer
  // checked stated all-null (see the fixture's header comment).
  assert.equal(dataScientist?.compLow, 130000);
  assert.equal(dataScientist?.compHigh, 165000);
});

test("Recruitee: an offer with a null salary falls through to compInText or null", () => {
  const listings = parseRecruiteeListing(fixtureListing());
  const backendEngineer = listings.find((listing) => listing.id === "2663303");
  const labTechnician = listings.find((listing) => listing.id === "2513139");
  // Neither body states a dollar figure, so both fall all the way to null -
  // including 2513139, whose salary states a period and a currency but no
  // min or max, which the structured path must refuse.
  assert.equal(backendEngineer?.compLow, null);
  assert.equal(backendEngineer?.compHigh, null);
  assert.equal(labTechnician?.compLow, null);
  assert.equal(labTechnician?.compHigh, null);
});

test("Recruitee: list hits the board's offers URL", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return new Response(JSON.stringify(fixtureListing()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "recruitee" as const, id: "bellowscollege" };

  const listings = await recruiteeReader.list(board, options);
  assert.equal(listings.length, 3);
  assert.deepEqual(requested, ["https://bellowscollege.recruitee.com/api/offers"]);
});

test("recruiteeWorkplace: exactly one true flag reads as that word, else null", () => {
  assert.equal(recruiteeWorkplace({ remote: true, hybrid: false, on_site: false }), "remote");
  assert.equal(recruiteeWorkplace({ remote: false, hybrid: true, on_site: false }), "hybrid");
  assert.equal(recruiteeWorkplace({ remote: false, hybrid: false, on_site: true }), "onsite");
  assert.equal(recruiteeWorkplace({ remote: true, hybrid: true, on_site: true }), null);
  assert.equal(recruiteeWorkplace({ remote: false, hybrid: true, on_site: true }), null);
  assert.equal(recruiteeWorkplace({ remote: false, hybrid: false, on_site: false }), null);
});
