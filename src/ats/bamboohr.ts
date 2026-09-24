// BambooHR's public careers board: two phases (plan Ruling 3). The listing
// (${board}.bamboohr.com/careers/list) states no date and no body - only
// id, name and two location shapes, confirmed unpaged on a complete 4-of-4
// board (fetched live 2026-09-22). The detail
// (${board}.bamboohr.com/careers/${id}/detail) is undocumented but live,
// clean JSON: it alone states `datePosted` and a `compensation` string with
// no currency/period field - one live posting's "$30.00 -$70.00"
// reads as hourly and never matches compInText's own
// four-digit-minimum regex (ats.ts), which is the honest absence of
// structured comp on this platform, not a gap in the parser.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  type Listing,
  type Reader,
} from "./ats.ts";

// BambooHR's own placeholder for "no specific city within this state or
// country" - every posting on the board checked states it rather than
// leaving city null, so it has to be dropped explicitly or it reads as a
// real place name.
const NO_CITY = "All";

// `atsLocation` (city/state/country) carries a usable place on every
// posting checked; `location` (city/state only) is the field
// mapping table's stated fallback for a board that leaves atsLocation
// empty. No live posting checked exercises that fallback - it is proven
// only by an edited fixture in the tests.
function bambooHrLocation(job: Record<string, unknown>): string | null {
  const atsLocation = asRecord(job["atsLocation"]);
  const atsParts = [atsLocation["city"], atsLocation["state"], atsLocation["country"]]
    .map(asText)
    .filter((part): part is string => part !== null && part !== NO_CITY);
  if (atsParts.length > 0) return atsParts.join(", ");

  const location = asRecord(job["location"]);
  const parts = [asText(location["city"]), asText(location["state"])].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function fromListingEntry(raw: unknown): Listing {
  const job = asRecord(raw);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["jobOpeningName"]),
    // No URL field on a listing entry; `list` (below) fills this in once
    // it knows the board id, the same way Jobvite's detail parser leaves
    // its own url for the caller to fill.
    url: null,
    location: bambooHrLocation(job),
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: null,
  };
}

export function parseBambooHrListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["result"]).map(fromListingEntry);
}

// `compensation` (e.g. "$30.00 -$70.00", the detail fixture) has no
// paired currency or period field, so it is folded into the body text as a
// sentence and left to compInText rather than read as structured comp
// (Ruling 3).
function detailBody(job: Record<string, unknown>): string {
  const description = htmlToText(asText(job["description"]) ?? "");
  const compensation = asText(job["compensation"]);
  return (
    compensation !== null ? `${description} Compensation: ${compensation}.` : description
  ).trim();
}

export function parseBambooHrDetail(raw: unknown): Listing {
  const job = asRecord(asRecord(asRecord(raw)["result"])["jobOpening"]);
  const body = detailBody(job);
  const comp = compInText(body);
  return {
    // The detail's own jobOpening object states no id field at all; the
    // caller (`body`, below) supplies the real one.
    id: "",
    title: asText(job["jobOpeningName"]),
    url: asText(job["jobOpeningShareUrl"]),
    location: bambooHrLocation(job),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["datePosted"]),
    body: asText(body),
    workplace: null,
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(`https://${board.id}.bamboohr.com/careers/list`, options);
  return parseBambooHrListing(data).map((listing) => ({
    ...listing,
    url: `https://${board.id}.bamboohr.com/careers/${listing.id}`,
  }));
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const data = await getJson<unknown>(
    `https://${board.id}.bamboohr.com/careers/${id}/detail`,
    options,
  );
  return { ...parseBambooHrDetail(data), id };
}

export const bambooHrReader: Reader = { platform: "bamboohr", list, body };
