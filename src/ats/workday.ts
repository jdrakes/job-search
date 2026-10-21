// Workday's CXS search API: a listing without a body, and a detail request
// per posting. Measured 2026-10-19 on 12 boards: 421 requisitions pass title
// and place at the pay floor; three narrow title searches listed 104 of them
// in 54 pages, while an empty search lists all 421 in 202 pages (searching
// "engineer", "developer" and "architect" finds the same 421 but takes 313
// pages). So a tenant is read whole, unless it reports over WHOLE_TENANT_LIMIT
// requisitions (25 of 358 boards, 3,187 of the 5,965 pages a whole read of
// every board costs), where it is searched by LARGE_TENANT_QUERIES instead.
import { getJson, htmlToText, postJson, type HttpOptions } from "../net/http.ts";
import type { Board, Workplace } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isRecord,
  MAX_PAGES,
  type Listing,
  type Reader,
} from "./ats.ts";

export const WHOLE_TENANT_LIMIT = 1000;
export const LARGE_TENANT_QUERIES = ["engineer", "developer", "architect"];

const PAGE_SIZE = 20;

// The registry spells a Workday board `{wd}/{site}/{tenant}`:
// "wd5/Cisco_Careers/cisco" for
// https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers.
interface WorkdayId {
  readonly wd: string;
  readonly site: string;
  readonly tenant: string;
}

export function parseWorkdayId(id: string): WorkdayId | null {
  const parts = id.split("/");
  if (parts.length !== 3) return null;
  const [wd, site, tenant] = parts;
  if (!wd || !site || !tenant) return null;
  return { wd, site, tenant };
}

export function cxsUrl(parsed: WorkdayId): string {
  return `https://${parsed.tenant}.${parsed.wd}.myworkdayjobs.com/wday/cxs/${parsed.tenant}/${parsed.site}`;
}

function siteUrl(parsed: WorkdayId): string {
  return `https://${parsed.tenant}.${parsed.wd}.myworkdayjobs.com/${parsed.site}`;
}

// The req number, spelt twice by the vendor: a detail response says
// `jobReqId`, a listing entry `bulletFields[0]`.
function reqNumber(job: Record<string, unknown>): string {
  const direct = job["jobReqId"];
  const bulleted = asArray(job["bulletFields"])[0];
  const req = typeof direct === "string" || typeof direct === "number" ? direct : bulleted;
  return typeof req === "string" || typeof req === "number" ? String(req).trim() : "";
}

// `remoteType` is only on a detail's `jobPostingInfo`, never a listing
// entry. Workday spells "remote but open to hybrid" `Remote/Hybrid`; both
// that and plain `Remote` count as remote.
function workdayWorkplace(value: unknown): Workplace | null {
  if (value === "Remote" || value === "Remote/Hybrid") return "remote";
  if (value === "Hybrid") return "hybrid";
  if (value === "Onsite Only") return "onsite";
  return null;
}

// From a listing entry or a detail's `jobPostingInfo`; only a detail has
// `body`/comp/`postedAt` to draw on. `postedOn` ("Posted 4 Days Ago") is
// never read: prose, not a date.
function toListing(job: Record<string, unknown>, path: string, site: string): Listing {
  const body = htmlToText(asText(job["jobDescription"]) ?? "");
  const comp = compInText(body);
  return {
    id: reqNumber(job),
    title: asText(job["title"]),
    url: asText(job["externalUrl"]) ?? (path !== "" ? `${site}${path}` : null),
    location: asText(job["locationsText"]) ?? asText(job["location"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["startDate"]),
    body: body === "" ? null : body,
    workplace: workdayWorkplace(job["remoteType"]),
    requisitionId: null,
  };
}

export function parseWorkdayListing(data: unknown, site: string): Listing[] {
  return asArray(asRecord(data)["jobPostings"]).map((raw) => {
    const job = asRecord(raw);
    return toListing(job, asText(job["externalPath"]) ?? "", site);
  });
}

// `null` when the shape carries no posting: a wrong path answers 200 with
// something else, and that must never read as an empty posting.
export function parseWorkdayDetail(data: unknown, path: string, site: string): Listing | null {
  const info = asRecord(data)["jobPostingInfo"];
  return isRecord(info) ? toListing(info, path, site) : null;
}

interface SearchPage {
  readonly entries: unknown[];
  // `null` when the payload states no total.
  readonly total: number | null;
}

async function searchPage(
  cxs: string,
  query: string,
  offset: number,
  options?: HttpOptions,
): Promise<SearchPage> {
  const payload = { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: query };
  const data = asRecord(await postJson<unknown>(`${cxs}/jobs`, payload, options));
  const total = data["total"];
  return {
    entries: asArray(data["jobPostings"]),
    total: typeof total === "number" ? total : null,
  };
}

// Pages through one search, adding each requisition once to `out`. `first`
// is the already-read page at offset 0, when the caller has it.
async function walkSearch(
  cxs: string,
  query: string,
  first: SearchPage | null,
  seen: Set<string>,
  out: unknown[],
  options?: HttpOptions,
): Promise<void> {
  let offset = 0;
  // Workday states `total` on the offset 0 page only (later pages say 0), so
  // it is kept from there.
  let total: number | null = null;
  // Capped at MAX_PAGES (ats.ts): a board that ignores `offset` offers
  // neither of this loop's other exits.
  for (let page = 0; page < MAX_PAGES; page++) {
    const current =
      page === 0 && first !== null ? first : await searchPage(cxs, query, offset, options);
    const { entries } = current;
    if (page === 0) total = current.total;
    for (const raw of entries) {
      const id = reqNumber(asRecord(raw));
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push(raw);
    }
    if (entries.length === 0) break;
    offset += entries.length;
    if (total !== null && offset >= total) break;
  }
}

async function rawListing(cxs: string, options?: HttpOptions): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const first = await searchPage(cxs, "", 0, options);
  // A payload with no total is read whole: the cap bounds it.
  if (first.total === null || first.total <= WHOLE_TENANT_LIMIT) {
    await walkSearch(cxs, "", first, seen, out, options);
    return out;
  }
  for (const query of LARGE_TENANT_QUERIES) {
    await walkSearch(cxs, query, null, seen, out, options);
  }
  return out;
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const parsed = parseWorkdayId(board.id);
  if (parsed === null) throw new Error(`not a Workday board id: ${JSON.stringify(board.id)}`);
  const site = siteUrl(parsed);
  const raw = await rawListing(cxsUrl(parsed), options);
  return raw.map((entry) => {
    const job = asRecord(entry);
    return toListing(job, asText(job["externalPath"]) ?? "", site);
  });
}

// The listing entry for one requisition, which holds the path the detail
// endpoint is keyed by. A search with the requisition id as its text finds it
// in one request (measured 2026-10-19: 17 of 17 ids across five tenants gave
// exactly that requisition), so that comes first. The whole-listing scan, up
// to MAX_PAGES requests, runs only when the search does not find it.
async function listingEntry(
  cxs: string,
  id: string,
  options?: HttpOptions,
): Promise<Record<string, unknown> | null> {
  const isRequisition = (entry: Record<string, unknown>): boolean => reqNumber(entry) === id;
  const searched = (await searchPage(cxs, id, 0, options)).entries.map(asRecord);
  const hit = searched.find(isRequisition);
  if (hit !== undefined) return hit;
  return (await rawListing(cxs, options)).map(asRecord).find(isRequisition) ?? null;
}

// Uncached: each call searches for the requisition, then reads its detail.
async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const parsed = parseWorkdayId(board.id);
  if (parsed === null) throw new Error(`not a Workday board id: ${JSON.stringify(board.id)}`);
  const cxs = cxsUrl(parsed);
  const site = siteUrl(parsed);
  const entry = await listingEntry(cxs, id, options);
  if (entry === null) return null;
  const path = asText(entry["externalPath"]);
  if (path === null) return null;
  const data = await getJson<unknown>(cxs + path, options);
  return parseWorkdayDetail(data, path, site);
}

export const workdayReader: Reader = { platform: "workday", list, body };
