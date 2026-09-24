// Eightfold's job-board API: a listing without a body, and a detail request
// per posting. Two generations of the list API answer at the same shape of
// URL, a property of the board, not its hostname: `explore.jobs.netflix.net`
// answers `/api/apply/v2/jobs` with `{positions, count}` at the top level;
// `apply.careers.microsoft.com` answers only `/api/pcsx/search`, nesting
// the same shape under `data`. The first to answer the expected shape is
// kept for the rest of the call.
import { getJson, htmlToText, HttpError, type HttpOptions } from "../net/http.ts";
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

// Clamped to 10 by the server regardless of what is asked for.
const PAGE_SIZE = 10;

function v2Url(host: string, start: number, num: number): string {
  return `https://${host}/api/apply/v2/jobs?start=${start}&num=${num}`;
}

function pcsxUrl(host: string, domain: string, start: number, num: number): string {
  const query = new URLSearchParams({
    domain,
    start: String(start),
    num: String(num),
    sort_by: "relevance",
  });
  return `https://${host}/api/pcsx/search?${query.toString()}`;
}

function detailUrl(host: string, domain: string, req: string): string {
  return `https://${host}/api/apply/v2/jobs/${req}?${new URLSearchParams({ domain }).toString()}`;
}

// The one Eightfold host whose postings carry a custom "Work site" field;
// Netflix's do not, so the read is keyed on the host, not the platform.
const MICROSOFT_HOST = "apply.careers.microsoft.com";

function positionDetailsUrl(host: string, domain: string, id: string): string {
  const query = new URLSearchParams({ position_id: id, domain, hl: "en" });
  return `https://${host}/api/pcsx/position_details?${query.toString()}`;
}

// Microsoft's "Work site" field, a one-element array: `0 days / week
// in-office - remote`, `3 days / week in-office`, `Fully on-site`. Only the
// zero-days form is remote; any other stated value is a desk somewhere.
export function workSiteWorkplace(field: unknown): Workplace | null {
  const text = Array.isArray(field) ? field[0] : field;
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "") return null;
  return /^0 days/.test(value) ? "remote" : "onsite";
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

// Under a burst the host answers 404 for postings that exist; one more read
// after the host's pacing tells that from a posting that is gone. A second
// 404 answers null, and the caller records the posting without a workplace.
async function positionDetails(url: string, options?: HttpOptions): Promise<unknown> {
  try {
    return await getJson<unknown>(url, options);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    return await getJson<unknown>(url, options);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return null;
  }
}

// The board's domain, as Eightfold's search filters it; not always
// derivable from the hostname (`explore.jobs.netflix.net` answers to
// "netflix.com"). v2 answers with no domain and states its true domain in
// the payload, so that is asked first. A pcsx board, which requires a
// domain just to answer, falls back to the host's last two labels; one
// whose domain doesn't reduce that way answers nothing, which ingest
// records as a board error.
function guessDomain(host: string): string {
  return host.split(".").slice(-2).join(".");
}

interface EightfoldPage {
  readonly positions: readonly unknown[];
  readonly count: number;
  readonly domain: string | null;
}

// An exception when the payload matches neither shape: how a wrong host is
// told from a board with zero open positions.
function readPage(payload: unknown): EightfoldPage {
  const outer = asRecord(payload);
  for (const scope of [outer, asRecord(outer["data"])]) {
    if (Array.isArray(scope["positions"]) && typeof scope["count"] === "number") {
      return {
        positions: scope["positions"],
        count: scope["count"],
        domain: asText(outer["domain"]),
      };
    }
  }
  throw new Error("not an Eightfold listing: no positions/count");
}

// From a listing entry or the detail endpoint; only a detail has a body.
// Dates are epoch seconds, a number on the list endpoint and a string of
// digits on the detail endpoint (`isoDate`, ats.ts, handles both).
export function parseEightfoldJob(raw: unknown, host: string): Listing {
  const p = asRecord(raw);
  const locations = asArray(p["locations"])
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("; ");
  const location = asText(p["location"]) ?? (locations !== "" ? locations : null);
  let url = asText(p["canonicalPositionUrl"]) ?? asText(p["positionUrl"]);
  if (url !== null && url.startsWith("/")) {
    url = `https://${host}${url}`; // pcsx listings give a path, not an absolute URL
  }
  const body = htmlToText(asText(p["job_description"]) ?? "");
  const comp = compInText(body);
  return {
    id: String(p["id"] ?? ""),
    title: asText(p["name"]),
    url,
    location,
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(p["t_update"] ?? p["postedTs"]),
    body: body === "" ? null : body,
    workplace: null,
  };
}

export function parseEightfoldListing(data: unknown, host: string): Listing[] {
  return readPage(data).positions.map((raw) => parseEightfoldJob(raw, host));
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const host = board.id;
  let domain: string;
  let pageUrl: (start: number) => string;
  let first: EightfoldPage;
  try {
    first = readPage(await getJson<unknown>(v2Url(host, 0, PAGE_SIZE), options));
    domain = first.domain ?? guessDomain(host);
    pageUrl = (start) => v2Url(host, start, PAGE_SIZE);
  } catch {
    domain = guessDomain(host);
    pageUrl = (start) => pcsxUrl(host, domain, start, PAGE_SIZE);
    first = readPage(await getJson<unknown>(pageUrl(0), options));
  }
  const positions: unknown[] = [...first.positions];
  let count = first.count;
  let start = first.positions.length;
  // The first page above counts against MAX_PAGES (ats.ts): a board that
  // ignores `start` offers neither of this loop's other exits.
  let pages = 1;
  while (first.positions.length > 0 && positions.length < count && pages < MAX_PAGES) {
    const page = readPage(await getJson<unknown>(pageUrl(start), options));
    pages += 1;
    positions.push(...page.positions);
    count = page.count;
    if (page.positions.length === 0) break;
    start += page.positions.length;
  }
  return positions.map((raw) => parseEightfoldJob(raw, host));
}

// From the smallest page that answers. Uncached, so `body` pays one extra
// small request every call.
async function resolveDomain(host: string, options?: HttpOptions): Promise<string> {
  try {
    const first = readPage(await getJson<unknown>(v2Url(host, 0, 1), options));
    return first.domain ?? guessDomain(host);
  } catch {
    const domain = guessDomain(host);
    readPage(await getJson<unknown>(pcsxUrl(host, domain, 0, 1), options));
    return domain;
  }
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const host = board.id;
  const domain = await resolveDomain(host, options);
  const data = await getJson<unknown>(detailUrl(host, domain, id), options);
  if (!isRecord(data)) return null;
  const listing = parseEightfoldJob(data, host);
  if (host !== MICROSOFT_HOST) return listing;
  const details = await positionDetails(positionDetailsUrl(host, domain, id), options);
  const field = asRecord(asRecord(details)["data"])["efcustomTextWorkSite"];
  return { ...listing, workplace: workSiteWorkplace(field) };
}

export const eightfoldReader: Reader = { platform: "eightfold", list, body };
