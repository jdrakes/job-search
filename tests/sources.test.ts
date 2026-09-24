import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveSources, selectSources } from "../src/daily.ts";
import { remoteOkSource, parseRemoteOkJobs } from "../src/discovery/remoteok.ts";
import { hnSource, parseHnThread } from "../src/discovery/hn.ts";
import type { Source } from "../src/discovery/source.ts";
import { weWorkRemotelySource, parseWeWorkRemotelyFeed } from "../src/discovery/weworkremotely.ts";
import { builtInSource, parseBuiltInJobs } from "../src/discovery/builtin.ts";
import { theMuseSource, parseTheMuseJobs } from "../src/discovery/themuse.ts";
import { HttpError } from "../src/net/http.ts";
import type { Criteria } from "../src/schema.ts";
import { memoryStore } from "../src/store/memory.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const noSleep = async () => {};

// http.ts requires a configured User-Agent now that it no longer carries a
// built-in one (src/net/http.ts); these tests fake the network entirely, so
// any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// Five invented items written to the feed's documented shape: the title is
// "Company: Role" and the description is entity-encoded markup, which the
// vendor passes through from the advertiser untouched. Two items are the
// same company, and one writes its name entity-encoded with no space before
// the ampersand, which is the case `htmlToText` is here for. The adverts
// themselves are a line each: the parser reads only the title.

test("parseWeWorkRemotelyFeed: reads the company off every item's title, duplicates kept", () => {
  const names = parseWeWorkRemotelyFeed(fixture("weworkremotely-remote-jobs.rss"));
  assert.deepEqual(names, [
    "Proseware LLC",
    "Wingtip Toys",
    "Trey Research AB",
    "Trey Research AB",
    "A. VanArsdel& Co.",
  ]);
});

test("parseWeWorkRemotelyFeed: an item whose title carries no ': ' is skipped, not guessed at", () => {
  const feed =
    "<rss><channel><title>We Work Remotely</title>" +
    "<item><title>Acme Inc: Staff Engineer</title></item>" +
    "<item><title>A title with no separator at all</title></item>" +
    "</channel></rss>";
  assert.deepEqual(parseWeWorkRemotelyFeed(feed), ["Acme Inc"]);
});

test("parseWeWorkRemotelyFeed: a feed with no items reads as no names, not a throw", () => {
  assert.deepEqual(parseWeWorkRemotelyFeed("<rss><channel></channel></rss>"), []);
});

test("weWorkRemotelySource: the whole source is one request for the feed", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixture("weworkremotely-remote-jobs.rss"), { status: 200 });
  };

  const names = await weWorkRemotelySource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(requested, ["https://weworkremotely.com/remote-jobs.rss"]);
  assert.equal(names.length, 5);
  assert.equal(names[0], "Proseware LLC");
});

// The legal notice the array opens with plus four invented jobs, written to
// the API's documented shape. Two are the same company, whose name the vendor
// sends padded ("Adventure Works "), and one sends its name entity-encoded.

test("parseRemoteOkJobs: reads the company off every job, duplicates kept", () => {
  const names = parseRemoteOkJobs(JSON.parse(fixture("remoteok-api.json")));
  assert.deepEqual(names, [
    "Coho Bookkeeping",
    "Adventure Works",
    "Wide World Importers & Logistics",
    "Adventure Works",
  ]);
});

test("parseRemoteOkJobs: the legal notice the array opens with is not read as a company", () => {
  const data = JSON.parse(fixture("remoteok-api.json"));
  assert.ok("legal" in data[0]);
  assert.equal(parseRemoteOkJobs(data).length, data.length - 1);
});

test("parseRemoteOkJobs: an element with no company is skipped, not a throw", () => {
  assert.deepEqual(parseRemoteOkJobs([{ legal: "terms" }, { company: "Acme" }, {}, "junk"]), [
    "Acme",
  ]);
});

test("remoteOkSource: the whole source is one request for the feed", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixture("remoteok-api.json"), { status: 200 });
  };

  const names = await remoteOkSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(requested, ["https://remoteok.com/api"]);
  assert.deepEqual(names, [
    "Coho Bookkeeping",
    "Adventure Works",
    "Wide World Importers & Logistics",
    "Adventure Works",
  ]);
});

// Seven invented top-level comments written to the Algolia `items` shape,
// replies left empty. Five follow the "Company | Role | ..." convention the
// thread asks for, one of them writing the name with its URL in brackets
// inside the first segment. Two are plain prose about the thread itself with
// no "|", which is what the parser has to leave alone.

test("parseHnThread: reads a company name off every '|'-delimited comment", () => {
  const data = JSON.parse(fixture("hn-thread.json"));
  const names = parseHnThread(data);
  assert.deepEqual(names, [
    "Relecloud.example",
    "Adatum",
    "Nod Publishers / Southridge",
    "Lamna Advisors ( https://lamna.example )",
    "Centre for Coastal Sediment Research (CCSR)",
  ]);
});

test("parseHnThread: a comment whose first line is prose (no '|') is skipped", () => {
  const data = JSON.parse(fixture("hn-thread.json"));
  const names = parseHnThread(data);
  assert.equal(names.length, 5);
  assert.ok(!names.some((name) => name.includes("Reminder")));
  assert.ok(!names.some((name) => name.includes("Something for the people")));
});

test("parseHnThread: a name over the length/word ceiling is skipped, not truncated", () => {
  const data = {
    children: [
      {
        text: "A Company Whose Full Legal Name Runs On For Rather A Lot Of Words Indeed | Engineer",
      },
    ],
  };
  assert.deepEqual(parseHnThread(data), []);
});

test("parseHnThread: a '|'-delimited first segment ending like a sentence is skipped", () => {
  const data = {
    children: [{ text: "We are hiring engineers. | Full-time | Remote" }],
  };
  assert.deepEqual(parseHnThread(data), []);
});

test("hnSource: finds the newest 'Who is hiring?' thread and reads its comments", async () => {
  const searchResponse = {
    hits: [
      { title: "Ask HN: Who is hiring? (September 2026)", objectID: "77000100" },
      { title: "Ask HN: Who wants to be hired? (September 2026)", objectID: "77000110" },
    ],
  };

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("search_by_date")) {
      return new Response(JSON.stringify(searchResponse), { status: 200 });
    }
    if (url.endsWith("/items/77000100")) {
      return new Response(fixture("hn-thread.json"), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const names = await hnSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(names, [
    "Relecloud.example",
    "Adatum",
    "Nod Publishers / Southridge",
    "Lamna Advisors ( https://lamna.example )",
    "Centre for Coastal Sediment Research (CCSR)",
  ]);
});

test("hnSource: no recognizable 'Who is hiring?' hit reads as no companies", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ hits: [] }), { status: 200 });

  const names = await hnSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });
  assert.deepEqual(names, []);
});

// `selectSources` and `resolveSources` (src/daily.ts) apply
// `settings/config.json`'s `discoverySources` and `extraSourcePath` to the
// fixed source list. A fake source stands in for hn/remoteok/weworkremotely
// so these tests exercise the filtering logic, not a real source's parsing.
function fakeSource(name: string): Source {
  return { name, companies: async () => [] };
}

// A stand-in criteria row; only `level_words` matters to these tests, since
// that is the only field the extra-source factory reads.
const SEEDED_CRITERIA: Criteria = {
  id: 1,
  level_words: ["staff", "senior"],
  role_words: ["backend"],
  excluded_title_words: [],
  team_name_words: [],
  excluded_states: [],
  missing_languages: [],
  comp_floor: 120000,
  max_age_days: null,
  excluded_locations: [],
  product_words: [],
  assumed_bonus_pct: null,
  updated_at: "2026-09-14T00:00:00Z",
};

test("selectSources: an absent discoverySources runs every source", () => {
  const sources = [fakeSource("hn"), fakeSource("remoteok"), fakeSource("weworkremotely")];
  assert.deepEqual(selectSources(sources, undefined), sources);
});

test("selectSources: a named subset runs only those sources, in the order named", () => {
  const hn = fakeSource("hn");
  const remoteOk = fakeSource("remoteok");
  const weWorkRemotely = fakeSource("weworkremotely");

  const selected = selectSources([hn, remoteOk, weWorkRemotely], ["weworkremotely", "hn"]);

  assert.deepEqual(selected, [weWorkRemotely, hn]);
});

test("selectSources: an unknown name throws naming the valid source names", () => {
  const sources = [fakeSource("hn"), fakeSource("remoteok")];

  assert.throws(
    () => selectSources(sources, ["glassdoor"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("glassdoor"));
      assert.ok(error.message.includes("hn"));
      assert.ok(error.message.includes("remoteok"));
      return true;
    },
  );
});

test("resolveSources: an extraSourcePath is imported and its factory's source appended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-search-extra-source-"));
  const modulePath = join(dir, "extra-source.ts");
  writeFileSync(
    modulePath,
    [
      "export default function factory(levelWords) {",
      "  return {",
      '    name: "extra-test-source",',
      "    companies: async () => levelWords.map((word) => `saw:${word}`),",
      "  };",
      "}",
      "",
    ].join("\n"),
  );

  const store = memoryStore({ criteria: [SEEDED_CRITERIA] });
  const sources = await resolveSources([fakeSource("hn")], { extraSourcePath: modulePath }, store);

  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.name, "hn");
  assert.equal(sources[1]?.name, "extra-test-source");
  assert.deepEqual(await sources[1]?.companies(), ["saw:staff", "saw:senior"]);
});

test("resolveSources: an extraSourcePath that does not resolve throws naming the path", async () => {
  const store = memoryStore({ criteria: [SEEDED_CRITERIA] });
  const missingPath = join(tmpdir(), "job-search-extra-source-does-not-exist.ts");

  await assert.rejects(
    () => resolveSources([fakeSource("hn")], { extraSourcePath: missingPath }, store),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(missingPath));
      return true;
    },
  );
});

test("resolveSources: an extraSourcePath whose default export is not a factory function throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-search-extra-source-"));
  const modulePath = join(dir, "not-a-factory.ts");
  writeFileSync(modulePath, "export default 42;\n");
  const store = memoryStore({ criteria: [SEEDED_CRITERIA] });

  await assert.rejects(() =>
    resolveSources([fakeSource("hn")], { extraSourcePath: modulePath }, store),
  );
});

// A missing criteria row is a runtime condition, not an operator's typo: on
// a two-store install the row may only arrive with the next pull, and
// refusing here would cost the run its discovery, ingestion and judging as
// well as its extra source. The path is never even imported, so a run with a
// private source configured and no row yet still does the rest of its work.
test("resolveSources: an extraSourcePath set with no criteria row logs a skip and runs the rest", async () => {
  const store = memoryStore();
  const hn = fakeSource("hn");
  const lines: string[] = [];

  const sources = await resolveSources(
    [hn],
    { extraSourcePath: join(tmpdir(), "job-search-never-imported.ts") },
    store,
    (line) => lines.push(line),
  );

  assert.deepEqual(sources, [hn]);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /extra source skipped/);
  assert.match(lines[0] ?? "", /no row with id 1/);
});

test("resolveSources: no extraSourcePath still applies discoverySources filtering", async () => {
  const hn = fakeSource("hn");
  const remoteOk = fakeSource("remoteok");
  const store = memoryStore();

  const sources = await resolveSources([hn, remoteOk], { discoverySources: ["remoteok"] }, store);

  assert.deepEqual(sources, [remoteOk]);
});

// tests/fixtures/builtin-jobs.html is written from Built In's markup
// schema, not captured: every company, logo URL and job id in it is
// invented. Its own header comment says which shape each card proves.

test("parseBuiltInJobs: reads the company off every card, duplicates kept", () => {
  const names = parseBuiltInJobs(fixture("builtin-jobs.html"));
  assert.deepEqual(names, [
    // Three cards for one company and two for the next: the duplicates
    // are what say a company posts more than one opening.
    "Adatum Corporation",
    "Adatum Corporation",
    "Adatum Corporation",
    "Tailwind Traders",
    "Tailwind Traders",
    // The entity in the markup is decoded, not carried through.
    "Humongous Insurance & Trust",
    "School of Fine Art",
    // A span padded with newlines is trimmed.
    "The Phone Company",
  ]);
});

test("parseBuiltInJobs: a page with no company-title spans reads as no names, not a throw", () => {
  assert.deepEqual(parseBuiltInJobs('<div class="d-flex gap-job-cards flex-column"></div>'), []);
});

test("builtInSource: is named for the website, not the bootstrap import's 'builtin'", () => {
  assert.equal(builtInSource.name, "builtin.com");
});

test("builtInSource: walks builtin.com from page 1 until a page yields nothing", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return url.includes("page=1")
      ? new Response(fixture("builtin-jobs.html"), { status: 200 })
      : new Response("<div></div>", { status: 200 });
  };

  const names = await builtInSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  // The flagship board only: a filled page 1, an empty page 2 that stops
  // the walk. The eight city subsites were dropped 2026-09-22.
  assert.deepEqual(requested, [
    "https://builtin.com/jobs?page=1",
    "https://builtin.com/jobs?page=2",
  ]);
  assert.equal(names.length, 8);
});

test("builtInSource: requests no www.builtin* city subsite", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(fixture("builtin-jobs.html"), { status: 200 });
  };

  await builtInSource.companies({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep });

  const hosts = [...new Set(requested.map((url) => new URL(url).host))];
  assert.deepEqual(hosts, ["builtin.com"]);
});

// Built In answered HTTP 429 part-way through three of its first four
// runs. A throw there used to lose every page already read.
test("builtInSource: a page that fails keeps the names read before it", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return url.includes("page=1")
      ? new Response(fixture("builtin-jobs.html"), { status: 200 })
      : new Response("", { status: 429 });
  };

  const names = await builtInSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(requested, [
    "https://builtin.com/jobs?page=1",
    "https://builtin.com/jobs?page=2",
  ]);
  assert.equal(names.length, 8);
});

test("builtInSource: a failure before any name is read still throws", async () => {
  const fetchImpl: typeof fetch = async () => new Response("", { status: 429 });

  await assert.rejects(
    () => builtInSource.companies({ fetchImpl, userAgent: TEST_USER_AGENT, sleep: noSleep }),
    HttpError,
  );
});

test("builtInSource: a board that never runs out of pages stops at MAX_PAGES", async () => {
  let calls = 0;
  const hardStop = 50 + 1;
  const onePosting =
    '<div class="left-side-tile-item-1"></div>' +
    '<div class="left-side-tile-item-2"><a data-id="company-title"><span>Acme Inc</span></a></div>';
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls > hardStop) throw new Error(`unbounded paging: ${calls} requests and counting`);
    return new Response(onePosting, { status: 200 });
  };

  const names = await builtInSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  // MAX_PAGES for the one host, every page full.
  assert.equal(calls, 50);
  assert.equal(names.length, 50);
});

// tests/fixtures/themuse-jobs.json is written from The Muse's public jobs
// API schema, not captured: the envelope's own counters are kept because
// they are why the walk is capped, and every company, id and posting in it
// is invented. Its second result's name is padded with spaces, which is the
// only reason the reader trims.

test("parseTheMuseJobs: reads the company off every result, trimmed", () => {
  const names = parseTheMuseJobs(JSON.parse(fixture("themuse-jobs.json")));
  assert.deepEqual(names, ["Lamna Healthcare", "Wingtip Toys", "Best For You Organics"]);
});

test("parseTheMuseJobs: an empty results array reads as no names, not a throw", () => {
  assert.deepEqual(parseTheMuseJobs({ page: 0, page_count: 1, results: [] }), []);
});

test("parseTheMuseJobs: a result with no company name is skipped, not a throw", () => {
  assert.deepEqual(
    parseTheMuseJobs({ results: [{ company: { name: "Acme" } }, { company: {} }, {}, "junk"] }),
    ["Acme"],
  );
});

test("theMuseSource: walks page while a page answers results, stops when one is empty", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    return url.includes("page=0")
      ? new Response(fixture("themuse-jobs.json"), { status: 200 })
      : new Response(JSON.stringify({ page: 1, page_count: 1, results: [] }), { status: 200 });
  };

  const names = await theMuseSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.deepEqual(requested, [
    "https://www.themuse.com/api/public/jobs?page=0",
    "https://www.themuse.com/api/public/jobs?page=1",
  ]);
  assert.deepEqual(names, ["Lamna Healthcare", "Wingtip Toys", "Best For You Organics"]);
});

test("theMuseSource: a page that never runs out of results stops at MAX_PAGES", async () => {
  let calls = 0;
  const onePosting = { results: [{ company: { name: "Acme Inc" } }] };
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls > 50) throw new Error(`unbounded paging: ${calls} requests and counting`);
    return new Response(JSON.stringify(onePosting), { status: 200 });
  };

  const names = await theMuseSource.companies({
    fetchImpl,
    userAgent: TEST_USER_AGENT,
    sleep: noSleep,
  });

  assert.equal(calls, 50);
  assert.equal(names.length, 50);
});
