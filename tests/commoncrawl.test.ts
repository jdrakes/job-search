import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { commonCrawlSource, latestIndex, parseIndexPage } from "../src/discovery/commoncrawl.ts";

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

// Breaks if decodeURIComponent in parseIndexPage leaves its try/catch: the
// URIError from %E0%A4 would escape and fail the whole source.
test("parseIndexPage: a url whose board segment is malformed percent-encoding is skipped, not thrown on", () => {
  const body = [
    JSON.stringify({ url: "https://jobs.lever.co/%E0%A4/x" }),
    JSON.stringify({ url: "https://jobs.lever.co/trey-research/abc" }),
  ].join("\n");
  assert.deepEqual(parseIndexPage(body, "jobs.lever.co"), ["trey-research"]);
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

// A fake index where a named URL answers 404 rather than its body. A 404 is
// never retried, so each failure is one request. `pageCounts` gives
// showNumPages per host; a host not named has one page.
function failingCrawlFetch(
  pages: Record<string, string>,
  failing: readonly string[],
  pageCounts: Record<string, number> = {},
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (failing.includes(url)) return new Response("Not Found", { status: 404 });
    if (url === "https://index.commoncrawl.org/collinfo.json") {
      return new Response(fixture("collinfo.json"), { status: 200 });
    }
    if (url.includes("showNumPages=true")) {
      const host = /\?url=([^/]+)\//.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify({ pages: pageCounts[host] ?? 1 }), { status: 200 });
    }
    const body = pages[url];
    if (body === undefined) throw new Error(`unexpected request: ${url}`);
    return new Response(body, { status: 200 });
  };
}

function numPagesUrl(host: string): string {
  return `${INDEX_URL}?url=${host}/*&output=json&showNumPages=true`;
}

function pageUrl(host: string, page: number): string {
  return `${INDEX_URL}?url=${host}/*&output=json&fl=url&page=${page}`;
}

// One distinct board per host, so each host's contribution is visible.
const ONE_BOARD_PER_HOST: Record<string, string> = {
  [pageUrl("jobs.ashbyhq.com", 0)]: indexPage("https://jobs.ashbyhq.com/alpha"),
  [pageUrl("job-boards.greenhouse.io", 0)]: indexPage("https://job-boards.greenhouse.io/beta"),
  [pageUrl("boards.greenhouse.io", 0)]: indexPage("https://boards.greenhouse.io/gamma"),
  [pageUrl("jobs.lever.co", 0)]: indexPage("https://jobs.lever.co/delta"),
};

// Breaks if a showNumPages failure propagates out of boards() again, or if
// the failed host is not logged.
test("boards(): one host's showNumPages failing is one log line and the other hosts' boards are kept", async () => {
  const fetchImpl = failingCrawlFetch(ONE_BOARD_PER_HOST, [
    numPagesUrl("job-boards.greenhouse.io"),
  ]);
  const lines: string[] = [];

  const boards = await commonCrawlSource.boards(
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    (line) => lines.push(line),
  );

  assert.deepEqual(boards, [
    { platform: "ashby", id: "alpha" },
    { platform: "greenhouse", id: "gamma" },
    { platform: "lever", id: "delta" },
  ]);
  assert.deepEqual(lines, ["commoncrawl: host unreachable job-boards.greenhouse.io: HTTP 404"]);
});

// Breaks if a page failure propagates out of boards(), if the host's earlier
// pages are discarded, or if the walk `continue`s to page 2 instead of
// ending that host (page 2 is not in the fake, so asking it throws).
test("boards(): a host's second page failing keeps its first page and every other host, and ends that host's walk", async () => {
  const fetchImpl = failingCrawlFetch(ONE_BOARD_PER_HOST, [pageUrl("jobs.lever.co", 1)], {
    "jobs.lever.co": 3,
  });
  const lines: string[] = [];

  const boards = await commonCrawlSource.boards(
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    (line) => lines.push(line),
  );

  assert.deepEqual(boards, [
    { platform: "ashby", id: "alpha" },
    { platform: "greenhouse", id: "beta" },
    { platform: "greenhouse", id: "gamma" },
    { platform: "lever", id: "delta" },
  ]);
  assert.deepEqual(lines, ["commoncrawl: page unreachable jobs.lever.co page 1: HTTP 404"]);
});

// Breaks if a total failure is swallowed into an empty list instead of the
// shape error discover reports.
test("boards(): every host failing still throws the no-board error", async () => {
  const fetchImpl = failingCrawlFetch({}, [
    numPagesUrl("jobs.ashbyhq.com"),
    numPagesUrl("job-boards.greenhouse.io"),
    numPagesUrl("boards.greenhouse.io"),
    numPagesUrl("jobs.lever.co"),
  ]);
  const lines: string[] = [];

  await assert.rejects(
    () =>
      commonCrawlSource.boards({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, (line) =>
        lines.push(line),
      ),
    /no board parsed from the index: its answer shape has changed/,
  );
  assert.equal(lines.length, 4);
});

// Breaks if the collinfo.json fetch is wrapped like the per-host ones.
test("boards(): collinfo.json failing to fetch throws", async () => {
  const fetchImpl = failingCrawlFetch(ONE_BOARD_PER_HOST, [
    "https://index.commoncrawl.org/collinfo.json",
  ]);

  await assert.rejects(
    () => commonCrawlSource.boards({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }),
    /HTTP 404/,
  );
});

test("commonCrawlSource: named commoncrawl", () => {
  assert.equal(commonCrawlSource.name, "commoncrawl");
});
