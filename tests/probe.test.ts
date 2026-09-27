import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { casedSlugsFor, namesMatch, probe, slugsFor } from "../src/discovery/probe.ts";
import { HttpError } from "../src/net/http.ts";

// Anything not listed answers 404, as Greenhouse/Ashby/Lever do for a slug
// that does not exist. A string route is served as raw HTML (for
// Jobvite/Avature/JazzHR/HRMDirect), anything else JSON-encoded.
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) return new Response(null, { status: 404 });
    return typeof body === "string"
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
  return impl;
}

const noSleep = async () => {};

function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

// http.ts requires a configured User-Agent now that it no longer carries a
// built-in one (src/net/http.ts); these tests fake the network entirely, so
// any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

test("slugsFor: 'The Voleon Group' produces 'voleon' among its slugs", () => {
  assert.ok(slugsFor("The Voleon Group").includes("voleon"));
});

test("slugsFor: a plain one-word name produces itself without duplicates", () => {
  assert.deepEqual(slugsFor("Gitlab"), ["gitlab"]);
});

test("slugsFor: a cased name yields only its lowercase form", () => {
  assert.deepEqual(slugsFor("BlueMatrix"), ["bluematrix"]);
});

test("casedSlugsFor: a cased name yields the name's own casing", () => {
  assert.deepEqual(casedSlugsFor("BlueMatrix"), ["BlueMatrix"]);
});

test("casedSlugsFor: a name already in lowercase form yields nothing", () => {
  assert.deepEqual(casedSlugsFor("acme"), []);
});

test("probe: a board that answers under the second slug is found", async () => {
  // "Acme Labs" -> ["acmelabs", "acme-labs", "acme"]; the real board sits
  // at the second candidate.
  assert.deepEqual(slugsFor("Acme Labs").slice(0, 2), ["acmelabs", "acme-labs"]);

  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme-labs/jobs?content=true": {
      jobs: [{ id: "1", company_name: "Acme Labs" }],
    },
  });

  const { boards } = await probe("Acme Labs", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "greenhouse"),
    [{ platform: "greenhouse", id: "acme-labs" }],
  );
});

test("probe: Lever tries the name's own casing after the lowercase form", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({
    "https://api.lever.co/v0/postings/BlueMatrix?mode=json": [],
    "https://jobs.lever.co/BlueMatrix": "<title>BlueMatrix</title>",
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  const { boards } = await probe("BlueMatrix", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "lever", id: "BlueMatrix" }]);
  assert.deepEqual(
    requested.filter((url) => url.startsWith("https://api.lever.co/")),
    [
      "https://api.lever.co/v0/postings/bluematrix?mode=json",
      "https://api.lever.co/v0/postings/BlueMatrix?mode=json",
    ],
  );
});

test("probe: a platform answering both casings is recorded under the lowercase slug", async () => {
  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/Acme/jobs?content=true": {
      jobs: [{ id: "1", company_name: "Acme" }],
    },
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
      jobs: [{ id: "1", company_name: "Acme" }],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "greenhouse"),
    [{ platform: "greenhouse", id: "acme" }],
  );
});

test("probe: a board that answers under a name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": {
      jobs: [{ id: "1", company_name: "A Totally Different Company" }],
    },
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(
    boards.some((board) => board.platform === "greenhouse"),
    false,
  );
  assert.deepEqual(refused, [
    { board: { platform: "greenhouse", id: "acme" }, reported: "A Totally Different Company" },
  ]);
});

// Breaks if a refusal stops the platform's walk: the second slug is the
// real board, and the first is still reported as refused.
test("probe: a slug refused for its name moves on to the next candidate and is kept as refused", async () => {
  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acmelabs/jobs?content=true": {
      jobs: [{ id: "1", company_name: "Contoso" }],
    },
    "https://boards-api.greenhouse.io/v1/boards/acme-labs/jobs?content=true": {
      jobs: [{ id: "2", company_name: "Acme Labs" }],
    },
  });

  const { boards, refused } = await probe("Acme Labs", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "greenhouse", id: "acme-labs" }]);
  assert.deepEqual(refused, [
    { board: { platform: "greenhouse", id: "acmelabs" }, reported: "Contoso" },
  ]);
});

// Ashby's listing names nobody, so the board page's <title> is read
// (fixture: a Common Crawl capture, "Thyme Care Jobs").
test("probe: an Ashby slug whose page title names the company is taken", async () => {
  const fetchImpl = fakeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/thyme-care?includeCompensation=true": {
      jobs: [],
    },
    "https://jobs.ashbyhq.com/thyme-care": fixture("commoncrawl/ashby-thyme-care-head.html"),
  });

  const { boards, refused } = await probe("Thyme Care", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "ashby", id: "thyme-care" }]);
  assert.deepEqual(refused, []);
});

// Breaks if a slug answering is taken as the whole of the evidence again.
test("probe: an Ashby slug whose page title names another company is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": { jobs: [] },
    "https://jobs.ashbyhq.com/acme": fixture("commoncrawl/ashby-thyme-care-head.html"),
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [{ board: { platform: "ashby", id: "acme" }, reported: "Thyme Care" }]);
});

// Breaks if a page that loads with no name is let through or skipped
// rather than refused.
test("probe: an Ashby slug whose page loads with no title is refused as naming nobody", async () => {
  const fetchImpl = fakeFetch({
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true": { jobs: [] },
    "https://jobs.ashbyhq.com/acme": "<html><head><meta charset='utf-8'></head></html>",
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [{ board: { platform: "ashby", id: "acme" }, reported: null }]);
});

// Fixture: a Common Crawl capture whose Lever <title> is "Trey Research".
test("probe: a Lever slug whose page title names the company is taken", async () => {
  const fetchImpl = fakeFetch({
    "https://api.lever.co/v0/postings/trey-research?mode=json": [],
    "https://jobs.lever.co/trey-research": fixture("commoncrawl/lever-trey-research-head.html"),
  });

  const { boards, refused } = await probe("Trey Research", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "lever", id: "trey-research" }]);
  assert.deepEqual(refused, []);
});

test("probe: a Lever slug whose page title names another company is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://api.lever.co/v0/postings/acme?mode=json": [],
    "https://jobs.lever.co/acme": fixture("commoncrawl/lever-trey-research-head.html"),
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [
    { board: { platform: "lever", id: "acme" }, reported: "Trey Research" },
  ]);
});

// The vendor declining to serve the page is not the page naming nobody:
// recorded as a refusal, a real board would be filed as wrong_company for
// good.
test("probe: a 429 on the board page throws rather than refusing the board", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.lever.co/v0/postings/acme?mode=json") return new Response("[]");
    if (url === "https://jobs.lever.co/acme") return new Response(null, { status: 429 });
    return new Response(null, { status: 404 });
  };

  await assert.rejects(
    () => probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, ["lever"]),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
});

// Any other failure to load the name page is the same: a 403 from bot
// protection, a one-off 503 (the probe does not retry), or a 404 on a slug
// whose listing just answered. Breaks if the probe reads the name through
// boardName, which turns these into a refusal naming nobody.
for (const status of [403, 404, 503]) {
  test(`probe: a ${status} on the board page throws rather than refusing the board`, async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true") {
        return new Response(JSON.stringify({ jobs: [] }));
      }
      if (url === "https://jobs.ashbyhq.com/acme") return new Response(null, { status });
      return new Response(null, { status: 404 });
    };

    await assert.rejects(
      () => probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, ["ashby"]),
      (error: unknown) => error instanceof HttpError && error.status === status,
    );
  });
}

test("probe: a Greenhouse board with no jobs whose board endpoint answers 503 throws", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true") {
      return new Response(JSON.stringify({ jobs: [] }));
    }
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme") {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 404 });
  };

  await assert.rejects(
    () => probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, ["greenhouse"]),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});

// Breaks if the probe's name read catches every failure, not only HttpError.
test("probe: a network failure on the board page throws rather than refusing the board", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.lever.co/v0/postings/acme?mode=json") return new Response("[]");
    if (url === "https://jobs.lever.co/acme") throw new TypeError("fetch failed");
    return new Response(null, { status: 404 });
  };

  await assert.rejects(() =>
    probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, ["lever"]),
  );
});

// A Greenhouse board with nothing open has no posting to read a name from,
// so the board endpoint's `name` decides.
test("probe: a Greenhouse board with no jobs is taken when the board's name matches", async () => {
  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": { jobs: [] },
    "https://boards-api.greenhouse.io/v1/boards/acme": { name: "Acme" },
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "greenhouse", id: "acme" }]);
  assert.deepEqual(refused, []);
});

test("probe: a Greenhouse board with no jobs is refused when the board's name is another company's", async () => {
  const fetchImpl = fakeFetch({
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": { jobs: [] },
    "https://boards-api.greenhouse.io/v1/boards/acme": { name: "Contoso" },
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [
    { board: { platform: "greenhouse", id: "acme" }, reported: "Contoso" },
  ]);
});

test("probe: SmartRecruiters answering 200 with empty content is refused, not accepted", async () => {
  // 200/empty for a slug that does not exist, unlike the other three (404).
  const fetchImpl = fakeFetch({
    "https://api.smartrecruiters.com/v1/companies/acme/postings": {
      offset: 0,
      limit: 100,
      totalFound: 0,
      content: [],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(
    boards.some((board) => board.platform === "smartrecruiters"),
    false,
  );
});

test("probe: SmartRecruiters with a matching posted company name is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://api.smartrecruiters.com/v1/companies/acme/postings": {
      content: [{ id: "1", company: { name: "Acme" } }],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "smartrecruiters"),
    [{ platform: "smartrecruiters", id: "acme" }],
  );
});

test("probe: Workable with a matching account name and a posting is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://apply.workable.com/api/v1/widget/accounts/acme": {
      name: "Acme",
      jobs: [{ shortcode: "A1", title: "Staff Software Engineer" }],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "workable"),
    [{ platform: "workable", id: "acme" }],
  );
});

// A registered account with nothing listed answers 200 with its name and
// `jobs: []`; `meta` and `walmart` do, and are not those companies.
test("probe: Workable with a matching account name and no posting is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://apply.workable.com/api/v1/widget/accounts/acme": {
      name: "Acme",
      jobs: [],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(
    boards.some((board) => board.platform === "workable"),
    false,
  );
});

test("probe: Workable with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://apply.workable.com/api/v1/widget/accounts/acme": {
      name: "Other Co",
      jobs: [{ shortcode: "A1", title: "Staff Software Engineer" }],
    },
  });

  const { boards } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(
    boards.some((board) => board.platform === "workable"),
    false,
  );
});

// Rippling names no company on its listing and its board page cannot be
// read (probe.ts, top), so a slug answering there is no evidence at all.
test("probe: no Rippling URL is ever requested, even one that would list a posting", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({
    "https://api.rippling.com/platform/api/ats/v1/board/acme/jobs": [{ uuid: "x" }],
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(boards, []);
  assert.deepEqual(
    requested.filter((url) => url.includes("rippling.com")),
    [],
  );
});

test("probe: Jobvite with a matching account name and a job row is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://jobs.jobvite.com/acme/jobs":
      '<title>Acme Careers</title><table class="jv-job-list"><tr><td class="jv-job-list-name"><a href="/acme/job/1">Engineer</a></td></tr></table>',
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    boards.filter((board) => board.platform === "jobvite"),
    [{ platform: "jobvite", id: "acme" }],
  );
});

test("probe: Jobvite with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://jobs.jobvite.com/acme/jobs":
      '<title>Other Co Careers</title><table class="jv-job-list"><tr><td class="jv-job-list-name"><a href="/acme/job/1">Engineer</a></td></tr></table>',
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "jobvite"),
    false,
  );
});

// The live Jobvite listing shape: a board whose <title> is the account name
// followed by " Careers". The suffix must strip cleanly for `namesMatch` to
// see the name underneath.
test("probe: Jobvite's live title suffix ('{Name} Careers') strips cleanly", async () => {
  const fetchImpl = fakeFetch({
    "https://jobs.jobvite.com/margiestravel/jobs":
      '<title>Margie\'s Travel Careers</title><table class="jv-job-list"><tr><td class="jv-job-list-name"><a href="/margiestravel/job/1">Engineer</a></td></tr></table>',
  });

  const { boards } = await probe("Margie's Travel", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "jobvite"),
    [{ platform: "jobvite", id: "margiestravel" }],
  );
});

test("probe: Jobvite with a matching title but no job row is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://jobs.jobvite.com/acme/jobs":
      "<title>Acme Careers</title><p>No openings right now.</p>",
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "jobvite"),
    false,
  );
});

test("probe: Jobvite tries only the lowercase slug, never the name's own casing", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({});
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  await probe("BlueMatrix", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    requested.filter((url) => url.includes("jobvite.com")),
    ["https://jobs.jobvite.com/bluematrix/jobs"],
  );
});

// BambooHR left SLUG_PLATFORMS: its listing payload states no company name
// and its careers page is client-rendered with no <title>, so a slug that
// lists openings can never be checked against the company that was asked
// for - and the vendor sells to small businesses, so a well-known name's
// slug is usually a different, smaller company (`dupont.bamboohr.com` is a
// Tennessee car dealership). A listing that would once have been accepted
// must now never even be asked for; its boards come through the survey.
test("probe: no BambooHR URL is ever requested, even one that would list an opening", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({
    "https://acme.bamboohr.com/careers/list": {
      meta: { totalCount: 1 },
      result: [{ id: 1, jobOpeningName: "Engineer" }],
    },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(boards, []);
  assert.deepEqual(
    requested.filter((url) => url.includes("bamboohr.com")),
    [],
  );
});

// Fixture: a live SearchJobs page whose `og:site_name` is "Bloomberg".
test("probe: an Avature page whose og:site_name names the company is taken", async () => {
  const fetchImpl = fakeFetch({
    "https://bloomberg.avature.net/careers/SearchJobs": fixture("avature-search-bloomberg.html"),
  });

  const { boards, refused } = await probe("Bloomberg", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, [{ platform: "avature", id: "bloomberg" }]);
  assert.deepEqual(refused, []);
});

test("probe: an Avature page whose og:site_name names another company is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.avature.net/careers/SearchJobs": fixture("avature-search-bloomberg.html"),
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [
    { board: { platform: "avature", id: "acme" }, reported: "Bloomberg" },
  ]);
});

// Breaks if the <title> ("Job Search | {tenant}" on one tenant) is read as
// the name: only og:site_name counts, and a page without it names nobody.
test("probe: an Avature page with job links but no og:site_name is refused as naming nobody", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.avature.net/careers/SearchJobs":
      '<title>Job Search | Acme</title><a class="article__header__text__title" href="/en_US/careers/JobDetail/x/123">Engineer</a>',
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, [{ board: { platform: "avature", id: "acme" }, reported: null }]);
});

test("probe: an Avature page with no JobDetail link is neither taken nor refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.avature.net/careers/SearchJobs":
      '<meta property="og:site_name" content="Acme" /><title>Acme Careers</title>',
  });

  const { boards, refused } = await probe("Acme", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, []);
});

test("probe: Breezy with a matching account name is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.breezy.hr/json": [{ id: "1", name: "Engineer", company: { name: "Acme" } }],
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    boards.filter((board) => board.platform === "breezy"),
    [{ platform: "breezy", id: "acme" }],
  );
});

test("probe: Breezy with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.breezy.hr/json": [{ id: "1", name: "Engineer", company: { name: "Other Co" } }],
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "breezy"),
    false,
  );
});

test("probe: JazzHR with a matching account name is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.applytojob.com/apply/": "<title>Acme - Career Page</title>",
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    boards.filter((board) => board.platform === "jazzhr"),
    [{ platform: "jazzhr", id: "acme" }],
  );
});

test("probe: JazzHR with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.applytojob.com/apply/": "<title>Other Co - Career Page</title>",
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "jazzhr"),
    false,
  );
});

// The live JazzHR listing shape: the account name followed by
// " - Career Page", the same suffix jazzhr.ts's own detail-title parser
// strips.
test("probe: JazzHR's live title suffix ('{Name} - Career Page') strips cleanly", async () => {
  const fetchImpl = fakeFetch({
    "https://fincherarchitects.applytojob.com/apply/":
      "<title>Fincher Architects - Career Page</title>",
  });

  const { boards } = await probe("Fincher Architects", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "jazzhr"),
    [{ platform: "jazzhr", id: "fincherarchitects" }],
  );
});

test("probe: Recruitee with a matching account name is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.recruitee.com/api/offers": {
      offers: [{ id: 1, title: "Engineer", company_name: "Acme" }],
    },
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    boards.filter((board) => board.platform === "recruitee"),
    [{ platform: "recruitee", id: "acme" }],
  );
});

test("probe: Recruitee with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.recruitee.com/api/offers": {
      offers: [{ id: 1, title: "Engineer", company_name: "Other Co" }],
    },
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "recruitee"),
    false,
  );
});

// Personio left SLUG_PLATFORMS: a guess at a nonexistent subdomain answers
// HTTP 429, not 404, so no answer distinguishes "no board here" from "the
// vendor is refusing us". Even a subdomain that would have answered a real
// feed must never be asked - its boards come through the survey instead.
test("probe: no Personio URL is ever requested, even one that would answer a feed", async () => {
  const requested: string[] = [];
  const answers = fakeFetch({
    "https://acme.jobs.personio.com/xml":
      "<workzag-jobs><position><id>1</id><name>Engineer</name></position></workzag-jobs>",
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input));
    return answers(input, init);
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(boards, []);
  assert.deepEqual(
    requested.filter((url) => url.includes("personio")),
    [],
  );
});

test("probe: HRMDirect with a matching account name is accepted", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.hrmdirect.com/employment/job-openings.php?search=true":
      "<title>Careers At Acme</title>",
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(
    boards.filter((board) => board.platform === "hrmdirect"),
    [{ platform: "hrmdirect", id: "acme" }],
  );
});

test("probe: HRMDirect with a reported account name that does not match is refused", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.hrmdirect.com/employment/job-openings.php?search=true":
      "<title>Careers At Other Co</title>",
  });

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(
    boards.some((board) => board.platform === "hrmdirect"),
    false,
  );
});

// The live HRMDirect listing shape, whitespace and all, matching
// tests/fixtures/hrmdirect-listing.html: the "Careers At " prefix must
// strip cleanly before `namesMatch` sees the reported name underneath.
test("probe: HRMDirect's live title ('Careers At {Name}') prefix-strips cleanly", async () => {
  const fetchImpl = fakeFetch({
    "https://graphicdesigninstitute.hrmdirect.com/employment/job-openings.php?search=true":
      "<title>\n\t\tCareers At Graphic Design Institute\t</title>",
  });

  const { boards } = await probe("Graphic Design Institute", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(
    boards.filter((board) => board.platform === "hrmdirect"),
    [{ platform: "hrmdirect", id: "graphicdesigninstitute" }],
  );
});

test("probe: no candidate slug answering for a platform leaves that platform out", async () => {
  const fetchImpl = fakeFetch({});

  const { boards, refused } = await probe("Nobody Has This Board", {
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(boards, []);
  assert.deepEqual(refused, []);
});

// A wrong slug guess on Avature DNS-fails, and http.ts's ladder used to
// spend 30s on it before the loop below could call it "no board". The probe
// asks for no retries, so every candidate URL is requested exactly once.
test("probe: a network-level failure is attempted once, not retried", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(boards, []);
  assert.deepEqual(
    requested.filter((url) => url === "https://acme.avature.net/careers/SearchJobs"),
    ["https://acme.avature.net/careers/SearchJobs"],
  );
});

// The same failure on a retryable status, which the ladder would have
// climbed too. Measured live on Personio, which is no longer probed at all
// for that very reason; Avature is the remaining 30s case, and any probed
// platform's 429 must cost one request, not five.
test("probe: a 429 from an unregistered slug is attempted once, not retried", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(null, { status: 429 });
  };

  // It throws now rather than reading as no board, but what this test is
  // for is the request count: one attempt, not the ladder's five.
  await assert.rejects(
    () => probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }),
    HttpError,
  );

  assert.deepEqual(
    requested.filter((url) => url === "https://acme.avature.net/careers/SearchJobs"),
    ["https://acme.avature.net/careers/SearchJobs"],
  );
});

// Real time, so a later platform's answer genuinely lands before an earlier
// one's rather than merely being queued behind it.
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `probe` asks every platform at once, so they answer in whatever
// order the hosts happen to be quick in. discover.ts reads the *first*
// returned board another company already carries to decide an alias, so the
// result must stay in SLUG_PLATFORMS order: Greenhouse (first in the table)
// ahead of HRMDirect (last), even though HRMDirect answered first here. An
// implementation that pushed each board as it settled would return them the
// other way round.
test("probe: boards come back in platform order, not in the order the hosts answered", async () => {
  const answered: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://acme.hrmdirect.com/employment/job-openings.php?search=true") {
      answered.push("hrmdirect");
      return new Response("<title>Careers At Acme</title>", { status: 200 });
    }
    if (url === "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true") {
      await after(25);
      answered.push("greenhouse");
      return new Response(JSON.stringify({ jobs: [{ id: "1", company_name: "Acme" }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 404 });
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(answered, ["hrmdirect", "greenhouse"]);
  assert.deepEqual(boards, [
    { platform: "greenhouse", id: "acme" },
    { platform: "hrmdirect", id: "acme" },
  ]);
});

// Eleven platforms, eleven different hosts, and net/http.ts rate-limits
// per host, so probing them one after another stacked unrelated waits
// (8.5s a name, measured live 2026-09-22). Each platform's first candidate
// must be in flight at the same moment as the other ten; a serial walk
// peaks at one.
test("probe: all eleven platforms are in flight at once, not one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await after(10);
    inFlight -= 1;
    return new Response(null, { status: 404 });
  };

  const { boards } = await probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.deepEqual(boards, []);
  assert.equal(peak, 11);
});

// Concurrency is across platforms only: within one platform the candidates
// stay serial, so a single host still takes one request at a time from a
// given name. Lever is the one platform with two candidates for this name
// (the lowercase slug, then the name's own casing).
test("probe: one platform's own candidates stay serial, never overlapping", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (!url.startsWith("https://api.lever.co/")) return new Response(null, { status: 404 });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await after(10);
    inFlight -= 1;
    return new Response(null, { status: 404 });
  };

  await probe("BlueMatrix", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  assert.equal(peak, 1);
});

// A caller that already knows the answer for the other nine (the deleted
// backlog pass, walking names the store has held since before a platform
// existed) asks for a subset, and the platforms it did not name must not be
// asked at all: ~6,400 needless Workable requests on 2026-09-22 got the
// tool blocked.
test("probe: a named subset of platforms requests only those platforms' URLs", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(null, { status: 404 });
  };

  const { boards } = await probe(
    "Acme",
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ["recruitee", "breezy"],
  );

  assert.deepEqual(boards, []);
  // Sorted: the two are in flight at once, so which lands first is the
  // hosts' business, not this test's.
  assert.deepEqual(requested.toSorted(), [
    "https://acme.breezy.hr/json",
    "https://acme.recruitee.com/api/offers",
  ]);
});

test("probe: a named subset returns its boards in the order the subset names them", async () => {
  const fetchImpl = fakeFetch({
    "https://acme.breezy.hr/json": [{ id: "1", name: "Engineer", company: { name: "Acme" } }],
    "https://acme.recruitee.com/api/offers": { offers: [{ id: 1, company_name: "Acme" }] },
  });

  const { boards } = await probe(
    "Acme",
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ["breezy", "recruitee"],
  );

  assert.deepEqual(boards, [
    { platform: "breezy", id: "acme" },
    { platform: "recruitee", id: "acme" },
  ]);
});

test("namesMatch: 'Backblaze External Website' accepts the queried 'Backblaze'", () => {
  assert.equal(namesMatch("Backblaze External Website", "Backblaze"), true);
});

test("namesMatch: 'Tenstorrent Inc.' accepts the queried 'Tenstorrent'", () => {
  assert.equal(namesMatch("Tenstorrent Inc.", "Tenstorrent"), true);
});

test("namesMatch: a one-word query accepts a longer reported name it starts", () => {
  assert.equal(namesMatch("Acme Insurance Holdings", "Acme"), true);
});

test("namesMatch: a one-word query refuses a reported name it is not the start of", () => {
  assert.equal(namesMatch("Insurance Acme Holdings", "Acme"), false);
});

test("namesMatch: a two-word query refuses a reported name sharing only its first word", () => {
  assert.equal(namesMatch("Acme Corp", "Acme Corporation"), false);
});

// A 429 is the one probe failure that is not an answer. Recording it as
// "no board" is what made both Workable backlog passes untrustworthy: the
// completed 2026-09-22 pass reports 0 Workable boards over 3,189 names
// with `errors: 0`, having been refused throughout.

test("probe: a 429 from a platform throws rather than reading as no board", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 429 });

  await assert.rejects(
    () => probe("Acme", { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }, ["recruitee"]),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
});

test("probe: a 404 still reads as no board, so a dead slug costs nothing", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });

  const { boards } = await probe(
    "Acme",
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ["recruitee"],
  );

  assert.deepEqual(boards, []);
});

test("probe: a network-level failure still reads as no board", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const { boards } = await probe(
    "Acme",
    { fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep },
    ["breezy"],
  );

  assert.deepEqual(boards, []);
});
