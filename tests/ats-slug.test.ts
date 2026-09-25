import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { compInText, workplaceOf } from "../src/ats/ats.ts";
import { parseGreenhouse } from "../src/ats/greenhouse.ts";
import { parseAshby } from "../src/ats/ashby.ts";
import { parseLever } from "../src/ats/lever.ts";
import {
  parseSmartRecruitersListing,
  parseSmartRecruitersDetail,
} from "../src/ats/smartrecruiters.ts";

// Every fixture here is written from its platform's response schema rather
// than captured from a board: the envelope, the nesting, the entity and
// unicode escaping and the field-level quirks are the platform's, and every
// company, identifier, address, date and line of prose in them is invented.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

test("Greenhouse: parses a posting with a stated pay range and one without", () => {
  const listings = parseGreenhouse(fixture("greenhouse.json"));
  assert.equal(listings.length, 2);

  const withRange = listings.find((listing) => listing.id === "4501200100");
  assert.ok(withRange);
  assert.equal(withRange?.title, "Staff Software Engineer, Billing Platform");
  // The range is written with `&mdash;` and the relocation figures below it
  // with a hyphen: both spellings decode, and the higher range wins.
  assert.equal(withRange?.compLow, 148_000);
  assert.equal(withRange?.compHigh, 197_000);
  assert.ok(withRange?.body?.includes("Contoso"));

  const withoutRange = listings.find((listing) => listing.id === "4501200200");
  assert.ok(withoutRange);
  assert.equal(withoutRange?.compLow, null);
  assert.equal(withoutRange?.compHigh, null);
});

test("Greenhouse: a job missing its id reads as an empty string, never a throw", () => {
  const listings = parseGreenhouse({ jobs: [{ title: "No id" }] });
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.id, "");
  assert.equal(listings[0]?.title, "No id");
});

test("Ashby: parses a posting with a structured salary tier and one without", () => {
  const listings = parseAshby(fixture("ashby.json"));
  assert.equal(listings.length, 2);

  const withTier = listings.find((listing) => listing.compLow !== null);
  assert.ok(withTier);
  assert.equal(withTier?.title, "Customer Onboarding Specialist, Inbound");
  assert.equal(withTier?.compLow, 92_000);
  assert.equal(withTier?.compHigh, 92_000);

  const withoutTier = listings.find(
    (listing) => listing.title === "Account Manager, Growth - EMEA",
  );
  assert.ok(withoutTier);
  assert.equal(withoutTier?.compLow, null);
  assert.equal(withoutTier?.compHigh, null);
});

test("Ashby: workplaceType becomes the board's own workplace word, or null when the board states none", () => {
  const listings = parseAshby(fixture("ashby.json"));
  const hybrid = listings.find((listing) => listing.title === "Account Manager, Growth - EMEA");
  assert.equal(hybrid?.workplace, "hybrid");
  const none = listings.find(
    (listing) => listing.title === "Customer Onboarding Specialist, Inbound",
  );
  assert.equal(none?.workplace, null);
});

test("Ashby: a non-Salary component never contributes to comp", () => {
  const listings = parseAshby({
    jobs: [
      {
        id: "x",
        title: "Equity only",
        compensation: {
          compensationTiers: [
            {
              components: [
                { compensationType: "EquityPercentage", minValue: null, maxValue: null },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.equal(listings[0]?.compLow, null);
  assert.equal(listings[0]?.compHigh, null);
});

test("Ashby: a range stated only in the prose is read when the structured field is empty", () => {
  const listings = parseAshby({
    jobs: [
      {
        id: "docker",
        title: "Staff Software Engineer",
        descriptionPlain: "Compensation & Equity\nUnited States: $170,350 – $275,550 + equity",
      },
    ],
  });
  assert.equal(listings[0]?.compLow, 170_350);
  assert.equal(listings[0]?.compHigh, 275_550);
});

test("Ashby: structured comp wins when present, even with differing prose", () => {
  const listings = parseAshby({
    jobs: [
      {
        id: "structured-wins",
        title: "Engineer",
        descriptionPlain: "Pay range is $1,000,000 - $2,000,000",
        compensation: {
          compensationTiers: [
            {
              components: [
                {
                  compensationType: "Salary",
                  interval: "1 YEAR",
                  currencyCode: "USD",
                  minValue: 150_000,
                  maxValue: 180_000,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.equal(listings[0]?.compLow, 150_000);
  assert.equal(listings[0]?.compHigh, 180_000);
});

// The board fixtures state US dollars a year, because that is what the
// readers are for; the other currencies and periods are stated inline here,
// one case per assertion, rather than folded into a fixture.
test("Ashby: a Salary component in another currency or over another period is not read", () => {
  const rupees = parseAshby({
    jobs: [
      {
        id: "inr",
        title: "Engineer, Bengaluru",
        compensation: {
          compensationTiers: [
            {
              components: [
                {
                  compensationType: "Salary",
                  interval: "1 YEAR",
                  currencyCode: "INR",
                  minValue: 4_000_000,
                  maxValue: 6_000_000,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.equal(rupees[0]?.compLow, null);
  assert.equal(rupees[0]?.compHigh, null);

  const hourly = parseAshby({
    jobs: [
      {
        id: "hourly",
        title: "Support Specialist",
        compensation: {
          compensationTiers: [
            {
              components: [
                {
                  compensationType: "Salary",
                  interval: "1 HOUR",
                  currencyCode: "USD",
                  minValue: 30,
                  maxValue: 45,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  assert.equal(hourly[0]?.compLow, null);
  assert.equal(hourly[0]?.compHigh, null);
});

test("Lever: a salary in another currency or over another period is not read", () => {
  const euros = parseLever([
    {
      id: "eur",
      text: "Engineer, Berlin",
      salaryRange: { min: 72_000, max: 100_000, currency: "EUR", interval: "per-year-salary" },
    },
  ]);
  assert.equal(euros[0]?.compLow, null);
  assert.equal(euros[0]?.compHigh, null);

  const hourly = parseLever([
    {
      id: "hourly",
      text: "Contractor",
      salaryRange: { min: 60, max: 90, currency: "USD", interval: "per-hour-wage" },
    },
  ]);
  assert.equal(hourly[0]?.compLow, null);
  assert.equal(hourly[0]?.compHigh, null);
});

test("Lever: a range stated only in the prose is read when salaryRange is absent", () => {
  const listings = parseLever([
    { id: "1", text: "Role", descriptionPlain: "The salary range is $160,000 to $210,000." },
  ]);
  assert.equal(listings[0]?.compLow, 160_000);
  assert.equal(listings[0]?.compHigh, 210_000);
});

test("Lever: parses a posting with a salary range and one without", () => {
  const listings = parseLever(fixture("lever.json"));
  assert.equal(listings.length, 2);

  const withRange = listings.find((listing) => listing.compLow !== null);
  assert.ok(withRange);
  assert.equal(withRange?.title, "Partnerships Development Representative");
  assert.equal(withRange?.compLow, 88_000);
  assert.equal(withRange?.compHigh, 121_000);
  // This posting states its body in `descriptionBody` and leaves
  // `descriptionPlain` empty, which Lever does: comp comes from the
  // structured range and the body reads as absent.
  assert.equal(withRange?.body, null);

  const withoutRange = listings.find(
    (listing) => listing.title === "Senior / Lead Analyst, Customer Reporting",
  );
  assert.ok(withoutRange);
  assert.equal(withoutRange?.compLow, null);
  assert.equal(withoutRange?.compHigh, null);
});

test("Lever: workplaceType becomes the board's own workplace word", () => {
  const listings = parseLever(fixture("lever.json"));
  assert.equal(listings.length, 2);
  for (const listing of listings) assert.equal(listing.workplace, "remote");
});

test("Lever: createdAt in epoch milliseconds becomes a calendar date", () => {
  const listings = parseLever([{ id: "1", text: "Role", createdAt: 1_757_000_000_000 }]);
  assert.equal(listings[0]?.postedAt, "2025-09-04");
});

test("workplaceOf: normalises a board's spelling and reads anything else as none stated", () => {
  assert.equal(workplaceOf("OnSite"), "onsite");
  assert.equal(workplaceOf("onsite"), "onsite");
  assert.equal(workplaceOf("Hybrid"), "hybrid");
  assert.equal(workplaceOf("remote"), "remote");
  assert.equal(workplaceOf("unspecified"), null);
  assert.equal(workplaceOf(undefined), null);
  assert.equal(workplaceOf(null), null);
});

test("comp in text: the highest range wins, not the first one written", () => {
  assert.deepEqual(compInText("Relocation of $5,000 - $10,000. Base pay is $220,000 - $300,000."), {
    compLow: 220_000,
    compHigh: 300_000,
  });
});

test("comp in text: a range written without thousands separators is still a range", () => {
  assert.deepEqual(compInText("$150000 - $200000"), { compLow: 150_000, compHigh: 200_000 });
});

test("comp in text: a body stating no range at all reads as absent", () => {
  assert.equal(compInText("We offer a competitive salary and equity."), null);
});

test("comp in text: the four shapes live boards write on 2026-09-16", () => {
  assert.deepEqual(compInText("United States: $198K – $319K + equity"), {
    compLow: 198_000,
    compHigh: 319_000,
  });
  assert.deepEqual(compInText("Target Annual Earnings: $120K-145K"), {
    compLow: 120_000,
    compHigh: 145_000,
  });
  assert.deepEqual(compInText("range is $198,000 USD – $233,000 USD, plus bonus"), {
    compLow: 198_000,
    compHigh: 233_000,
  });
  assert.deepEqual(compInText("range for this role is $ 174,986 - $209,983 ."), {
    compLow: 174_986,
    compHigh: 209_983,
  });
});

test("comp in text: currency word before the second dollar sign", () => {
  assert.deepEqual(compInText("The base salary range is USD $120,000.00 - USD $300,000.00 /Yr."), {
    compLow: 120_000,
    compHigh: 300_000,
  });
});

test("comp in text: 'between' ranges with and without space after dollar sign", () => {
  assert.deepEqual(compInText("expected to be between $150,000 and $250,000/year"), {
    compLow: 150_000,
    compHigh: 250_000,
  });
  assert.deepEqual(compInText("between $ 140,000 and $230,000/year"), {
    compLow: 140_000,
    compHigh: 230_000,
  });
});

test("comp in text: bare 'and' without 'between' does not form a range", () => {
  assert.equal(compInText("a $1,500 home office stipend and $3,000 learning budget"), null);
});

test("comp in text: a K-suffixed bonus still loses to base pay, and small figures stay out", () => {
  assert.deepEqual(compInText("Signing bonus $5K - $10K. Base $220,000 - $300,000."), {
    compLow: 220_000,
    compHigh: 300_000,
  });
  assert.equal(compInText("$80-$100/hr for the 180 day period"), null);
  assert.equal(compInText("$5 - $10"), null);
});

test("SmartRecruiters: a listing entry carries no body or comp", () => {
  const listings = parseSmartRecruitersListing(fixture("smartrecruiters-listing.json"));
  assert.ok(listings.length >= 2);
  for (const listing of listings) {
    assert.equal(listing.body, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.ok(listing.title !== null);
  }
});

test("SmartRecruiters: a detail response with a stated pay range parses it", () => {
  const listing = parseSmartRecruitersDetail(fixture("smartrecruiters-detail-with-comp.json"));
  assert.equal(listing.id, "700000000000101");
  assert.equal(listing.title, "Principal Software Engineer - Service Catalogue");
  // Stated in `additionalInformation` with an en dash, above a lower
  // relocation range written with a hyphen.
  assert.equal(listing.compLow, 214_000);
  assert.equal(listing.compHigh, 286_000);
  assert.ok(listing.body !== null && listing.body.length > 0);
  // location.remote is false here (hybrid is true instead): only `remote`
  // is read, so this reads as no stated workplace, not hybrid.
  assert.equal(listing.workplace, null);
});

test("SmartRecruiters: a detail response with no stated pay leaves comp absent", () => {
  const listing = parseSmartRecruitersDetail(fixture("smartrecruiters-detail-no-comp.json"));
  assert.equal(listing.id, "700000000000202");
  assert.equal(listing.title, "Director, Data & Analytics Partnerships");
  assert.equal(listing.compLow, null);
  assert.equal(listing.compHigh, null);
  assert.equal(listing.workplace, "remote");
});

test("SmartRecruiters: location.remote true becomes the board's own workplace word in a listing entry", () => {
  const listings = parseSmartRecruitersListing(fixture("smartrecruiters-listing.json"));
  const remote = listings.find((listing) => listing.id === "700000000000202");
  assert.equal(remote?.workplace, "remote");
  const hybridOnly = listings.find((listing) => listing.id === "700000000000101");
  assert.equal(hybridOnly?.workplace, null);
});

// The listing and the two details are one board's responses: both detail
// documents are entries in the listing, and a reader following `ref` from an
// entry arrives at the detail with the same id.
test("SmartRecruiters: the listing entries and the two detail responses carry the same ids", () => {
  const entries = parseSmartRecruitersListing(fixture("smartrecruiters-listing.json"));
  const withComp = parseSmartRecruitersDetail(fixture("smartrecruiters-detail-with-comp.json"));
  const noComp = parseSmartRecruitersDetail(fixture("smartrecruiters-detail-no-comp.json"));

  for (const detail of [withComp, noComp]) {
    const entry = entries.find((listing) => listing.id === detail.id);
    assert.ok(entry, `no listing entry for ${detail.id}`);
    assert.equal(entry?.title, detail.title);
    assert.equal(entry?.location, detail.location);
    assert.equal(entry?.workplace, detail.workplace);
    assert.equal(
      entry?.url,
      `https://api.smartrecruiters.com/v1/companies/Woodgrove/postings/${detail.id}`,
    );
  }
});
