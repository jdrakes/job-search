// Amazon's own career-site search API, single-phase: the full body is in
// the listing. `id` is the literal "amazon": one global board, too large to
// page whole, so the listing is search-scoped on senior-and-up software
// development engineering titles, Amazon's own title convention.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  MAX_PAGES,
  type Listing,
  type Reader,
} from "./ats.ts";

const QUERIES = ["senior software development engineer", "principal software development engineer"];

// The vendor's clamp: a larger `result_limit` answers an error.
const PAGE_SIZE = 100;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// Amazon dates a posting as prose ("September 12, 2026"). Read by hand
// rather than `Date.parse` + `.toISOString()`: that pair reads a date-only
// string as local midnight and converts to UTC, so the calendar date would
// depend on the timezone running the job.
function amazonDate(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
  if (match === null) return null;
  const month = MONTHS.indexOf((match[1] ?? "").toLowerCase());
  if (month === -1) return null;
  const day = (match[2] ?? "").padStart(2, "0");
  const monthNo = String(month + 1).padStart(2, "0");
  return `${match[3]}-${monthNo}-${day}`;
}

// Body is assembled from all three text fields, as `smartrecruiters.ts`
// joins `jobAd.sections`, so a comp figure in `preferred_qualifications`
// is still reached.
export function parseAmazon(data: unknown): Listing[] {
  return asArray(asRecord(data)["jobs"]).map((raw) => {
    const job = asRecord(raw);
    const rawBody = ["basic_qualifications", "description", "preferred_qualifications"]
      .map((key) => asText(job[key]) ?? "")
      .join(" ");
    const body = htmlToText(rawBody);
    const comp = compInText(body);
    const path = asText(job["job_path"]);
    return {
      id: String(job["id_icims"] ?? ""),
      title: asText(job["title"]),
      url: path !== null ? `https://www.amazon.jobs${path}` : null,
      location: asText(job["normalized_location"]),
      compLow: comp?.compLow ?? null,
      compHigh: comp?.compHigh ?? null,
      postedAt: amazonDate(job["posted_date"]),
      body: body === "" ? null : body,
      workplace: null,
    };
  });
}

function searchUrl(query: string, offset: number): string {
  const params = new URLSearchParams({
    base_query: query,
    result_limit: String(PAGE_SIZE),
    offset: String(offset),
    sort: "recent",
  });
  // `URLSearchParams` percent-encodes the literal "[]"; `append` lets this
  // coexist with the plain keys above.
  params.append("normalized_country_code[]", "USA");
  return `https://www.amazon.jobs/en/search.json?${params.toString()}`;
}

async function listQuery(query: string, options?: HttpOptions): Promise<unknown[]> {
  const out: unknown[] = [];
  let offset = 0;
  // Capped at MAX_PAGES (ats.ts): a board that ignores `offset` offers
  // neither of this loop's other exits.
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = asRecord(await getJson<unknown>(searchUrl(query, offset), options));
    const jobs = asArray(data["jobs"]);
    out.push(...jobs);
    if (jobs.length === 0) break;
    offset += jobs.length;
    const hits = data["hits"];
    if (typeof hits === "number" && out.length >= hits) break;
  }
  return out;
}

// One global board, so `board` carries nothing this function reads.
async function list(_board: Board, options?: HttpOptions): Promise<Listing[]> {
  const seen = new Map<string, unknown>();
  for (const query of QUERIES) {
    for (const raw of await listQuery(query, options)) {
      const id = String(asRecord(raw)["id_icims"] ?? "");
      if (id === "" || seen.has(id)) continue;
      seen.set(id, raw);
    }
  }
  return parseAmazon({ jobs: [...seen.values()] });
}

export const amazonReader: Reader = { platform: "amazon", list };
