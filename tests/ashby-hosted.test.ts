import { test } from "node:test";
import assert from "node:assert/strict";

import { ashbyReader, parseHostedBoard } from "../src/ats/ashby.ts";
import { isGone } from "../src/companies.ts";

// Written from the hosted board's GraphQL reply, not captured: the envelope
// and field names are Ashby's, while the company, ids and titles are
// invented.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

const BOARD = {
  data: {
    jobBoard: {
      jobPostings: [
        {
          id: "p-1",
          title: "Staff Software Engineer, Payments",
          locationName: "San Francisco, CA",
          workplaceType: "Remote",
          compensationTierSummary: "$190K – $270K • Offers Equity",
        },
        {
          id: "p-2",
          title: "Account Executive, UK",
          locationName: "London, UK",
          workplaceType: "Hybrid",
          compensationTierSummary: null,
        },
        { title: "No id" },
      ],
    },
  },
};

// Answers each request by its GraphQL operation (the text after `?op=`), or
// "posting-api" for the public API; records every operation asked.
function fakeFetch(routes: Record<string, () => Response>): {
  options: { fetchImpl: typeof fetch; sleep: () => Promise<void>; userAgent: string };
  requests: string[];
} {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    const op = url.includes("?op=") ? url.split("?op=")[1]! : "posting-api";
    requests.push(op);
    const route = routes[op];
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    return route();
  };
  return {
    options: { fetchImpl, sleep: async () => {}, userAgent: TEST_USER_AGENT },
    requests,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Breaks if a field is misread, the summary's band is lost, or a posting
// with no id becomes a listing.
test("parseHostedBoard: each posting with an id, its band from the summary, no body or date", () => {
  assert.deepEqual(parseHostedBoard(BOARD, "contoso"), [
    {
      id: "p-1",
      title: "Staff Software Engineer, Payments",
      url: "https://jobs.ashbyhq.com/contoso/p-1",
      location: "San Francisco, CA",
      compLow: 190_000,
      compHigh: 270_000,
      postedAt: null,
      body: null,
      workplace: "remote",
      requisitionId: null,
    },
    {
      id: "p-2",
      title: "Account Executive, UK",
      url: "https://jobs.ashbyhq.com/contoso/p-2",
      location: "London, UK",
      compLow: null,
      compHigh: null,
      postedAt: null,
      body: null,
      workplace: "hybrid",
      requisitionId: null,
    },
  ]);
});

test("parseHostedBoard: null for a board the hosted page lacks, a throw for a reply with no data", () => {
  assert.equal(parseHostedBoard({ data: { jobBoard: null } }, "contoso"), null);
  assert.throws(() => parseHostedBoard({ errors: [{ message: "bad" }] }, "contoso"));
});

// Breaks if a board whose public API is off is reported gone while its
// hosted page still lists postings, or if the fallback reads per posting.
test("ashbyReader: a public-API 404 with a live hosted board reads its list in one request", async () => {
  const { options, requests } = fakeFetch({
    "posting-api": () => json({}, 404),
    ApiJobBoardWithTeams: () => json(BOARD),
  });

  const listings = await ashbyReader.list({ platform: "ashby", id: "contoso" }, options);

  assert.deepEqual(
    listings.map((listing) => listing.id),
    ["p-1", "p-2"],
  );
  assert.deepEqual(requests, ["posting-api", "ApiJobBoardWithTeams"]);
});

// Breaks if a board that is gone everywhere stops reading as gone.
test("ashbyReader: a public-API 404 with no hosted board keeps the 404, so the board is gone", async () => {
  const { options } = fakeFetch({
    "posting-api": () => json({}, 404),
    ApiJobBoardWithTeams: () => json({ data: { jobBoard: null } }),
  });

  await assert.rejects(ashbyReader.list({ platform: "ashby", id: "vanished" }, options), (err) =>
    isGone("ashby", err),
  );
});

// Breaks if the fallback fires on a board the public API reads.
test("ashbyReader: a board the public API reads asks nothing of the hosted page", async () => {
  const { options, requests } = fakeFetch({
    "posting-api": () => json({ jobs: [{ id: "j-1", title: "Engineer" }] }),
  });

  const listings = await ashbyReader.list({ platform: "ashby", id: "contoso" }, options);

  assert.deepEqual(
    listings.map((listing) => listing.id),
    ["j-1"],
  );
  assert.deepEqual(requests, ["posting-api"]);
});
