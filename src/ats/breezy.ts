// Breezy HR's public job board: two phases (Ruling 2), confirmed live -
// none of ten postings checked on one board carries a `description` key
// on the listing. The listing (`${board}.breezy.hr/json`) answers a bare
// array; the detail (`${board}.breezy.hr/p/${id}`) is server-rendered HTML
// embedding a real schema.org `JobPosting` in one of (at least) two
// `<script type="application/ld+json">` tags - Breezy's own `WebSite`
// block sits ahead of it on every detail checked, so the right block is
// picked by its stated `@type`, never assumed to sit at a fixed position.
//
// The detail's own `datePosted` is deliberately not read into `postedAt`.
// On a live posting checked it stated a date three years staler than that
// same posting's listing-side `published_date`, a republish the listing
// tracked and the JSON-LD never picked up. `parseBreezyDetail` reads
// `postedAt` as null, so `ingest.ts` (which never reads a two-phase
// detail's `postedAt` for any platform - only
// `compLow`/`compHigh`/`body`/`workplace`) keeps whatever the listing phase
// wrote, unchanged, the whole time this posting is read. Unlike every other
// two-phase reader here, where the detail's date - when it states one at
// all - is the trusted one.
import { getJson, getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import {
  asArray,
  asRecord,
  asText,
  compInText,
  isoDate,
  isRecord,
  type Listing,
  type Reader,
} from "./ats.ts";

function fromListingEntry(raw: unknown): Listing {
  const job = asRecord(raw);
  const location = asRecord(job["location"]);
  return {
    id: String(job["id"] ?? ""),
    title: asText(job["name"]),
    url: asText(job["url"]),
    // `location.name`: a place ("Athens, GR") or, for a fully-remote
    // posting, the literal country name ("Worldwide", "Greece") - never
    // the placeholder-style string some other boards use.
    location: asText(location["name"]),
    compLow: null,
    compHigh: null,
    postedAt: isoDate(job["published_date"]),
    body: null,
    workplace: location["is_remote"] === true ? "remote" : null,
  };
}

export function parseBreezyListing(data: unknown): Listing[] {
  return asArray(data).map(fromListingEntry);
}

const JSON_LD = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function extractJobPosting(html: string): Record<string, unknown> | null {
  for (const match of html.matchAll(JSON_LD)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (isRecord(parsed) && parsed["@type"] === "JobPosting") return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

// Strips Breezy's own `?source=GoogleJobs` query, present on every detail
// URL checked; nothing else about the URL is touched.
function withoutSourceParam(url: string): string {
  return url.replace(/\?source=GoogleJobs$/, "");
}

export function parseBreezyDetail(html: string, id: string): Listing {
  const job = extractJobPosting(html) ?? {};
  const body = htmlToText(asText(job["description"]) ?? "");
  const comp = compInText(body);
  const address = asRecord(asRecord(job["jobLocation"])["address"]);
  const url = asText(job["url"]);
  return {
    id,
    title: asText(job["title"]),
    url: url !== null ? withoutSourceParam(url) : null,
    location: asText(address["addressCountry"]),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    // Deliberately not `isoDate(job["datePosted"])` - see the file header.
    postedAt: null,
    body: body === "" ? null : body,
    workplace: job["jobLocationType"] === "TELECOMMUTE" ? "remote" : null,
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const data = await getJson<unknown>(`https://${board.id}.breezy.hr/json`, options);
  return parseBreezyListing(data);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const html = await getText(`https://${board.id}.breezy.hr/p/${id}`, options);
  return parseBreezyDetail(html, id);
}

export const breezyReader: Reader = { platform: "breezy", list, body };
