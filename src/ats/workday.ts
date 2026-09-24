// Workday's CXS search API: a listing without a body, and a detail request
// per posting. A large tenant publishes over a thousand open reqs, so the
// listing is search-scoped, as Amazon's is: too narrow a set silently
// undercounts a board, too broad wastes requests.
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

const QUERIES = ["staff software engineer", "senior staff engineer", "principal engineer"];

const PAGE_SIZE = 20;

// The registry spells a Workday board `{wd}/{site}/{tenant}`:
// "wd5/Cisco_Careers/cisco" for
// https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers.
interface WorkdayId {
  readonly wd: string;
  readonly site: string;
  readonly tenant: string;
}

function parseWorkdayId(id: string): WorkdayId | null {
  const parts = id.split("/");
  if (parts.length !== 3) return null;
  const [wd, site, tenant] = parts;
  if (!wd || !site || !tenant) return null;
  return { wd, site, tenant };
}

function cxsUrl(parsed: WorkdayId): string {
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

async function rawListing(cxs: string, options?: HttpOptions): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const query of QUERIES) {
    let offset = 0;
    // Capped at MAX_PAGES (ats.ts): a board that ignores `offset` offers
    // neither of this loop's other exits.
    for (let page = 0; page < MAX_PAGES; page++) {
      const payload = { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: query };
      const data = asRecord(await postJson<unknown>(`${cxs}/jobs`, payload, options));
      const entries = asArray(data["jobPostings"]);
      for (const raw of entries) {
        const id = reqNumber(asRecord(raw));
        if (id === "" || seen.has(id)) continue;
        seen.add(id);
        out.push(raw);
      }
      if (entries.length === 0) break;
      offset += entries.length;
      const total = data["total"];
      if (typeof total === "number" && offset >= total) break;
    }
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

// Costs a fresh scan of every query first: the detail endpoint is keyed by
// the posting's path, which only a listing entry hands out. Uncached.
async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const parsed = parseWorkdayId(board.id);
  if (parsed === null) throw new Error(`not a Workday board id: ${JSON.stringify(board.id)}`);
  const cxs = cxsUrl(parsed);
  const site = siteUrl(parsed);
  const raw = await rawListing(cxs, options);
  const entry = raw.find((item) => reqNumber(asRecord(item)) === id);
  if (entry === undefined) return null;
  const path = asText(asRecord(entry)["externalPath"]);
  if (path === null) return null;
  const data = await getJson<unknown>(cxs + path, options);
  return parseWorkdayDetail(data, path, site);
}

export const workdayReader: Reader = { platform: "workday", list, body };
