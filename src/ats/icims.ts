// iCIMS's public job-search API, read through a tenant's `jibeapply.com`
// front end (never `icims.com`, which only serves the applicant-login
// flow). One-phase: `description`, `qualifications` and `responsibilities`
// are all already on the listing call, so there is no separate detail
// endpoint (Ruling 2).
//
// Each entry answers `{data: {...}}`; the job's own `url` is built from
// `data.meta_data.client_code`, not `data.meta_data.canonical_url` and not
// a `board`/host parameter. Confirmed live 2026-09-22 against two tenants:
// a top-level `client_code` exists on one and is absent on the other,
// while `meta_data.client_code` is present and correct on both;
// `canonical_url` cannot be trusted at all — a posting on one of the two
// states a `canonical_url` on a host belonging to an unrelated company,
// evidently a copy-paste error in that tenant's own iCIMS config.
// `apply_url` points at the applicant login flow, not a public posting
// page, and is never read into `url` either.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  MAX_PAGES,
  type Listing,
  type Reader,
} from "./ats.ts";

const PAGE_SIZE = 100;

function jobUrl(clientCode: string | null, reqId: string): string | null {
  return clientCode !== null && reqId !== ""
    ? `https://${clientCode}.jibeapply.com/jobs/${reqId}`
    : null;
}

// "ANY" is iCIMS's word for fully remote (confirmed against a US-remote
// posting); "LAT_LNG" is a fixed point on a map, i.e. a desk somewhere
// (confirmed against every retail posting checked on the second tenant).
// No tenant checked states a third value, so nothing else is read as
// hybrid.
function workplaceOfLocationType(value: unknown): "remote" | "onsite" | null {
  if (value === "ANY") return "remote";
  if (value === "LAT_LNG") return "onsite";
  return null;
}

function toListing(raw: unknown): Listing {
  const job = asRecord(asRecord(raw)["data"]);
  const meta = asRecord(job["meta_data"]);
  const clientCode = asText(meta["client_code"]);
  const reqId = String(job["req_id"] ?? "");
  const bodyText = htmlToText(
    ["description", "qualifications", "responsibilities"]
      .map((key) => asText(job[key]) ?? "")
      .join(" "),
  );
  // `salary_value`/`salary_min_value`/`salary_max_value`: present and `0`
  // on every posting checked on one tenant, entirely absent as keys on
  // all ten checked on the other (a key-membership difference, not just a
  // zero value). Neither shape ever carries a paired currency field, so
  // structured comp is never read here on either tenant — only a stated
  // range in the prose.
  const comp = compInText(bodyText);
  return {
    id: reqId,
    title: asText(job["title"]),
    url: jobUrl(clientCode, reqId),
    location: asText(job["full_location"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["posted_date"]),
    body: bodyText === "" ? null : bodyText,
    workplace: workplaceOfLocationType(job["location_type"]),
  };
}

export function parseIcimsListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map(toListing);
}

// Confirmed live against a 1047-posting board: `page=2` (with `limit=5`)
// returns the next five distinct postings, while `offset=100`, `from=100`,
// `start=100` and `skip=100` all silently answer the same first page as no
// page parameter at all. `page` is 1-indexed — `page=0` answers an empty
// array, and omitting `page` answers the same as `page=1`. A page shorter
// than the requested limit is the last one (confirmed: that same board,
// grown to 1075 postings, answered 100 for ten pages, 75 on page 11, then
// an empty page 12) — checking for a short page, not a stated total, is
// what stops the walk here.
async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const out: Listing[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await getJson<unknown>(
      `https://${board.id}.jibeapply.com/api/jobs?limit=${PAGE_SIZE}&page=${page}`,
      options,
    );
    const entries = parseIcimsListing(data);
    out.push(...entries);
    if (entries.length < PAGE_SIZE) break;
  }
  return out;
}

export const icimsReader: Reader = { platform: "icims", list };
