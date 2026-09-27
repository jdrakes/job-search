import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  commonCrawlSource,
  latestIndex,
  pageTitle,
  parseIndexPage,
} from "../src/discovery/commoncrawl.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/commoncrawl/${name}`, import.meta.url), "utf8");
}

const noSleep = async () => {};
const TEST_USER_AGENT = "test-bot (+https://example.com)";
const INDEX_URL = "https://index.commoncrawl.org/CC-MAIN-2026-39-index";

test("latestIndex: reads the newest crawl's cdx-api off collinfo.json", () => {
  const collections: unknown = JSON.parse(fixture("collinfo.json"));
  assert.equal(latestIndex(collections), INDEX_URL);
});

test("latestIndex: an empty or malformed list names no index", () => {
  assert.equal(latestIndex([]), null);
  assert.equal(latestIndex("not an array"), null);
  assert.equal(latestIndex([{ "cdx-api": 42 }]), null);
});

test("parseIndexPage: returns a board id per captured url on the given host, skipping embed and other hosts", () => {
  const ids = parseIndexPage(fixture("ashby-index.jsonl"), "jobs.ashbyhq.com");

  // The embed url and the url on a different host are both dropped; the
  // board ids on jobs.ashbyhq.com come through.
  assert.ok(!ids.includes("embed"));
  assert.ok(ids.includes("proseware"));
  assert.ok(ids.includes("wingtip-toys"));
  assert.ok(ids.includes("thyme-care"));
  // Only jobs.ashbyhq.com urls counted, not the off-host thyme-care line.
  assert.equal(ids.filter((id) => id === "thyme-care").length, 1);
});

test("parseIndexPage: a line that fails to parse, or carries no url, is skipped rather than thrown on", () => {
  const ids = parseIndexPage(fixture("greenhouse-index.jsonl"), "boards.greenhouse.io");
  assert.ok(!ids.includes("v1"));
  assert.ok(!ids.includes("api"));
  assert.ok(ids.includes("contoso"));
  assert.ok(ids.includes("proseware"));
});

test("pageTitle: an Ashby page's title loses its ' Jobs' suffix", () => {
  assert.equal(pageTitle(fixture("ashby-thyme-care-head.html"), "ashby"), "Thyme Care");
});

test("pageTitle: a Lever page's title is the company name as written, no suffix stripped", () => {
  assert.equal(pageTitle(fixture("lever-trey-research-head.html"), "lever"), "Trey Research");
});

test("pageTitle: no <title> tag reads as no name, not a throw", () => {
  assert.equal(pageTitle("<head><meta charset='utf-8'></head>", "ashby"), null);
});

// A small, hand-built index page per host: one host answers a lowercase
// Greenhouse slug, a second answers the same slug uppercase (proving the
// lowercasing and the cross-host dedupe together), and Lever answers a
// mixed-case id twice under different casing (proving Lever's spelling is
// kept and the second occurrence still dedupes).
function indexPage(...urls: string[]): string {
  return urls.map((url) => JSON.stringify({ url })).join("\n");
}

function fakeCrawlFetch(pages: Record<string, string>): typeof fetch {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://index.commoncrawl.org/collinfo.json") {
      return new Response(fixture("collinfo.json"), { status: 200 });
    }
    if (url.includes("showNumPages=true")) {
      return new Response(JSON.stringify({ pages: 1 }), { status: 200 });
    }
    const body = pages[url];
    if (body === undefined) throw new Error(`unexpected request: ${url}`);
    return new Response(body, { status: 200 });
  };
  (fetchImpl as unknown as { requested: string[] }).requested = requested;
  return fetchImpl;
}

test("boards(): asks showNumPages then each page per host, lowercases Greenhouse ids, keeps Lever case, dedupes", async () => {
  const ashbyPage = `${INDEX_URL}?url=jobs.ashbyhq.com/*&output=json&fl=url&page=0`;
  const jobBoardsPage = `${INDEX_URL}?url=job-boards.greenhouse.io/*&output=json&fl=url&page=0`;
  const boardsGreenhousePage = `${INDEX_URL}?url=boards.greenhouse.io/*&output=json&fl=url&page=0`;
  const leverPage = `${INDEX_URL}?url=jobs.lever.co/*&output=json&fl=url&page=0`;

  const fetchImpl = fakeCrawlFetch({
    [ashbyPage]: indexPage("https://jobs.ashbyhq.com/acme", "https://jobs.ashbyhq.com/embed/acme"),
    [jobBoardsPage]: indexPage("https://job-boards.greenhouse.io/ACME/jobs/1"),
    [boardsGreenhousePage]: indexPage("https://boards.greenhouse.io/acme/jobs/2"),
    [leverPage]: indexPage("https://jobs.lever.co/Acme/aaa", "https://jobs.lever.co/ACME/bbb"),
  });

  const boards = await commonCrawlSource.boards({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  const requested = (fetchImpl as unknown as { requested: string[] }).requested;
  // showNumPages is asked before the page it gates, for every host in
  // HOSTS order.
  assert.ok(
    requested.indexOf(`${INDEX_URL}?url=jobs.ashbyhq.com/*&output=json&showNumPages=true`) <
      requested.indexOf(ashbyPage),
  );
  assert.deepEqual(requested, [
    "https://index.commoncrawl.org/collinfo.json",
    `${INDEX_URL}?url=jobs.ashbyhq.com/*&output=json&showNumPages=true`,
    ashbyPage,
    `${INDEX_URL}?url=job-boards.greenhouse.io/*&output=json&showNumPages=true`,
    jobBoardsPage,
    `${INDEX_URL}?url=boards.greenhouse.io/*&output=json&showNumPages=true`,
    boardsGreenhousePage,
    `${INDEX_URL}?url=jobs.lever.co/*&output=json&showNumPages=true`,
    leverPage,
  ]);

  assert.deepEqual(boards, [
    { platform: "ashby", id: "acme" },
    { platform: "greenhouse", id: "acme" },
    // boards.greenhouse.io's "acme" is the same key as job-boards.greenhouse.io's
    // lowercased "ACME", so it does not appear a second time.
    { platform: "lever", id: "Acme" },
    // jobs.lever.co/ACME/bbb dedupes against jobs.lever.co/Acme/aaa
    // case-insensitively, keeping the first spelling.
  ]);
});

test("boards(): every host answering empty throws, naming the shape as the suspect", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://index.commoncrawl.org/collinfo.json") {
      return new Response(fixture("collinfo.json"), { status: 200 });
    }
    if (url.includes("showNumPages=true")) {
      return new Response(JSON.stringify({ pages: 1 }), { status: 200 });
    }
    return new Response("", { status: 200 });
  };

  await assert.rejects(
    () => commonCrawlSource.boards({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no board parsed from the index/);
      return true;
    },
  );
});

test("boards(): collinfo.json naming no crawl index throws before any host is asked", async () => {
  const fetchImpl: typeof fetch = async () => new Response("[]", { status: 200 });

  await assert.rejects(
    () => commonCrawlSource.boards({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /collinfo\.json names no crawl index/);
      return true;
    },
  );
});

test("companyName(): a Greenhouse board reads the boards-api's name", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://boards-api.greenhouse.io/v1/boards/contoso");
    return new Response(fixture("greenhouse-board-contoso.json"), { status: 200 });
  };

  const name = await commonCrawlSource.companyName(
    { platform: "greenhouse", id: "contoso" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
  );
  assert.equal(name, "Contoso");
});

test("companyName(): a 404 is an expected failure, read as no name rather than thrown", async () => {
  const fetchImpl: typeof fetch = async () => new Response("Not Found", { status: 404 });

  const name = await commonCrawlSource.companyName(
    { platform: "greenhouse", id: "does-not-exist" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep, retries: 0 },
  );
  assert.equal(name, null);
});

test("companyName(): an Ashby board reads the page title, ' Jobs' stripped", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://jobs.ashbyhq.com/thyme-care");
    return new Response(fixture("ashby-thyme-care-head.html"), { status: 200 });
  };

  const name = await commonCrawlSource.companyName(
    { platform: "ashby", id: "thyme-care" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
  );
  assert.equal(name, "Thyme Care");
});

test("companyName(): a Lever board reads the page title as written", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), "https://jobs.lever.co/trey-research");
    return new Response(fixture("lever-trey-research-head.html"), { status: 200 });
  };

  const name = await commonCrawlSource.companyName(
    { platform: "lever", id: "trey-research" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
  );
  assert.equal(name, "Trey Research");
});

test("companyName(): an unrecognized platform reads as no name", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("should not be called");
  };

  const name = await commonCrawlSource.companyName(
    { platform: "workday", id: "acme" },
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
  );
  assert.equal(name, null);
});

test("companyName(): a non-HttpError failure is not swallowed", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(() =>
    commonCrawlSource.companyName(
      { platform: "greenhouse", id: "acme" },
      { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep, retries: 0 },
    ),
  );
});

test("commonCrawlSource: named commoncrawl", () => {
  assert.equal(commonCrawlSource.name, "commoncrawl");
});
