// JazzHR's public job board (product history "theresumator" still shows in
// class names): two phases, like SmartRecruiters, both server-rendered
// HTML. The listing (`${board}.applytojob.com/apply/`) carries every open
// row in repeated `<li class="list-group-item">` blocks inside one
// `<ul class='list-group'>`, confirmed unpaged on a live board (31 rows,
// one page, 2026-09-22). The detail
// (`${board}.applytojob.com/apply/${id}/x`) carries no JSON-LD, only a
// generic `Organization` block; the only structured fields this reader
// reads off it are the `<title>` tag and the `#job-description` div.
//
// Rows are split on the literal `<li class="list-group-item">` opening
// marker, not matched against a closing `</li>`: a row's own markup nests
// a second, unrelated `<li>` (a "Department Code" line, `fa-sitemap` icon)
// inside its `list-inline` sub-list, so a naive "up to the next `</li>`"
// regex would stop inside a row rather than at its end. Splitting on the
// opening marker sidesteps needing to find a matching close at all.
//
// The title anchor's own closing `</a>` tag is not assumed present before
// `</h3>` - real JazzHR markup has been seen to drop it - so the title is
// read as "everything after the anchor's opening tag, up to `</h3>`", with
// `htmlToText` stripping whatever tag (a real `</a>`, or none) follows.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board, Workplace } from "../schema.ts";
import { asText, compInText, type Listing, type Reader } from "./ats.ts";

const ROW_START = '<li class="list-group-item">';
const H3 = /<h3 class='list-group-item-heading'>([\s\S]*?)<\/h3>/;
const ANCHOR_OPEN = /<a href="([^"]+)">/;
const MAP_MARKER = /<li><i class='fa fa-map-marker'><\/i>([^<]*)<\/li>/;

// A location cell's raw text, comma-split and each segment trimmed, empty
// segments dropped, rejoined - the canonical form both `location` and
// `jazzhrWorkplace`'s segment check read.
function normalizeLocation(raw: string): string | null {
  const decoded = htmlToText(raw);
  const segments = decoded
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  return segments.length > 0 ? segments.join(", ") : null;
}

// Exact-segment match, not substring (confirmed against 30 live
// locations): one posting's location reads
// "(Remote, PHILIPPINES), <city>, Philippines" - the leading segment is
// literally "(Remote", which is not "remote", so that posting's
// workplace is null under this rule, not a bug.
export function jazzhrWorkplace(location: string): Workplace | null {
  const segments = location.split(",").map((segment) => segment.trim().toLowerCase());
  if (segments.includes("remote")) return "remote";
  if (segments.includes("hybrid")) return "hybrid";
  return null;
}

function fromRowChunk(chunk: string, slug: string): Listing | null {
  const h3 = H3.exec(chunk);
  if (h3 === null) return null;
  const h3Content = h3[1] ?? "";

  const anchor = ANCHOR_OPEN.exec(h3Content);
  if (anchor === null) return null;
  const href = anchor[1] ?? "";

  const idMatch = /\/apply\/([^/]+)/.exec(href);
  const id = idMatch?.[1] ?? "";
  if (id === "") return null;

  // Everything after the anchor's opening tag, whether or not a `</a>`
  // follows it in the real markup - `htmlToText` strips whichever tag is
  // there (or none) the same way.
  const afterOpenTag = h3Content.slice(anchor.index + anchor[0].length);
  const title = asText(htmlToText(afterOpenTag));

  const marker = MAP_MARKER.exec(chunk);
  const location = marker !== null ? normalizeLocation(marker[1] ?? "") : null;

  return {
    id,
    title,
    // `href` is a full absolute URL on every row checked live
    // (`https://${board}.applytojob.com/apply/${id}/${slug-title}`),
    // not the account-relative path this reader's plan first assumed;
    // resolving against the board's own base handles that real shape and a
    // bare relative one alike, the same way jobvite.ts does.
    url: new URL(href, `https://${slug}.applytojob.com/apply/`).toString(),
    location,
    compLow: null,
    compHigh: null,
    postedAt: null,
    body: null,
    workplace: location !== null ? jazzhrWorkplace(location) : null,
  };
}

export function parseJazzhrListing(html: string, slug: string): Listing[] {
  const listings: Listing[] = [];
  for (const chunk of html.split(ROW_START).slice(1)) {
    const listing = fromRowChunk(chunk, slug);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

const TITLE_TAG = /<title>([\s\S]*?)<\/title>/;
// Real detail titles carry the marketing suffix two different ways on the
// same tenant: some state only "{title} - Career Page" (no board name);
// others additionally state the board's display name ahead of it,
// "{title} - {board} - Career Page" (confirmed live, both shapes on one
// tenant - not the "- Career Page - {board}" order the plan assumed).
// The board-name segment is stripped first, matched generically as any
// no-dash run between the title's own text and "Career Page" - that
// tenant's display name has no dash in it - then the plain
// "- Career Page" suffix is stripped regardless of whether the first step
// matched, so either real shape ends up clean.
const SUFFIX_WITH_BOARD = / - [^-]+ - Career Page$/;
const SUFFIX = / - Career Page$/;

function detailTitle(html: string): string | null {
  const match = TITLE_TAG.exec(html);
  if (match === null) return null;
  const raw = htmlToText(match[1] ?? "");
  const stripped = raw.replace(SUFFIX_WITH_BOARD, "").replace(SUFFIX, "");
  return asText(stripped);
}

const DESCRIPTION_OPEN = /<div\b[^>]*id="job-description"[^>]*>/;

// The description ends at its own matching `</div>`, found by counting
// nested `<div>`/`</div>` pairs forward from its opening tag. It used to
// end at the opening tag of the `resumator-mobile-apply-wrapper` div that
// follows it on one tenant's pages - the only one checked - so a
// tenant whose skin renders no such wrapper, or renames it, would have read
// as an empty body with no error anywhere: no text for the judge's
// text-level criteria and nothing for `compInText`, for that whole board.
// A sibling's class name is not this element's close; its own `</div>` is.
//
// This is a deliberate copy of `matchingCloseDiv` in `src/ats/avature.ts`,
// which does the same counting for that reader's `field__value` blocks
// (which nest dozens of `<div>`s). The two stay copies rather than one
// shared helper so neither reader's module imports the other's; a third
// caller would be the point to lift it into `ats.ts`.
function matchingCloseDiv(html: string, from: number): number | null {
  const DIV_TAG = /<\/?div\b[^>]*>/g;
  DIV_TAG.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = DIV_TAG.exec(html)) !== null) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return match.index;
    } else {
      depth += 1;
    }
  }
  return null;
}

function detailBody(html: string): string {
  const open = DESCRIPTION_OPEN.exec(html);
  if (open === null) return "";
  const start = open.index + open[0].length;
  // No matching close: the rest of the page, not nothing. This vendor is
  // already known to emit unclosed tags (the title anchor's `</a>`, above),
  // and an over-long body that carries the description plus the page's
  // apply-form chrome still feeds the judge and `compInText`, where an
  // empty one silently feeds neither.
  const close = matchingCloseDiv(html, start);
  return htmlToText(html.slice(start, close ?? html.length));
}

export function parseJazzhrDetail(html: string, id: string): Listing {
  const body = detailBody(html);
  const comp = compInText(body);
  return {
    id,
    title: detailTitle(html),
    // The caller (`body`, below) built the request URL; this function only
    // sees the page it fetched, not the board id needed to reconstruct it.
    url: null,
    // Not read on the detail - the listing's map-marker cell is the only
    // structured location source.
    location: null,
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: null,
    body: body === "" ? null : body,
    workplace: null,
  };
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const html = await getText(`https://${board.id}.applytojob.com/apply/`, options);
  return parseJazzhrListing(html, board.id);
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  const url = `https://${board.id}.applytojob.com/apply/${id}/x`;
  const html = await getText(url, options);
  return { ...parseJazzhrDetail(html, id), url };
}

export const jazzhrReader: Reader = { platform: "jazzhr", list, body };
