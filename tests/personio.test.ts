import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parsePersonioFeed, personioReader } from "../src/ats/personio.ts";

// The client requires a configured User-Agent; these tests fake the network
// entirely, so any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// personio-feed.xml is written from Personio's XML feed schema and never
// captured; the fixture's own header comment says which shape each of its
// three positions proves. Every id, office, date and sentence in it is
// invented, and the dollar range in position 3350102 is the only way to
// exercise the structured `compInText` path, since no board feed states
// one structurally.
function fixtureFeed(): string {
  return readFileSync(new URL("./fixtures/personio-feed.xml", import.meta.url), "utf8");
}

test("Personio: field mapping, incl. multi-section body join and createdAt -> postedAt", () => {
  const listings = parsePersonioFeed(fixtureFeed(), "alpineskihouse.jobs.personio.de");
  assert.equal(listings.length, 3);

  const salesManager = listings.find((listing) => listing.id === "3350101");
  assert.ok(salesManager);
  assert.equal(salesManager?.title, "Junior Sales Manager (m/f/x)");
  assert.equal(salesManager?.url, "https://alpineskihouse.jobs.personio.de/job/3350101");
  // The direct `<office>Munich</office>` child, not the nested
  // `<additionalOffices>` list some other live positions carry.
  assert.equal(salesManager?.location, "Munich");
  assert.equal(salesManager?.postedAt, "2026-09-04");
  assert.equal(salesManager?.workplace, null);
  assert.equal(salesManager?.compLow, null);
  assert.equal(salesManager?.compHigh, null);

  const body = salesManager?.body ?? "";
  // One phrase from each of the five sections, present and in document
  // order - proves the join walks every section, not just the first or
  // last, and that no section's own <name> was read as the title.
  const ourMission = body.indexOf("rent and service ski equipment");
  const aboutTheRole = body.indexOf("first person a resort talks to");
  const dayToDay = body.indexOf("written pipeline of resorts");
  const whatYouBring = body.indexOf("German and English good enough");
  const whatWeOffer = body.indexOf("seasonal bonus on the contracts");
  assert.ok(ourMission >= 0, "Our Mission section missing from body");
  assert.ok(aboutTheRole > ourMission, "About the Role out of order or missing");
  assert.ok(dayToDay > aboutTheRole, "Your Day to Day out of order or missing");
  assert.ok(whatYouBring > dayToDay, "What You Bring out of order or missing");
  assert.ok(whatWeOffer > whatYouBring, "What We Offer out of order or missing");
  // The inline style attribute on the first section's span is stripped,
  // not carried into the body text.
  assert.ok(!body.includes("font-family"));
});

test("Personio: a position stating one section carries only that section's text", () => {
  const listings = parsePersonioFeed(fixtureFeed(), "alpineskihouse.jobs.personio.de");
  const technician = listings.find((listing) => listing.id === "3350103");
  assert.ok(technician);
  assert.equal(technician?.title, "Workshop Technician (f/m/d)");
  assert.equal(technician?.location, "London");
  assert.equal(technician?.postedAt, "2026-08-10");

  const body = technician?.body ?? "";
  // Only its one "Our Mission" section.
  assert.ok(body.includes("tune and repair rental skis"));
  // This position states no other section; no other position's text may
  // appear in its body, which is what says the split is per position.
  assert.ok(!body.includes("first person a resort talks to"));
});

test("Personio: compInText reads a dollar range stated in the body", () => {
  const listings = parsePersonioFeed(fixtureFeed(), "alpineskihouse.jobs.personio.de");
  const accountant = listings.find((listing) => listing.id === "3350102");
  assert.ok(accountant);
  assert.equal(accountant?.compLow, 85000);
  assert.equal(accountant?.compHigh, 105000);
  assert.ok(accountant?.body?.includes("This role pays $85,000 - $105,000 per year."));
});

test("Personio: self-closing and absent <jobDescriptions> both read as empty body, not a throw", () => {
  const selfClosing = [
    "<workzag-jobs>",
    "<position><id>901</id><name>Self-Closing Role</name><office>Remote</office>",
    "<jobDescriptions/><createdAt>2026-01-05T00:00:00+00:00</createdAt></position>",
    "</workzag-jobs>",
  ].join("");
  const absent = [
    "<workzag-jobs>",
    "<position><id>902</id><name>No Section Role</name><office>Remote</office>",
    "<createdAt>2026-01-06T00:00:00+00:00</createdAt></position>",
    "</workzag-jobs>",
  ].join("");

  const selfClosingListings = parsePersonioFeed(selfClosing, "test.jobs.personio.com");
  assert.equal(selfClosingListings.length, 1);
  assert.equal(selfClosingListings[0]?.body, null);
  assert.equal(selfClosingListings[0]?.title, "Self-Closing Role");

  const absentListings = parsePersonioFeed(absent, "test.jobs.personio.com");
  assert.equal(absentListings.length, 1);
  assert.equal(absentListings[0]?.body, null);
  assert.equal(absentListings[0]?.title, "No Section Role");
});

test("Personio: malformed XML (an unclosed position) never throws", () => {
  const malformed = "<workzag-jobs><position><id>1</id><name>Broken";
  assert.doesNotThrow(() => parsePersonioFeed(malformed, "test.jobs.personio.com"));
  assert.deepEqual(parsePersonioFeed(malformed, "test.jobs.personio.com"), []);
});

test("Personio: list hits the board's xml feed URL", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return new Response(fixtureFeed(), {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };
  const options = { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} };
  const board = { platform: "personio" as const, id: "alpineskihouse.jobs.personio.de" };

  const listings = await personioReader.list(board, options);
  assert.equal(listings.length, 3);
  assert.deepEqual(requested, ["https://alpineskihouse.jobs.personio.de/xml"]);
});
