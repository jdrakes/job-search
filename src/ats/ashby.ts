// Ashby's public job board API: one request per company returns every open
// posting, body and structured compensation included. This reader takes the
// widest range across every annual-US-dollar `Salary` component of every
// tier; which figure is base and which on-target is the processor's
// judgment. Another currency or period is not read (`isUsd`, ats.ts).
//
// A company can turn the public API off (it answers 404) while its hosted
// board stays up. That board is read through the GraphQL endpoint the hosted
// page itself calls, list only: one request per board. The list states no
// description and no date, so a hosted board's text comes from
// `hostedDetailRead`, once the operator's settings name the board. A board
// the hosted page does not have either keeps the API's 404, so it is still
// `gone`.
import { getJson, HttpError, htmlToText, postJson, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isUsd,
  workplaceOf,
  type DetailRead,
  type Listing,
  type Reader,
} from "./ats.ts";

// How Ashby spells "a year" in a component's `interval`.
const ANNUAL = "1 YEAR";

function tierSalaryValues(tiers: readonly unknown[]): number[] {
  const values: number[] = [];
  for (const tierRaw of tiers) {
    for (const componentRaw of asArray(asRecord(tierRaw)["components"])) {
      const component = asRecord(componentRaw);
      if (component["compensationType"] !== "Salary") continue;
      if (!isUsd(component["currencyCode"]) || component["interval"] !== ANNUAL) continue;
      for (const key of ["minValue", "maxValue"]) {
        const value = component[key];
        if (typeof value === "number" && Number.isFinite(value)) values.push(value);
      }
    }
  }
  return values;
}

function toListing(raw: unknown): Listing {
  const job = asRecord(raw);
  const body = htmlToText(asText(job["descriptionPlain"]) ?? asText(job["descriptionHtml"]) ?? "");
  const tiers = asArray(asRecord(job["compensation"])["compensationTiers"]);
  const values = tierSalaryValues(tiers);
  // Structured wins over a range in the prose.
  const structured =
    values.length > 0 ? { compLow: Math.min(...values), compHigh: Math.max(...values) } : null;
  const comp = structured ?? compInText(body);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["title"]),
    url: asText(job["jobUrl"]),
    location: asText(job["location"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["publishedAt"]),
    body: asText(body),
    workplace: workplaceOf(job["workplaceType"]),
    requisitionId: null,
  };
}

export function parseAshby(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map(toListing);
}

const HOSTED_GRAPHQL = "https://jobs.ashbyhq.com/api/non-user-graphql";

const HOSTED_BOARD_QUERY =
  "query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { " +
  "jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) " +
  "{ jobPostings { id title locationName workplaceType compensationTierSummary } } }";

// The hosted board's postings as listings; null when the hosted page has no
// such board. A reply with no `data` at all is an error, not an absent
// board. The summary states the band ("$190K – $270K • Offers Equity").
export function parseHostedBoard(reply: unknown, boardId: string): Listing[] | null {
  const record = asRecord(reply);
  if (!("data" in record)) throw new Error("ashby hosted board: reply has no data");
  const jobBoard = asRecord(record["data"])["jobBoard"];
  if (jobBoard === null || jobBoard === undefined) return null;
  const listings: Listing[] = [];
  for (const raw of asArray(asRecord(jobBoard)["jobPostings"])) {
    const posting = asRecord(raw);
    const id = asText(posting["id"]);
    if (id === null) continue;
    const comp = compInText(asText(posting["compensationTierSummary"]) ?? "");
    listings.push({
      id,
      title: asText(posting["title"]),
      url: `https://jobs.ashbyhq.com/${boardId}/${id}`,
      location: asText(posting["locationName"]),
      compLow: comp?.compLow ?? null,
      compHigh: comp?.compHigh ?? null,
      postedAt: null,
      body: null,
      workplace: workplaceOf(posting["workplaceType"]),
      requisitionId: null,
    });
  }
  return listings;
}

const HOSTED_POSTING_QUERY =
  "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { " +
  "jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) " +
  "{ id title locationName workplaceType descriptionHtml compensationTierSummary } }";

// One hosted posting as a listing; null when the posting has closed. A reply
// with no `data` at all is an error, so the judge retries next run. The
// summary's band wins over a band in the prose.
export function parseHostedPosting(reply: unknown, boardId: string): Listing | null {
  const record = asRecord(reply);
  if (!("data" in record)) throw new Error("ashby hosted posting: reply has no data");
  const jobPosting = asRecord(record["data"])["jobPosting"];
  if (jobPosting === null || jobPosting === undefined) return null;
  const posting = asRecord(jobPosting);
  const id = asText(posting["id"]) ?? "";
  const body = asText(htmlToText(asText(posting["descriptionHtml"]) ?? ""));
  const comp =
    compInText(asText(posting["compensationTierSummary"]) ?? "") ?? compInText(body ?? "");
  return {
    id,
    title: asText(posting["title"]),
    url: `https://jobs.ashbyhq.com/${boardId}/${id}`,
    location: asText(posting["locationName"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: null,
    body,
    workplace: workplaceOf(posting["workplaceType"]),
    requisitionId: null,
  };
}

// The per-posting read for a hosted board, named by the operator's settings.
export function hostedDetailRead(board: string): DetailRead {
  return {
    platform: "ashby",
    board,
    async body(id, options) {
      const reply = await postJson<unknown>(
        `${HOSTED_GRAPHQL}?op=ApiJobPosting`,
        {
          operationName: "ApiJobPosting",
          variables: { organizationHostedJobsPageName: board, jobPostingId: id },
          query: HOSTED_POSTING_QUERY,
        },
        options,
      );
      return parseHostedPosting(reply, board);
    },
  };
}

async function listHosted(
  board: Board,
  refused: HttpError,
  options?: HttpOptions,
): Promise<Listing[]> {
  const reply = await postJson<unknown>(
    `${HOSTED_GRAPHQL}?op=ApiJobBoardWithTeams`,
    {
      operationName: "ApiJobBoardWithTeams",
      variables: { organizationHostedJobsPageName: board.id },
      query: HOSTED_BOARD_QUERY,
    },
    options,
  );
  const listings = parseHostedBoard(reply, board.id);
  if (listings === null) throw refused;
  return listings;
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  let data: unknown;
  try {
    data = await getJson<unknown>(
      `https://api.ashbyhq.com/posting-api/job-board/${board.id}?includeCompensation=true`,
      options,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return listHosted(board, err, options);
    throw err;
  }
  return parseAshby(data);
}

export const ashbyReader: Reader = { platform: "ashby", list };
