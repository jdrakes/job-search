// SmartRecruiters' public postings API: a listing entry carries no `jobAd`,
// so body and comp cost one request per posting, as on Workday and
// Eightfold. A request for more than 100 answers with 100 regardless, so
// `list` pages by the count actually returned, capped at `MAX_PAGES`
// (ats.ts) against a server that never reports an empty page.
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

function fromListingEntry(raw: unknown): Listing {
  const job = asRecord(raw);
  const location = asRecord(job["location"]);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["name"]),
    url: asText(job["postingUrl"]) ?? asText(job["ref"]),
    location: asText(location["fullLocation"]),
    compLow: null,
    compHigh: null,
    postedAt: isoDate(job["releasedDate"]),
    body: null,
    workplace: location["remote"] === true ? "remote" : null,
  };
}

export function parseSmartRecruitersListing(data: unknown): Listing[] {
  return asArray(asRecord(data)["content"]).map(fromListingEntry);
}

function jobAdText(job: Record<string, unknown>): string {
  const sections = asRecord(asRecord(job["jobAd"])["sections"]);
  const parts = ["jobDescription", "qualifications", "additionalInformation"].map(
    (key) => asText(asRecord(sections[key])["text"]) ?? "",
  );
  return htmlToText(parts.join(" "));
}

export function parseSmartRecruitersDetail(raw: unknown): Listing {
  const job = asRecord(raw);
  const location = asRecord(job["location"]);
  const body = jobAdText(job);
  const comp = compInText(body);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["name"]),
    url: asText(job["postingUrl"]),
    location: asText(location["fullLocation"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["releasedDate"]),
    body: asText(body),
    workplace: location["remote"] === true ? "remote" : null,
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const out: Listing[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson<unknown>(
      `https://api.smartrecruiters.com/v1/companies/${board.id}/postings?offset=${offset}&limit=${PAGE_SIZE}`,
      options,
    );
    const entries = parseSmartRecruitersListing(data);
    out.push(...entries);
    if (entries.length === 0) break;
    offset += entries.length;
    const totalFound = asRecord(data)["totalFound"];
    if (typeof totalFound === "number" && out.length >= totalFound) break;
  }
  return out;
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const data = await getJson<unknown>(
    `https://api.smartrecruiters.com/v1/companies/${board.id}/postings/${id}`,
    options,
  );
  return parseSmartRecruitersDetail(data);
}

export const smartrecruitersReader: Reader = { platform: "smartrecruiters", list, body };
