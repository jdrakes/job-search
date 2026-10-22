// ClearCompany's public careers site, which replaced HRMDirect: every
// `{slug}.hrmdirect.com` now redirects here (checked live 2026-10-22).
// Two requests per board, one phase. The board page,
// `apply.clearcompany.com/{slug}`, carries no jobs: it names the site's
// UUID in a `data-site-id` attribute on the widget script, and an unknown
// slug answers 404. The careers API, `careers-api.clearcompany.com/v1/{site}`,
// then answers every open job with its body in one unpaged response
// (`totalCount` equals `currentPageCount`, checked on five boards).
import { getJson, getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import { asArray, asRecord, asText, type Listing, type Reader } from "./ats.ts";

const SITE_ID = /data-site-id="([0-9a-f-]+)"/i;

export function parseClearcompanySiteId(html: string): string | null {
  return SITE_ID.exec(html)?.[1] ?? null;
}

function isRemote(job: Record<string, unknown>): boolean {
  return asArray(job["locations"]).some((place) => asRecord(place)["isRemote"] === true);
}

// The salary fields are strings ("95000"), and "0" stands for a side left
// blank. Annual pay usually states no `salaryType` at all, so only "Per
// Hour" is refused: an hourly "30" would otherwise read as $30 a year.
function pay(job: Record<string, unknown>, field: string): number | null {
  if (job["salaryType"] === "Per Hour") return null;
  const value = Number(asText(job[field]) ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

// "2026-10-08T00:00:00" carries no zone, so `isoDate` would read it as
// local midnight and could move it a day; the date part is taken as written.
function postedOn(value: unknown): string | null {
  return /^\d{4}-\d{2}-\d{2}/.exec(asText(value) ?? "")?.[0] ?? null;
}

function toListing(raw: unknown): Listing {
  const job = asRecord(raw);
  const remote = isRemote(job);
  const body = htmlToText(asText(job["description"]) ?? "");
  return {
    id: String(job["id"] ?? ""),
    title: asText(asText(job["positionTitle"])?.trim()),
    url: asText(job["applyLink"]),
    location: remote ? "Remote" : asText(job["location"]),
    compLow: pay(job, "salaryRangeLow"),
    compHigh: pay(job, "salaryRangeHigh"),
    postedAt: postedOn(job["postedDate"]),
    body: asText(body),
    workplace: remote ? "remote" : null,
    requisitionId: null,
  };
}

// A `results` that is not an array reads as no postings; an empty array is
// a board with nothing open.
export function parseClearcompanyListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["results"]).map(toListing);
}

// Read directly: the old HRMDirect redirect lands on
// `/{slug}/redirect?search=true`, not this page.
async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const html = await getText(`https://apply.clearcompany.com/${board.id}`, options);
  const siteId = parseClearcompanySiteId(html);
  if (siteId === null) throw new Error("the page names no ClearCompany site");
  const data = await getJson<unknown>(`https://careers-api.clearcompany.com/v1/${siteId}`, options);
  return parseClearcompanyListing(data);
}

export const clearcompanyReader: Reader = { platform: "clearcompany", list };
