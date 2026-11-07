// Phenom career sites: a large employer's site on its own host, server-rendered
// with the page's data in a `phApp.ddo` script. Two phases: a search page holds
// ten postings with no text, and a posting's own page holds its description.
// Measured 2026-11-07 on two health systems, 2,338 and 4,163 postings. The
// search walks the whole site by `from`, so a site costs one request per ten
// postings; a board id is the site's host. robots.txt on both leaves the search
// and job pages open. There is no name to probe, so a board is bound by hand.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board, Workplace } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  type Listing,
  type Reader,
} from "./ats.ts";

const PAGE_SIZE = 10;
// Above the largest site measured, against a site that never stops offering.
const MAX_SEARCH_PAGES = 1000;

const WORKPLACES: Readonly<Record<string, Workplace>> = {
  ORA_ON_SITE: "onsite",
  ORA_REMOTE: "remote",
  ORA_HYBRID: "hybrid",
};

// The data object assigned in the page. A page with none throws: a site that
// changed its shape must fail the read rather than read as an empty board.
export function parsePhenomData(html: string): Record<string, unknown> {
  const marker = html.search(/phApp\.ddo\s*=\s*\{/);
  if (marker === -1) throw new Error("phenom: page has no phApp.ddo");
  const start = html.indexOf("{", marker);
  return asRecord(jsonPrefix(html.slice(start)));
}

// One JSON object from the start of `text`, which goes on past it. JSON.parse
// takes no prefix, so the closing brace is found first, skipping strings.
function jsonPrefix(text: string): unknown {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(0, index + 1));
    }
  }
  throw new Error("phenom: phApp.ddo never closes");
}

function jobUrl(boardId: string, id: string): string {
  return `https://${boardId}/us/en/job/${id}`;
}

function locationOf(job: Record<string, unknown>): string | null {
  const places = asArray(job["multi_location"]).flatMap((place) => asText(place) ?? []);
  return places.length > 0 ? places.join("; ") : asText(job["location"]);
}

function workplaceOfStatus(job: Record<string, unknown>): Workplace | null {
  return WORKPLACES[asText(job["psRemoteStatus"]) ?? ""] ?? null;
}

export function parsePhenomSearch(
  html: string,
  boardId: string,
): { readonly listings: Listing[]; readonly total: number } {
  const search = asRecord(parsePhenomData(html)["eagerLoadRefineSearch"]);
  const listings: Listing[] = [];
  for (const raw of asArray(asRecord(search["data"])["jobs"])) {
    const job = asRecord(raw);
    const id = asText(job["jobId"]);
    if (id === null) continue;
    const comp = compInText(asText(job["salaryPayRange"]) ?? "");
    listings.push({
      id,
      title: asText(job["title"]),
      url: jobUrl(boardId, id),
      location: locationOf(job),
      compLow: comp?.compLow ?? null,
      compHigh: comp?.compHigh ?? null,
      postedAt: isoDate(job["postedDate"]),
      body: null,
      workplace: workplaceOfStatus(job),
      requisitionId: asText(job["reqId"]),
    });
  }
  const total = search["totalHits"];
  return { listings, total: typeof total === "number" ? total : 0 };
}

// Null for a posting the page no longer has.
export function parsePhenomDetail(html: string, boardId: string, id: string): Listing | null {
  const job = asRecord(asRecord(asRecord(parsePhenomData(html)["jobDetail"])["data"])["job"]);
  if (asText(job["jobId"]) === null) return null;
  const body = htmlToText(asText(job["description"]) ?? "");
  const comp = compInText(asText(job["salaryPayRange"]) ?? "") ?? compInText(body);
  return {
    id,
    title: asText(job["title"]),
    url: jobUrl(boardId, id),
    location: locationOf(job),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["postedDate"]),
    body: body === "" ? null : body,
    workplace: workplaceOfStatus(job),
    requisitionId: asText(job["reqId"]),
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const byId = new Map<string, Listing>();
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const html = await getText(
      `https://${board.id}/us/en/search-results?from=${from}&s=1`,
      options,
    );
    const { listings, total } = parsePhenomSearch(html, board.id);
    for (const listing of listings) byId.set(listing.id, listing);
    if (listings.length === 0 || from + PAGE_SIZE >= total) break;
  }
  return [...byId.values()];
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const html = await getText(jobUrl(board.id, id), options);
  return parsePhenomDetail(html, board.id, id);
}

export const phenomReader: Reader = { platform: "phenom", list, body };
