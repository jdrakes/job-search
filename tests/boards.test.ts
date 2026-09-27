import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  avatureSiteName,
  boardName,
  boardUrl,
  pageTitle,
  parseBoardUrl,
  readBoardName,
} from "../src/discovery/boards.ts";
import { HttpError } from "../src/net/http.ts";
import { PLATFORMS, type Board } from "../src/schema.ts";

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

test("parseBoardUrl: Greenhouse's embed forms name the board in the `for` parameter, never `embed`", () => {
  assert.deepEqual(
    parseBoardUrl("https://boards.greenhouse.io/embed/job_app?for=Contoso&token=123456"),
    {
      platform: "greenhouse",
      id: "contoso",
    },
  );
  assert.deepEqual(parseBoardUrl("https://boards.greenhouse.io/embed/job_board?for=contoso"), {
    platform: "greenhouse",
    id: "contoso",
  });
});

test("parseBoardUrl: a myworkdaysite URL gives the same wd/site/tenant as the tenant's myworkdayjobs host", () => {
  assert.deepEqual(
    parseBoardUrl("https://wd5.myworkdaysite.com/en-US/recruiting/fabrikam/Fabrikam_Careers"),
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  );
  assert.deepEqual(
    parseBoardUrl(
      "https://wd5.myworkdaysite.com/recruiting/fabrikam/Fabrikam_Careers/job/Springfield-Illinois-US/Staff-Engineer_R1234",
    ),
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  );
});

// Each row: a board page and a posting under it, copied the way a person
// copies them, and the id that platform's reader in src/ats/ reads.
const BOARD_AND_POSTING_URLS: ReadonlyArray<readonly [string, string, Board]> = [
  [
    "https://careers.smartrecruiters.com/Acme",
    "https://jobs.smartrecruiters.com/Acme/744000012345678-staff-engineer",
    { platform: "smartrecruiters", id: "Acme" },
  ],
  [
    "https://jobs.jobvite.com/acme/jobs",
    "https://jobs.jobvite.com/acme/job/oAbC123x",
    { platform: "jobvite", id: "acme" },
  ],
  [
    "https://ats.rippling.com/acme/jobs",
    "https://ats.rippling.com/acme/jobs/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    { platform: "rippling", id: "acme" },
  ],
  [
    "https://apply.workable.com/acme/",
    "https://apply.workable.com/acme/j/1A2B3C4D5E/",
    { platform: "workable", id: "acme" },
  ],
  [
    "https://acme.bamboohr.com/careers",
    "https://acme.bamboohr.com/careers/42",
    { platform: "bamboohr", id: "acme" },
  ],
  [
    "https://acme.breezy.hr/",
    "https://acme.breezy.hr/p/1a2b3c4d5e6f-staff-engineer",
    { platform: "breezy", id: "acme" },
  ],
  [
    "https://acme.applytojob.com/apply",
    "https://acme.applytojob.com/apply/AbCdEf1234/Staff-Engineer",
    { platform: "jazzhr", id: "acme" },
  ],
  [
    "https://acme.recruitee.com/",
    "https://acme.recruitee.com/o/staff-engineer",
    { platform: "recruitee", id: "acme" },
  ],
  [
    "https://acme.hrmdirect.com/employment/job-openings.php?search=true",
    "https://acme.hrmdirect.com/employment/job-opening.php?req=123456&req_loc=7890",
    { platform: "hrmdirect", id: "acme" },
  ],
  [
    "https://acme.avature.net/careers",
    "https://acme.avature.net/en_US/careers/JobDetail/Staff-Engineer/1234",
    { platform: "avature", id: "acme" },
  ],
  [
    "https://acme.jobs.personio.de/",
    "https://acme.jobs.personio.de/job/123456?display=en",
    { platform: "personio", id: "acme.jobs.personio.de" },
  ],
  [
    "https://acme.jobs.personio.com/",
    "https://acme.jobs.personio.com/job/123456",
    { platform: "personio", id: "acme.jobs.personio.com" },
  ],
  [
    "https://www.amazon.jobs/en/",
    "https://www.amazon.jobs/en/jobs/81000101/sr-software-dev-engineer",
    { platform: "amazon", id: "amazon" },
  ],
];

for (const [board, posting, expected] of BOARD_AND_POSTING_URLS) {
  test(`parseBoardUrl: ${expected.id} on ${expected.platform}, board page and posting both name the board`, () => {
    assert.deepEqual(parseBoardUrl(board), expected);
    assert.deepEqual(parseBoardUrl(posting), expected);
  });
}

// --- boardUrl round-trips through parseBoardUrl ---------------------------

const ROUND_TRIP_BOARDS: readonly Board[] = [
  { platform: "greenhouse", id: "contoso" },
  { platform: "ashby", id: "thyme-care" },
  { platform: "lever", id: "Trey-Research" },
  { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
  { platform: "eightfold", id: "contoso.eightfold.ai" },
  { platform: "icims", id: "contoso" },
  { platform: "smartrecruiters", id: "Acme" },
  { platform: "jobvite", id: "acme" },
  { platform: "rippling", id: "acme" },
  { platform: "workable", id: "acme" },
  { platform: "bamboohr", id: "acme" },
  { platform: "breezy", id: "acme" },
  { platform: "jazzhr", id: "acme" },
  { platform: "recruitee", id: "acme" },
  { platform: "hrmdirect", id: "acme" },
  { platform: "avature", id: "acme" },
  { platform: "personio", id: "acme.jobs.personio.de" },
  { platform: "amazon", id: "amazon" },
];

for (const board of ROUND_TRIP_BOARDS) {
  test(`boardUrl: ${board.platform} round-trips through parseBoardUrl`, () => {
    assert.deepEqual(parseBoardUrl(boardUrl(board)), board);
  });
}

test("boardUrl: the round-trip list covers every platform in PLATFORMS", () => {
  assert.deepEqual(new Set(ROUND_TRIP_BOARDS.map((board) => board.platform)), new Set(PLATFORMS));
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

test("parseBoardUrl: Eightfold's shared app host names no board", () => {
  assert.equal(parseBoardUrl("https://app.eightfold.ai/careers?domain=contoso.com"), null);
});

test("parseBoardUrl: a company's own careers host names no board, even when Eightfold serves it", () => {
  assert.equal(parseBoardUrl("https://careers.contoso.com/careers/job/12345"), null);
});

test("parseBoardUrl: a Workable /j/ posting URL names no account", () => {
  assert.equal(parseBoardUrl("https://apply.workable.com/j/1A2B3C4D5E"), null);
});

test("parseBoardUrl: a vendor's own www host names no board", () => {
  assert.equal(parseBoardUrl("https://www.bamboohr.com/careers"), null);
});

test("parseBoardUrl: a Greenhouse embed URL with no `for` names no board", () => {
  assert.equal(parseBoardUrl("https://boards.greenhouse.io/embed/job_board"), null);
});

test("parseBoardUrl: a myworkdaysite URL outside /recruiting/ names no board", () => {
  assert.equal(parseBoardUrl("https://wd5.myworkdaysite.com/en-US/"), null);
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

// Fixture: a live SearchJobs page; its og:site_name is "Bloomberg", its
// <title> "Bloomberg Careers".
test("boardName: an Avature board reads the SearchJobs page's og:site_name", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://bloomberg.avature.net/careers/SearchJobs");
    return new Response(
      readFileSync(new URL("./fixtures/avature-search-bloomberg.html", import.meta.url), "utf8"),
      { status: 200 },
    );
  };

  const name = await boardName(
    { platform: "avature", id: "bloomberg" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {} },
  );
  assert.equal(name, "Bloomberg");
});

test("avatureSiteName: entities in the tag are decoded", () => {
  assert.equal(
    avatureSiteName('<meta property="og:site_name" content="Fabrikam &amp; Sons" />'),
    "Fabrikam & Sons",
  );
});

test("avatureSiteName: a page with no og:site_name, or an empty one, names nobody", () => {
  assert.equal(avatureSiteName("<title>Fabrikam Careers</title>"), null);
  assert.equal(avatureSiteName('<meta property="og:site_name" content="" />'), null);
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

// A 429 is the vendor declining to answer, not the page naming nobody; the
// name is asked for again next run.
test("boardName: a 429 is thrown, not read as no name", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 429 });

  await assert.rejects(
    () =>
      boardName(
        { platform: "lever", id: "acme" },
        { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {}, retries: 0 },
      ),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
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

// --- readBoardName -----------------------------------------------------

// The probe's read: a page that did not answer is not a page naming nobody.
// Breaks if readBoardName catches HttpError the way boardName does.
for (const status of [403, 404, 503]) {
  test(`readBoardName: a ${status} on the name page is thrown, not read as no name`, async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status });

    await assert.rejects(
      () =>
        readBoardName(
          { platform: "ashby", id: "acme" },
          { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {}, retries: 0 },
        ),
      (error: unknown) => error instanceof HttpError && error.status === status,
    );
  });
}

test("readBoardName: a page that loads with no title names nobody", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("<html><head><meta charset='utf-8'></head></html>", { status: 200 });

  const name = await readBoardName(
    { platform: "lever", id: "acme" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: async () => {}, retries: 0 },
  );
  assert.equal(name, null);
});
