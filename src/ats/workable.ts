// Workable's public job-board API: two phases, like SmartRecruiters. The
// v1 listing carries no body or structured pay, only the board's account
// `name` and every open job (Beacondex: 186 in one page). The v2 detail per
// posting states structured pay in `salary_from`/`salary_to` when the
// account has opted into pay transparency; the account's `name` is read by
// the probe (probe.ts), not here.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board, Workplace } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isUsd,
  type Listing,
  type Reader,
} from "./ats.ts";

function joinLocation(parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== "");
  return kept.length > 0 ? kept.join(", ") : null;
}

// The detail spells on-site `"on_site"`, a word `workplaceOf` (ats.ts)
// does not know since `WORKPLACES` (schema.ts) spells it `onsite`.
export function workableWorkplace(value: unknown): Workplace | null {
  if (value === "remote") return "remote";
  if (value === "hybrid") return "hybrid";
  if (value === "on_site") return "onsite";
  return null;
}

function fromListingEntry(raw: unknown): Listing {
  const job = asRecord(raw);
  return {
    id: String(job["shortcode"] ?? ""),
    title: asText(job["title"]),
    url: asText(job["url"]),
    location: joinLocation([asText(job["city"]), asText(job["state"]), asText(job["country"])]),
    compLow: null,
    compHigh: null,
    postedAt: isoDate(job["published_on"]),
    body: null,
    workplace: job["telecommuting"] === true ? "remote" : null,
  };
}

export function parseWorkableListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map(fromListingEntry);
}

function statedComp(job: Record<string, unknown>): { compLow: number; compHigh: number } | null {
  const salaryFrom = job["salary_from"];
  const salaryTo = job["salary_to"];
  if (
    typeof salaryFrom === "number" &&
    Number.isFinite(salaryFrom) &&
    typeof salaryTo === "number" &&
    Number.isFinite(salaryTo) &&
    isUsd(job["salary_currency_iso_code"]) &&
    job["salary_frequency"] === "year"
  ) {
    return { compLow: salaryFrom, compHigh: salaryTo };
  }
  return null;
}

export function parseWorkableDetail(raw: unknown): Listing {
  const job = asRecord(raw);
  const location = asRecord(job["location"]);
  const shortcode = asText(job["shortcode"]);
  const body = htmlToText(
    [asText(job["description"]), asText(job["requirements"]), asText(job["benefits"])]
      .filter((part): part is string => part !== null)
      .join(" "),
  );
  const comp = statedComp(job) ?? compInText(body);
  return {
    id: shortcode ?? "",
    title: asText(job["title"]),
    url: shortcode !== null ? `https://apply.workable.com/j/${shortcode}` : null,
    location: joinLocation([
      asText(location["city"]),
      asText(location["region"]),
      asText(location["country"]),
    ]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["published"]),
    body: body === "" ? null : body,
    workplace: workableWorkplace(job["workplace"]),
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(
    `https://apply.workable.com/api/v1/widget/accounts/${board.id}`,
    options,
  );
  return parseWorkableListing(data);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const data = await getJson<unknown>(
    `https://apply.workable.com/api/v2/accounts/${board.id}/jobs/${id}`,
    options,
  );
  return parseWorkableDetail(data);
}

export const workableReader: Reader = { platform: "workable", list, body };
