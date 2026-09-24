import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseWorkdayListing, parseWorkdayDetail, workdayReader } from "../src/ats/workday.ts";
import {
  parseEightfoldListing,
  parseEightfoldJob,
  eightfoldReader,
  workSiteWorkplace,
} from "../src/ats/eightfold.ts";
import { parseAmazon, amazonReader } from "../src/ats/amazon.ts";
import { MAX_PAGES } from "../src/ats/ats.ts";

// Every fixture here is written from its platform's response schema, not
// captured: the envelope, nesting and escaping are the platform's, while the
// company, the prose and every identifier are invented.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const FABRIKAM_SITE = "https://fabrikam.wd5.myworkdayjobs.com/Fabrikam_Careers";

// Eightfold's `domain` is not derivable from the host, so the fixture states
// one that `guessDomain` would not produce (src/ats/eightfold.ts).
const TAILSPIN_HOST = "explore.jobs.tailspin.example";

// http.ts requires a configured User-Agent now that it no longer carries a
// built-in one (src/net/http.ts); these tests fake the network entirely, so
// any value satisfies it.
const TEST_USER_AGENT = "test-bot (+https://example.com)";

// A board that answers a full page whatever offset it is asked for.
// `hardStop` throws instead of looping forever, so the test fails with a
// message rather than hanging the suite.
function endlessBoard(
  page: () => unknown,
  hardStop: number,
): {
  readonly options: {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    userAgent: string;
  };
  calls(): number;
} {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls > hardStop) throw new Error(`unbounded paging: ${calls} requests and counting`);
    return new Response(JSON.stringify(page()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    options: {
      fetchImpl,
      userAgent: TEST_USER_AGENT,
      sleep: async () => {},
    },
    calls: () => calls,
  };
}

const FIRST_REQ_PATH =
  "/job/Springfield-Illinois-US/Principal-Software-Engineer--Data---Streaming-Platform--Hybrid-_4400101";
const SECOND_REQ_PATH = "/job/Limerick-Ireland/Staff-Software-Engineer---Scheduling-Tools_4400102";

test("Workday: a listing entry carries no body or comp", () => {
  const listings = parseWorkdayListing(fixture("workday-listing.json"), FABRIKAM_SITE);
  assert.equal(listings.length, 2);

  // The req the with-comp detail fixture answers for: the two fixtures are
  // one listing entry and that entry's detail response.
  const first = listings.find((listing) => listing.id === "4400101");
  assert.ok(first);
  assert.equal(first?.title, "Principal Software Engineer, Data & Streaming Platform (Hybrid)");
  assert.equal(first?.location, "Springfield, Illinois, US");
  assert.equal(first?.url, `${FABRIKAM_SITE}${FIRST_REQ_PATH}`);
  assert.equal(first?.body, null);
  assert.equal(first?.compLow, null);
  assert.equal(first?.compHigh, null);
  assert.equal(first?.postedAt, null);

  // The other entry leads to the no-comp detail fixture by the same path.
  const second = listings.find((listing) => listing.id === "4400102");
  assert.ok(second);
  assert.equal(second?.url, `${FABRIKAM_SITE}${SECOND_REQ_PATH}`);
});

test("Workday: a detail response with a stated pay range parses it", () => {
  const listing = parseWorkdayDetail(
    fixture("workday-detail-with-comp.json"),
    FIRST_REQ_PATH,
    FABRIKAM_SITE,
  );
  assert.ok(listing);
  // `jobReqId`, the detail's spelling of the id the listing entry carries in
  // `bulletFields`: the pair is one posting read twice.
  assert.equal(listing?.id, "4400101");
  assert.equal(listing?.title, "Principal Software Engineer, Data & Streaming Platform (Hybrid)");
  // The posting states a relocation range, then a headline range, then
  // higher ones for named metros, the highest reaching $471,500.00 written
  // with an en dash. So: the cents suffix must not stop a range parsing,
  // the dash spelling must not either, and the range reaching highest is
  // recorded rather than the first or the headline one.
  assert.equal(listing?.compLow, 326_000);
  assert.equal(listing?.compHigh, 471_500);
  assert.ok(listing?.body?.includes("Principal Software Engineer"));
});

test("Workday: a detail response with no stated pay leaves comp absent", () => {
  const listing = parseWorkdayDetail(
    fixture("workday-detail-no-comp.json"),
    SECOND_REQ_PATH,
    FABRIKAM_SITE,
  );
  assert.ok(listing);
  assert.equal(listing?.id, "4400102");
  assert.equal(listing?.title, "Staff Software Engineer - Scheduling Tools");
  assert.equal(listing?.location, "Limerick, Ireland");
  assert.equal(listing?.compLow, null);
  assert.equal(listing?.compHigh, null);
});

test("Workday: a detail response in the wrong shape reads as absent, never a throw", () => {
  const listing = parseWorkdayDetail({ somethingElse: true }, "/job/x", FABRIKAM_SITE);
  assert.equal(listing, null);
});

test("Workday: remoteType maps to the board's own workplace word, an unread value or absence to null", () => {
  const workplaceOf = (remoteType: string | undefined) =>
    parseWorkdayDetail(
      { jobPostingInfo: { title: "req", ...(remoteType === undefined ? {} : { remoteType }) } },
      "/job/x",
      FABRIKAM_SITE,
    )?.workplace;

  assert.equal(workplaceOf("Remote"), "remote");
  assert.equal(workplaceOf("Remote/Hybrid"), "remote");
  assert.equal(workplaceOf("Hybrid"), "hybrid");
  assert.equal(workplaceOf("Onsite Only"), "onsite");
  assert.equal(workplaceOf("Flexible"), null);
  assert.equal(workplaceOf(undefined), null);

  // A listing entry never carries remoteType (only a detail's
  // jobPostingInfo does), so it reads as no stated workplace.
  const listing = parseWorkdayListing(
    { jobPostings: [{ title: "No remoteType", bulletFields: ["req-1"] }] },
    FABRIKAM_SITE,
  );
  assert.equal(listing[0]?.workplace, null);
});

test("Eightfold: a listing entry carries no body or comp", () => {
  const listings = parseEightfoldListing(fixture("eightfold-listing.json"), TAILSPIN_HOST);
  assert.equal(listings.length, 2);
  for (const listing of listings) {
    assert.equal(listing.body, null);
    assert.equal(listing.compLow, null);
    assert.equal(listing.compHigh, null);
    assert.ok(listing.title !== null);
  }
  // The position the with-comp detail fixture answers for.
  const first = listings.find((listing) => listing.id === "880000100001");
  assert.ok(first);
  assert.equal(first?.title, "AI Engineer 5 - Developer Tooling & Agents");
  assert.equal(first?.location, "USA - Remote");
});

test("Eightfold: a detail response with a stated pay range parses it", () => {
  const listing = parseEightfoldJob(fixture("eightfold-detail-with-comp.json"), TAILSPIN_HOST);
  assert.equal(listing.id, "880000100001");
  assert.equal(listing.title, "AI Engineer 5 - Developer Tooling & Agents");
  assert.equal(listing.compLow, 265_000);
  assert.equal(listing.compHigh, 415_000);
  // t_update is epoch seconds.
  assert.equal(listing.postedAt, "2026-09-08");
  assert.equal(
    listing.url,
    `https://${TAILSPIN_HOST}/careers/job/880000100001?microsite=tailspintoys.example`,
  );
});

test("Amazon: parses listing entries, body assembled from all three text fields", () => {
  const listings = parseAmazon(fixture("amazon-listing.json"));
  assert.equal(listings.length, 2);

  const first = listings.find((listing) => listing.id === "81000101");
  assert.ok(first);
  assert.equal(first?.title, "Sr Software Dev Engineer, Ledger Write Path");
  assert.equal(first?.location, "Columbus, Ohio, USA");
  assert.equal(
    first?.url,
    "https://www.amazon.jobs/en/jobs/81000101/sr-software-dev-engineer-ledger-write-path",
  );
  // "September 3, 2026" is prose, and a one-digit day is padded.
  assert.equal(first?.postedAt, "2026-09-03");
  // The body reaches the pay band in `preferred_qualifications`, the last of
  // the three text fields, but the band is stated without a dollar sign
  // ("USA, OH, Columbus - 171,500.00 - 232,000.00 USD annually") and
  // `compInText` requires one, so the posting records no comp.
  assert.ok(first?.body?.includes("171,500.00 - 232,000.00 USD annually"));
  assert.equal(first?.compLow, null);
  assert.equal(first?.compHigh, null);

  const second = listings.find((listing) => listing.id === "81000102");
  assert.ok(second);
  assert.equal(second?.postedAt, "2026-09-17");
});

test("Workday: a board that never runs out of pages stops at the cap", async () => {
  let issued = 0;
  const board = endlessBoard(
    () => ({
      jobPostings: Array.from({ length: 20 }, () => {
        issued += 1;
        return { title: "Staff Software Engineer", bulletFields: [`req-${issued}`] };
      }),
    }),
    MAX_PAGES * 3,
  );

  const listings = await workdayReader.list(
    { platform: "workday", id: "wd5/Fabrikam_Careers/fabrikam" },
    board.options,
  );

  // MAX_PAGES for each of the three search queries workday.ts walks; the
  // pages are full and the payload states no total.
  assert.equal(board.calls(), MAX_PAGES * 3);
  assert.equal(listings.length, MAX_PAGES * 3 * 20);
});

test("Eightfold: a board that never runs out of pages stops at the cap", async () => {
  let issued = 0;
  const board = endlessBoard(
    () => ({
      count: 99_999,
      positions: Array.from({ length: 10 }, () => {
        issued += 1;
        return { id: issued, name: "AI Engineer 5" };
      }),
    }),
    MAX_PAGES,
  );

  const listings = await eightfoldReader.list(
    { platform: "eightfold", id: TAILSPIN_HOST },
    board.options,
  );

  // MAX_PAGES over the one listing query, the first page included.
  assert.equal(board.calls(), MAX_PAGES);
  assert.equal(listings.length, MAX_PAGES * 10);
});

// A pcsx-only Eightfold board (v2 refuses, search answers under `data`),
// whose `position_details` answers `answers` in order, 404 when it runs
// out. `requested` keeps every URL asked for.
function pcsxBoard(
  detail: unknown,
  answers: readonly { readonly status: number; readonly body: unknown }[],
): {
  readonly options: {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    userAgent: string;
  };
  readonly requested: string[];
} {
  const requested: string[] = [];
  const pending = [...answers];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/api/pcsx/search")) return json(200, { data: { positions: [], count: 0 } });
    if (url.includes("/api/apply/v2/jobs/")) return json(200, detail);
    if (url.includes("/api/pcsx/position_details")) {
      const answer = pending.shift();
      return answer === undefined ? json(404, {}) : json(answer.status, answer.body);
    }
    return json(404, {});
  };
  return {
    options: {
      fetchImpl,
      userAgent: TEST_USER_AGENT,
      sleep: async () => {},
    },
    requested,
  };
}

// The host stays real: `src/ats/eightfold.ts` keys the work-site read on this
// exact hostname because this vendor deployment is the one that answers it, so
// a test naming an invented host would exercise the other branch. The position
// id is invented.
const WORK_SITE_BOARD = { platform: "eightfold", id: "apply.careers.microsoft.com" } as const;
const WORK_SITE_DETAIL = {
  id: 9000001,
  name: "Principal Software Engineer",
  job_description: "<p>Build the platform.</p>",
};
const POSITION_DETAILS_URL =
  "https://apply.careers.microsoft.com/api/pcsx/position_details?position_id=9000001&domain=microsoft.com&hl=en";

function detailsRequests(requested: readonly string[]): string[] {
  return requested.filter((url) => url.includes("/api/pcsx/position_details"));
}

test("Eightfold: the work-site host's zero-days value reads as remote, workLocationOption ignored", async () => {
  const board = pcsxBoard(WORK_SITE_DETAIL, [
    {
      status: 200,
      body: {
        data: {
          efcustomTextWorkSite: ["0 days / week onsite, remote"],
          workLocationOption: "onsite",
        },
      },
    },
  ]);
  const listing = await eightfoldReader.body?.(WORK_SITE_BOARD, "9000001", board.options);
  assert.equal(listing?.workplace, "remote");
  assert.equal(listing?.title, "Principal Software Engineer");
  assert.equal(listing?.body, "Build the platform.");
  assert.deepEqual(detailsRequests(board.requested), [POSITION_DETAILS_URL]);
});

test("Eightfold: the work-site host's in-office days and fully on-site read as onsite", async () => {
  for (const workSite of ["3 days / week in-office", "Fully on-site"]) {
    const board = pcsxBoard(WORK_SITE_DETAIL, [
      { status: 200, body: { data: { efcustomTextWorkSite: workSite } } },
    ]);
    const listing = await eightfoldReader.body?.(WORK_SITE_BOARD, "9000001", board.options);
    assert.equal(listing?.workplace, "onsite", workSite);
  }
});

test("Eightfold: a blank work-site value states nothing", async () => {
  const board = pcsxBoard(WORK_SITE_DETAIL, [
    { status: 200, body: { data: { efcustomTextWorkSite: "" } } },
  ]);
  const listing = await eightfoldReader.body?.(WORK_SITE_BOARD, "9000001", board.options);
  assert.equal(listing?.workplace, null);
});

test("Eightfold: a 404 on the work-site host's position_details is asked once more", async () => {
  const board = pcsxBoard(WORK_SITE_DETAIL, [
    { status: 404, body: { status: 404, error: { message: "Position not found" } } },
    { status: 200, body: { data: { efcustomTextWorkSite: "0 days / week onsite, remote" } } },
  ]);
  const listing = await eightfoldReader.body?.(WORK_SITE_BOARD, "9000001", board.options);
  assert.equal(listing?.workplace, "remote");
  assert.deepEqual(detailsRequests(board.requested), [POSITION_DETAILS_URL, POSITION_DETAILS_URL]);
});

test("Eightfold: two 404s from the work-site host leave the workplace unstated and keep the detail", async () => {
  const board = pcsxBoard(WORK_SITE_DETAIL, [
    { status: 404, body: { status: 404, error: { message: "Position not found" } } },
    { status: 404, body: { status: 404, error: { message: "Position not found" } } },
  ]);
  const listing = await eightfoldReader.body?.(WORK_SITE_BOARD, "9000001", board.options);
  assert.equal(listing?.workplace, null);
  assert.equal(listing?.title, "Principal Software Engineer");
  assert.equal(listing?.body, "Build the platform.");
  assert.equal(detailsRequests(board.requested).length, 2);
});

test("Eightfold: a host other than the one work-site host never asks for position_details", async () => {
  const board = pcsxBoard(fixture("eightfold-detail-with-comp.json"), []);
  const listing = await eightfoldReader.body?.(
    { platform: "eightfold", id: TAILSPIN_HOST },
    "880000100001",
    board.options,
  );
  assert.equal(listing?.workplace, null);
  assert.equal(listing?.compLow, 265_000);
  assert.deepEqual(detailsRequests(board.requested), []);
});

test("workSiteWorkplace: absent or non-text states nothing", () => {
  assert.equal(workSiteWorkplace(undefined), null);
  assert.equal(workSiteWorkplace(null), null);
  assert.equal(workSiteWorkplace("   "), null);
  assert.equal(workSiteWorkplace(0), null);
  assert.equal(workSiteWorkplace("0 days / week onsite, remote"), "remote");
  assert.equal(workSiteWorkplace("4 days / week in-office"), "onsite");
  assert.equal(workSiteWorkplace(["0 days / week onsite, remote"]), "remote");
  assert.equal(workSiteWorkplace(["Fully on-site"]), "onsite");
  assert.equal(workSiteWorkplace([]), null);
});

test("Amazon: a board that never runs out of pages stops at the cap", async () => {
  let issued = 0;
  const board = endlessBoard(
    () => ({
      jobs: Array.from({ length: 100 }, () => {
        issued += 1;
        return { id_icims: issued, title: "Sr Software Dev Engineer" };
      }),
    }),
    MAX_PAGES * 2,
  );

  const listings = await amazonReader.list({ platform: "amazon", id: "amazon" }, board.options);

  // MAX_PAGES for each of the two search queries amazon.ts walks.
  assert.equal(board.calls(), MAX_PAGES * 2);
  assert.equal(listings.length, MAX_PAGES * 2 * 100);
});

test("Amazon: a job missing id_icims reads as an empty id, never a throw", () => {
  const listings = parseAmazon({ jobs: [{ title: "No id" }] });
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.id, "");
  assert.equal(listings[0]?.title, "No id");
});
