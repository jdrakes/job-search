// Rippling's public job-board API: two phases, like SmartRecruiters. The
// listing carries no body, pay or posted date, only the board's own word
// for a location (Ruling 1: `posted_at` stays null for every Rippling row).
// The detail states structured pay per `payRangeDetails` entry, the way
// Ashby states it per compensation tier.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board, Workplace } from "../schema.ts";
import { asArray, asRecord, asText, compInText, isUsd, type Listing, type Reader } from "./ats.ts";

// Rippling's own word for a location's workplace is a prefix on the label,
// not a separate field: "Remote (Washington, DC, US)", "Hybrid (Livermore,
// California, US)". Anything else (a bare city, "CA", "Canada") states no
// workplace, never a guess (Ruling 4).
function ripplingWorkplace(label: string | null): Workplace | null {
  if (label === null) return null;
  if (label.startsWith("Remote (")) return "remote";
  if (label.startsWith("Hybrid (")) return "hybrid";
  return null;
}

function trimmedTitle(value: unknown): string | null {
  const text = asText(value);
  return text !== null ? text.trim() : null;
}

// A posting listed under several locations is offered at each; one that is
// offered remote is remote, whichever entry the board writes first.
function preferRemote(labels: readonly string[]): string | null {
  return labels.find((label) => label.startsWith("Remote (")) ?? labels[0] ?? null;
}

function fromListingGroup(group: readonly Record<string, unknown>[]): Listing {
  const job = group[0];
  const labels = group
    .map((entry) => asText(asRecord(entry["workLocation"])["label"]))
    .filter((label): label is string => label !== null);
  const location = preferRemote(labels);
  return {
    id: String(job["uuid"] ?? ""),
    title: trimmedTitle(job["name"]),
    url: asText(job["url"]),
    location,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: ripplingWorkplace(location),
  };
}

// Rippling answers HTTP 404 (body `{"error_code":"RESOURCE_NOT_FOUND"}`)
// for a slug that does not exist, which `getJson` throws before this runs;
// a real board with nothing open answers `[]`. Anything that is not an
// array is read as no postings.
//
// The board lists a posting once per work location it is offered at, same
// `uuid`, different `workLocation.label`; grouped here so `ingest` (which
// keys by id) sees one row per posting, not one per location. A record
// with no `uuid` (empty after `String(...)`) never merges with another.
// Each stays its own listing, so the "listing with no id" error path in
// `ingest` still sees it.
export function parseRipplingListing(data: unknown): Listing[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  let anonymous = 0;
  for (const raw of asArray(data)) {
    const job = asRecord(raw);
    const uuid = String(job["uuid"] ?? "");
    const key = uuid === "" ? `anonymous-${anonymous++}` : `id-${uuid}`;
    const group = groups.get(key);
    if (group) group.push(job);
    else {
      groups.set(key, [job]);
    }
  }
  return [...groups.values()].map(fromListingGroup);
}

// The widest USD-a-year range across `payRangeDetails`' entries: the
// lowest stated `rangeStart` paired with the highest stated `rangeEnd`, as
// `tierSalaryValues` in ashby.ts takes the widest range across tiers. An
// entry in another currency or period is not read (`isUsd`, ats.ts).
function payRangeComp(entries: unknown): { compLow: number; compHigh: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const raw of asArray(entries)) {
    const entry = asRecord(raw);
    if (!isUsd(entry["currency"]) || entry["frequency"] !== "YEAR") continue;
    const start = entry["rangeStart"];
    if (typeof start === "number" && Number.isFinite(start)) starts.push(start);
    const end = entry["rangeEnd"];
    if (typeof end === "number" && Number.isFinite(end)) ends.push(end);
  }
  if (starts.length === 0 || ends.length === 0) return null;
  return { compLow: Math.min(...starts), compHigh: Math.max(...ends) };
}

export function parseRipplingDetail(raw: unknown): Listing {
  const job = asRecord(raw);
  const workLocationLabels = asArray(job["workLocations"])
    .map((entry) => asText(entry))
    .filter((label): label is string => label !== null);
  const location = preferRemote(workLocationLabels);
  const body = htmlToText(
    [asText(asRecord(job["description"])["company"]), asText(asRecord(job["description"])["role"])]
      .filter((part): part is string => part !== null)
      .join(" "),
  );
  const comp = payRangeComp(job["payRangeDetails"]) ?? compInText(body);
  return {
    id: String(job["uuid"] ?? ""),
    title: trimmedTitle(job["name"]),
    url: asText(job["url"]),
    location,
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    // Ruling 1: `createdOn` is present on the detail but not read.
    postedAt: null,
    body: body === "" ? null : body,
    workplace: ripplingWorkplace(location),
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(
    `https://api.rippling.com/platform/api/ats/v1/board/${board.id}/jobs`,
    options,
  );
  return parseRipplingListing(data);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const data = await getJson<unknown>(
    `https://api.rippling.com/platform/api/ats/v1/board/${board.id}/jobs/${id}`,
    options,
  );
  return parseRipplingDetail(data);
}

export const ripplingReader: Reader = { platform: "rippling", list, body };
