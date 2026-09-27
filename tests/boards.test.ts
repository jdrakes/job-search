import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { boardName, boardUrl, pageTitle, parseBoardUrl } from "../src/discovery/boards.ts";
import type { Board } from "../src/schema.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/commoncrawl/${name}`, import.meta.url), "utf8");
}

const TEST_USER_AGENT = "test-bot (+https://example.com)";

// --- parseBoardUrl: one board URL and one posting URL per platform -------

test("parseBoardUrl: Greenhouse's board page and a posting under job-boards both name the board, lowercased", () => {
  assert.deepEqual(parseBoardUrl("https://boards.greenhouse.io/Contoso"), {
    platform: "greenhouse",
    id: "contoso",
  });
  assert.deepEqual(parseBoardUrl("https://job-boards.greenhouse.io/contoso/jobs/123456"), {
    platform: "greenhouse",
    id: "contoso",
  });
});

test("parseBoardUrl: Ashby's board page and a posting under it both name the board", () => {
  assert.deepEqual(parseBoardUrl("https://jobs.ashbyhq.com/thyme-care"), {
    platform: "ashby",
    id: "thyme-care",
  });
  assert.deepEqual(parseBoardUrl("https://jobs.ashbyhq.com/thyme-care/abc-123-def"), {
    platform: "ashby",
    id: "thyme-care",
  });
});

test("parseBoardUrl: Lever's board page and a posting under it both name the board, case kept", () => {
  assert.deepEqual(parseBoardUrl("https://jobs.lever.co/Trey-Research"), {
    platform: "lever",
    id: "Trey-Research",
  });
  assert.deepEqual(parseBoardUrl("https://jobs.lever.co/Trey-Research/abcd1234"), {
    platform: "lever",
    id: "Trey-Research",
  });
});

test("parseBoardUrl: a Workday site page and a posting under it both give wd/site/tenant", () => {
  assert.deepEqual(parseBoardUrl("https://fabrikam.wd5.myworkdayjobs.com/Fabrikam_Careers"), {
    platform: "workday",
    id: "wd5/Fabrikam_Careers/fabrikam",
  });
  assert.deepEqual(
    parseBoardUrl(
      "https://fabrikam.wd5.myworkdayjobs.com/Fabrikam_Careers/job/Springfield-Illinois-US/Principal-Software-Engineer_4400102",
    ),
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  );
});

test("parseBoardUrl: a Workday URL with a locale segment skips it to find the site", () => {
  assert.deepEqual(
    parseBoardUrl("https://fabrikam.wd5.myworkdayjobs.com/en-US/Fabrikam_Careers/job/x"),
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  );
});

test("parseBoardUrl: an Eightfold board's own host and a posting page under it both name the host as the board", () => {
  assert.deepEqual(parseBoardUrl("https://contoso.eightfold.ai/careers"), {
    platform: "eightfold",
    id: "contoso.eightfold.ai",
  });
  assert.deepEqual(parseBoardUrl("https://contoso.eightfold.ai/careers/job/12345"), {
    platform: "eightfold",
    id: "contoso.eightfold.ai",
  });
});

test("parseBoardUrl: an iCIMS board's jibeapply host and a posting under it both give the slug", () => {
  assert.deepEqual(parseBoardUrl("https://contoso.jibeapply.com/jobs"), {
    platform: "icims",
    id: "contoso",
  });
  assert.deepEqual(parseBoardUrl("https://contoso.jibeapply.com/jobs/98765"), {
    platform: "icims",
    id: "contoso",
  });
});

// --- boardUrl round-trips through parseBoardUrl ---------------------------

const ROUND_TRIP_BOARDS: readonly Board[] = [
  { platform: "greenhouse", id: "contoso" },
  { platform: "ashby", id: "thyme-care" },
  { platform: "lever", id: "Trey-Research" },
  { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  { platform: "eightfold", id: "contoso.eightfold.ai" },
  { platform: "icims", id: "contoso" },
];

for (const board of ROUND_TRIP_BOARDS) {
  test(`boardUrl: ${board.platform} round-trips through parseBoardUrl`, () => {
    assert.deepEqual(parseBoardUrl(boardUrl(board)), board);
  });
}

test("boardUrl: an unsupported platform throws rather than guessing a URL", () => {
  assert.throws(() => boardUrl({ platform: "amazon", id: "acme" }));
});

// --- null cases ------------------------------------------------------------

test("parseBoardUrl: a company's own careers domain names no board, even with a gh_jid or ashby_jid query", () => {
  assert.equal(parseBoardUrl("https://careers.contoso.com/?gh_jid=123456"), null);
  assert.equal(parseBoardUrl("https://contoso.com/careers?ashby_jid=abcdef"), null);
});

test("parseBoardUrl: a non-URL string gives null rather than throwing", () => {
  assert.equal(parseBoardUrl("not a url"), null);
  assert.equal(parseBoardUrl(""), null);
});

test("parseBoardUrl: an unknown host gives null", () => {
  assert.equal(parseBoardUrl("https://example.com/jobs"), null);
});

test("parseBoardUrl: a Workday host with no site segment gives null", () => {
  assert.equal(parseBoardUrl("https://fabrikam.wd5.myworkdayjobs.com/"), null);
});

// --- pageTitle (moved from commoncrawl.ts) ---------------------------------

test("pageTitle: an Ashby page's title loses its ' Jobs' suffix", () => {
  assert.equal(pageTitle(fixture("ashby-thyme-care-head.html"), "ashby"), "Thyme Care");
});

test("pageTitle: a Lever page's title is the company name as written, no suffix stripped", () => {
  assert.equal(pageTitle(fixture("lever-trey-research-head.html"), "lever"), "Trey Research");
});

test("pageTitle: no <title> tag reads as no name, not a throw", () => {
  assert.equal(pageTitle("<head><meta charset='utf-8'></head>", "ashby"), null);
});

// --- boardName ---------------------------------------------------------

test("boardName: a Greenhouse board reads the boards-api's name", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://boards-api.greenhouse.io/v1/boards/contoso");
    return new Response(fixture("greenhouse-board-contoso.json"), { status: 200 });
  };

  const name = await boardName(
    { platform: "greenhouse", id: "contoso" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );
  assert.equal(name, "Contoso");
});

test("boardName: an Ashby board reads the page title, ' Jobs' stripped", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://jobs.ashbyhq.com/thyme-care");
    return new Response(fixture("ashby-thyme-care-head.html"), { status: 200 });
  };

  const name = await boardName(
    { platform: "ashby", id: "thyme-care" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );
  assert.equal(name, "Thyme Care");
});

test("boardName: a Lever board reads the page title as written", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://jobs.lever.co/trey-research");
    return new Response(fixture("lever-trey-research-head.html"), { status: 200 });
  };

  const name = await boardName(
    { platform: "lever", id: "trey-research" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );
  assert.equal(name, "Trey Research");
});

test("boardName: a platform with no page to read gives no name", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("should not be called");
  };

  const name = await boardName(
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );
  assert.equal(name, null);
});

test("boardName: a 404 is an expected failure, read as no name rather than thrown", async () => {
  const fetchImpl: typeof fetch = async () => new Response("Not Found", { status: 404 });

  const name = await boardName(
    { platform: "greenhouse", id: "does-not-exist" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {}, retries: 0 },
  );
  assert.equal(name, null);
});

test("boardName: a non-HttpError failure is not swallowed", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(() =>
    boardName(
      { platform: "greenhouse", id: "acme" },
      { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {}, retries: 0 },
    ),
  );
});
