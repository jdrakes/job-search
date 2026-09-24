// HRMDirect's public job board (ClearCompany's legacy product - the
// `hrmdirect.com` domain and markup are what's actually read, Ruling 5):
// two phases, both server-rendered HTML, like Jobvite/Avature/JazzHR. The
// listing (`${board}.hrmdirect.com/employment/job-openings.php?search=true`)
// carries every open row in repeated `<tr class="reqitem...">` blocks,
// confirmed unpaged on a live board (28 rows, one page, 2026-09-22, whose
// board id and tenant display name disagree). The detail
// (`.../job-opening.php?req=${id}&req_loc=${locId}`) requires `req_loc`:
// confirmed live that the same `req` fetched with a wrong `req_loc` still
// answers 200, but with an empty `<h2></h2>` and every `viewFieldValue`
// blank rather than an HTTP error - so a missing/mismatched `req_loc`
// silently reads as "no fields stated", not a fetch failure.
//
// `req_loc` isn't derivable from `req` alone and isn't on the detail
// page's own URL in any recoverable form, so it has to travel from the
// listing row that already has it. The `Reader` contract only ever
// threads one string between the two phases - `list`'s `Listing.id`,
// stored as the posting's key suffix (`schema.ts`'s `postingKey`) and
// handed back unchanged as `body`'s `id` (`ingest.ts`'s `postingIdOf`,
// which slices everything after the key's first "::" - safe for an id
// that itself contains a ":", since only the key's own "::" separator is
// searched for) - so this reader's listing `id` is the composite
// `"${req}:${req_loc}"`, split back apart in `body` below. Not stated in
// the plan's Produces signature; the alternative (a fifth `Reader` method,
// or re-fetching the listing inside `body` to look `req_loc` back up) is
// more invasive for the same result.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import { asText, compInText, type Listing, type Reader } from "./ats.ts";

// A whole `<tr>` for one opening, captured from its own start (the
// alternating `reqitem`/`reqitem1` striping class, immediately followed by
// `data-req-id`) up to its own close - real rows never nest another `<tr>`,
// so a lazy match to the next `</tr>` always lands on the row's own end.
const ROW = /<tr class="reqitem1?[^"]*"\s+data-req-id="(\d+)"[\s\S]*?<\/tr>/g;

// The title cell's anchor closing tag is missing before `</td>` in real
// markup (confirmed live, every row) - the same "don't assume well-formed
// nesting" caution jazzhr.ts and jobvite.ts take. Capturing "up to `</td>`"
// rather than "up to `</a>`" handles the real, unclosed shape directly.
const POS_TITLE = /class="posTitle[^"]*">\s*<a href="([^"]+)">([\s\S]*?)<\/td>/;
const CITIES_CELL = /class="cities[^"]*">([^<]*)<\/td>/;
const STATE_CELL = /class="state[^"]*">([^<]*)<\/td>/;

// `cities`/`state` joined, empty segments dropped; null when both are
// empty - confirmed live that most rows on a board (27 of 28 on the one
// checked) state neither at all, only on the detail.
function joinLocation(cities: string, state: string): string | null {
  const parts = [cities, state].map((part) => htmlToText(part)).filter((part) => part !== "");
  return parts.length > 0 ? parts.join(", ") : null;
}

function fromRow(row: string, reqId: string, board: string): Listing | null {
  const titleMatch = POS_TITLE.exec(row);
  if (titleMatch === null) return null;

  // Real hrefs carry a raw "&amp;" before the "#job" fragment
  // (`"...req_loc=1465864&&amp;#job"`) - `htmlToText` decodes entities
  // without touching anything else in a tag-free string, which a bare
  // href is.
  const href = htmlToText(titleMatch[1] ?? "");
  const reqLoc = /req_loc=(\d+)/.exec(href)?.[1] ?? "";
  const id = reqLoc !== "" ? `${reqId}:${reqLoc}` : reqId;

  const location = joinLocation(CITIES_CELL.exec(row)?.[1] ?? "", STATE_CELL.exec(row)?.[1] ?? "");

  return {
    id,
    title: asText(htmlToText(titleMatch[2] ?? "")),
    url: new URL(href, `https://${board}.hrmdirect.com/employment/`).toString(),
    location,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: null,
  };
}

export function parseHrmdirectListing(html: string, board: string): Listing[] {
  const listings: Listing[] = [];
  for (const match of html.matchAll(ROW)) {
    const reqId = match[1] ?? "";
    if (reqId === "") continue;
    const listing = fromRow(match[0], reqId, board);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

const H2 = /<h2>([\s\S]*?)<\/h2>/;
const FIELD_ROW =
  /<td class="viewFieldName"><b>([^<]*)<\/b><\/td>\s*<td class="viewFieldValue">([\s\S]*?)<\/td>/g;
// No nested `<div>` inside a live `jobDesc` block (confirmed on the
// posting checked - every child is a `<p>`/`<ul>`/`<li>`), so a
// lazy match to the first `</div>` always lands on the block's own close,
// unlike Avature's detail, which does nest and needs a depth-counted walk.
const JOB_DESC = /<div class="jobDesc">([\s\S]*?)<\/div>/;

function detailTitle(html: string): string | null {
  const match = H2.exec(html);
  return match !== null ? asText(htmlToText(match[1] ?? "")) : null;
}

// `viewFieldValue` paired with the `viewFieldName` immediately before it,
// matched by its leading word ("Location", the trailing colon inside the
// `<b>` ignored) case-insensitively - the only field this reader reads off
// the labelled block; `Department` and any other pair are left alone.
function detailLocation(html: string): string | null {
  for (const match of html.matchAll(FIELD_ROW)) {
    const label = htmlToText(match[1] ?? "");
    if (/^location/i.test(label)) return asText(htmlToText(match[2] ?? ""));
  }
  return null;
}

function detailBody(html: string): string {
  const match = JOB_DESC.exec(html);
  return match !== null ? htmlToText(match[1] ?? "") : "";
}

export function parseHrmdirectDetail(html: string, id: string): Listing {
  const body = detailBody(html);
  const comp = compInText(body);
  return {
    id,
    // The `<h2>` heading when the page states one. A `req_loc` mismatch
    // (see the file header) answers a real, empty `<h2></h2>` rather than
    // an error, which reads as null here, not an empty string standing in
    // for a title. `ingest.ts` never reads a two-phase detail's `title`
    // back into the stored row (only `body`/`workplace`/`compLow`/
    // `compHigh` - the same reason breezy.ts's detail `postedAt` can read
    // null safely), so this can never overwrite the title the listing
    // phase already wrote.
    title: detailTitle(html),
    // The caller (`body`, below) knows the URL it fetched.
    url: null,
    location: detailLocation(html),
    // The free text can carry a large non-pay dollar figure (the detail
    // fixture mentions "$2.5M" as a portfolio value, not pay) - it never
    // matches `COMP_RANGE`'s two-figure range pattern on its own, so it
    // never reaches `compLow`/`compHigh`; confirmed against this reader's
    // own fixture, not a new guard.
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: null,
    body: body === "" ? null : body,
    workplace: null,
  };
}

function splitId(id: string): { reqId: string; reqLoc: string } {
  const separator = id.indexOf(":");
  return separator === -1
    ? { reqId: id, reqLoc: "" }
    : { reqId: id.slice(0, separator), reqLoc: id.slice(separator + 1) };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const html = await getText(
    `https://${board.id}.hrmdirect.com/employment/job-openings.php?search=true`,
    options,
  );
  return parseHrmdirectListing(html, board.id);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const { reqId, reqLoc } = splitId(id);
  const url = `https://${board.id}.hrmdirect.com/employment/job-opening.php?req=${reqId}&req_loc=${reqLoc}`;
  const html = await getText(url, options);
  return { ...parseHrmdirectDetail(html, id), url };
}

export const hrmdirectReader: Reader = { platform: "hrmdirect", list, body };
