// Jobvite's public job board: two phases, like SmartRecruiters, but both
// server-rendered HTML rather than JSON. The listing
// (jobs.jobvite.com/${board}/jobs) carries no body or comp, only every open
// row in repeated `<table class="jv-job-list">` blocks, confirmed unpaged on
// boards up to 88 postings. The detail
// (jobs.jobvite.com/${board}/job/${id}) embeds a schema.org `JobPosting` in
// one `<script type="application/ld+json">` tag, confirmed on every detail
// checked across three boards.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
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

// A remote row's cell never reduces to the bare word "Remote" - it always
// carries a trailing place after a comma ("Remote, Bandung Wetan, Kota
// Bandung, Jawa Barat") or, on an "N Locations" row, a bare trailing comma
// once `jv-meta` is stripped ("Remote,"). Only a prefix check catches both;
// an exact-match rule would silently null every remote posting on this
// platform (confirmed against a live board).
function jobviteWorkplace(location: string | null): Workplace | null {
  return location !== null && location.startsWith("Remote") ? "remote" : null;
}

const JV_META = /<div class="jv-meta">[\s\S]*?<\/div>/g;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

// A row's location cell, `jv-meta` (the "N Locations" caption) removed
// first so its own text never leaks into the place name, then every
// remaining tag dropped outright - not replaced with a space, the way
// `htmlToText` treats an inline tag - so "Remote<span>,</span>" collapses to
// "Remote," rather than "Remote , " (confirmed against both live shapes).
function cellLocation(cellHtml: string): string | null {
  const withoutMeta = cellHtml.replace(JV_META, "");
  const text = stripTags(withoutMeta).replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

const ROW = /<tr>\s*<td class="jv-job-list-name">[\s\S]*?<\/tr>/g;
const ANCHOR = /<a href="([^"]+)">([^<]*)<\/a>/;
const LOCATION_CELL = /<td class="jv-job-list-location">([\s\S]*?)<\/td>/;

function fromRow(row: string, slug: string): Listing | null {
  const anchor = ANCHOR.exec(row);
  if (anchor === null) return null;
  const href = anchor[1] ?? "";
  const id = href.split("/").pop() ?? "";
  if (id === "") return null;

  const locationCell = LOCATION_CELL.exec(row);
  const location = locationCell !== null ? cellLocation(locationCell[1] ?? "") : null;

  return {
    id,
    title: asText((anchor[2] ?? "").trim()),
    // `href` is already account-qualified ("/${slug}/job/${id}") on every
    // board checked; resolving it against the board's own base handles that
    // real shape and a bare "job/${id}" shape alike, rather than assuming
    // one.
    url: new URL(href, `https://jobs.jobvite.com/${slug}/`).toString(),
    location,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: jobviteWorkplace(location),
  };
}

export function parseJobviteListing(html: string, slug: string): Listing[] {
  const listings: Listing[] = [];
  for (const match of html.matchAll(ROW)) {
    const listing = fromRow(match[0], slug);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

// `jobLocation[0].address`'s city/state only - `addressCountry` alone (a
// posting open anywhere in one country, e.g. "United States") states no
// city or state, so this reads null rather than falling back to the
// country, which would misrepresent a countrywide posting as a placed one.
function detailLocation(job: Record<string, unknown>): string | null {
  const address = asRecord(asRecord(asArray(job["jobLocation"])[0])["address"]);
  const parts = [asText(address["addressLocality"]), asText(address["addressRegion"])].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

// One posting checked states a numeric range; every other detail checked
// states all three of `minValue`/`maxValue`/`currency` as `""` - read as
// absent, not zero.
function structuredComp(
  job: Record<string, unknown>,
): { compLow: number; compHigh: number } | null {
  const baseSalary = asRecord(job["baseSalary"]);
  const value = asRecord(baseSalary["value"]);
  const min = value["minValue"];
  const max = value["maxValue"];
  if (
    typeof min !== "string" ||
    min === "" ||
    typeof max !== "string" ||
    max === "" ||
    !Number.isFinite(Number(min)) ||
    !Number.isFinite(Number(max)) ||
    !isUsd(baseSalary["currency"]) ||
    value["unitText"] !== "Annually"
  ) {
    return null;
  }
  return { compLow: Number(min), compHigh: Number(max) };
}

// `raw` is the JSON already extracted from the detail page's `ld+json`
// script tag (see `extractJobPosting` below), not the page's HTML.
// `hiringOrganization` states the account's name as a bare string on some
// boards and as an `{name}` object on others; neither shape feeds a
// `Listing` field, but the parser must not fault on either - both live
// shapes are exercised in the fixtures.
export function parseJobviteDetail(raw: unknown, id: string): Listing {
  const job = asRecord(raw);
  const body = htmlToText(asText(job["description"]) ?? "");
  const comp = structuredComp(job) ?? compInText(body);
  return {
    id: asText(job["identifier"]) ?? id,
    title: asText(job["title"]),
    // The caller (`body`, below) knows the URL it fetched; this function
    // does not have the board id needed to build one, so it leaves url
    // null and the caller fills it in.
    url: null,
    location: detailLocation(job),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(job["datePosted"]),
    body: body === "" ? null : body,
    workplace: job["jobLocationType"] === "TELECOMMUTE" ? "remote" : null,
  };
}

const JSON_LD = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;

function extractJobPosting(html: string): unknown {
  const match = JSON_LD.exec(html);
  if (match === null) return null;
  try {
    return JSON.parse(match[1] ?? "");
  } catch {
    return null;
  }
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const html = await getText(`https://jobs.jobvite.com/${board.id}/jobs`, options);
  return parseJobviteListing(html, board.id);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const url = `https://jobs.jobvite.com/${board.id}/job/${id}`;
  const html = await getText(url, options);
  const listing = parseJobviteDetail(extractJobPosting(html), id);
  return { ...listing, url };
}

export const jobviteReader: Reader = { platform: "jobvite", list, body };
