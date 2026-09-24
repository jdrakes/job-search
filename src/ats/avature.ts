// Avature's public career portal: two phases, both server-rendered HTML,
// like Jobvite and JazzHR (not JSON). Avature is a per-tenant-skinned
// product - the two tenants checked live 2026-09-22 disagree on almost
// every piece of markup: the listing's location cell (one serves a
// `list-item-location` span, the other none at all on the listing, only
// on the detail), the title heading's own class suffix, and even how many
// result rows a page actually returns for the same `jobRecordsPerPage`
// request (12 on one, 6 on the other, that same day). The one thing both tenants hold - the title link's shared
// `article__header__text__title` class and the detail's generic
// `field__label`/`field__value` blocks - is what this reader reads; every
// aux field a listing row might carry is left null rather than guessed at
// per-tenant.
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import { asText, compInText, MAX_PAGES, type Listing, type Reader } from "./ats.ts";

const PAGE_SIZE = 100;

// The title heading's class carries per-tenant suffixes alongside the
// shared token (one tenant: "article__header__text__title title
// title--04"; the other: "article__header__text__title
// article__header__text__title--7"), and the anchor itself carries a
// `class="link"` on one but none on the other - so only the shared class
// token and the href/text are read.
const TITLE_ANCHOR =
  /article__header__text__title[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

// The id is the href's trailing digits (`.../JobDetail/{slug}/{id}`),
// confirmed on both tenants; the slug segment before it is cosmetic and
// ignored, same as the detail URL's own slug segment.
function idFromHref(href: string): string {
  const match = /(\d+)\/?$/.exec(href);
  return match?.[1] ?? "";
}

export function parseAvatureListing(html: string, board: string): Listing[] {
  const listings: Listing[] = [];
  for (const match of html.matchAll(TITLE_ANCHOR)) {
    const href = match[1] ?? "";
    const id = idFromHref(href);
    if (id === "") continue;
    listings.push({
      id,
      title: asText((match[2] ?? "").replace(/\s+/g, " ").trim()),
      url: new URL(href, `https://${board}.avature.net/`).toString(),
      // Location, comp, postedAt and body all sit in markup that disagrees
      // between tenants (one serves a `list-item-location` span, the other
      // a labelled field) - left null on the listing, read from the detail
      // instead, where both tenants share the same labelled-block shape.
      location: null,
      compLow: null,
      compHigh: null,
      postedAt: null,
      body: null,
      workplace: null,
    });
  }
  return listings;
}

const OG_TITLE = /<meta property="og:title" content="([^"]*)"/;

function ogTitle(html: string): string | null {
  const match = OG_TITLE.exec(html);
  return match !== null ? asText(htmlToText(match[1] ?? "")) : null;
}

// A detail's `field__value` block can nest arbitrarily deep (the
// description block alone holds dozens of nested `<div>`s), so pairing it
// with its label can't be done with a single non-nesting regex the way
// `field__label` (always plain text on both tenants checked) can. This
// walks forward from a `field__value` opening tag counting nested
// `<div>`/`</div>` pairs until the one that closes it, the same "don't
// assume a flat structure" caution `htmlToText`'s block-tag handling takes.
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

// No `\b` around the class token: Avature's own BEM classes
// ("article__content__view__field__value") chain double underscores, and
// `_` counts as a word character in JS regex, so `\bfield__value\b` finds
// no boundary before the "f" and never matches at all - confirmed against
// both detail fixtures, which is what caught this.
const FIELD_VALUE_OPEN = /<div\b[^>]*class="[^"]*field__value[^"]*"[^>]*>/g;
const FIELD_LABEL = /<div class="[^"]*field__label[^"]*">([\s\S]*?)<\/div>/g;

interface FieldEvent {
  readonly index: number;
  readonly kind: "label" | "value";
  readonly text: string;
}

// Every `field__value` block on a detail page, labelled and unlabelled
// alike (the title echo, the real description, a salary-disclaimer
// paragraph and a boilerplate closer all showed up as separate unlabelled
// blocks on one tenant's detail) - `body` joins all of them; only the
// one paired with a label reading "Location..." (case-insensitive, so it
// matches one tenant's bare "Location" and the other's "Location(s)"
// alike) feeds `location`. Pairing walks the two kinds of block in document
// order: a label is "pending" until the very next value claims it, which
// holds on both tenants checked - a value with no label pending is one of
// the unlabelled blocks.
function detailFields(html: string): { location: string | null; bodyHtml: string[] } {
  const events: FieldEvent[] = [];

  for (const match of html.matchAll(FIELD_LABEL)) {
    events.push({
      index: match.index,
      kind: "label",
      text: (match[1] ?? "").replace(/\s+/g, " ").trim(),
    });
  }

  FIELD_VALUE_OPEN.lastIndex = 0;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = FIELD_VALUE_OPEN.exec(html)) !== null) {
    const close = matchingCloseDiv(html, FIELD_VALUE_OPEN.lastIndex);
    if (close === null) continue;
    events.push({
      index: openMatch.index,
      kind: "value",
      text: html.slice(FIELD_VALUE_OPEN.lastIndex, close),
    });
  }

  events.sort((first, second) => first.index - second.index);

  let location: string | null = null;
  let pendingLabel: string | null = null;
  const bodyHtml: string[] = [];
  for (const event of events) {
    if (event.kind === "label") {
      pendingLabel = event.text;
      continue;
    }
    bodyHtml.push(event.text);
    if (location === null && pendingLabel !== null && /^location/i.test(pendingLabel)) {
      const text = event.text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      location = text === "" ? null : text;
    }
    pendingLabel = null;
  }

  return { location, bodyHtml };
}

export function parseAvatureDetail(html: string, id: string): Listing {
  const { location, bodyHtml } = detailFields(html);
  const body = htmlToText(bodyHtml.join(" "));
  // No tenant checked configures a comp or a date-posted field; `compInText`
  // is the only source, same as HRMDirect's free text - real dollar-ish
  // figures in both tenants' bodies (one states "$45 - 50 USD Hourly",
  // the other "$50 million") never clear its four-digit-range
  // pattern, which is that pattern doing its job, not a gap here.
  const comp = compInText(body);
  return {
    id,
    title: ogTitle(html),
    // The caller (`body`, below) knows the URL it fetched.
    url: null,
    location,
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: null,
    body: body === "" ? null : body,
    workplace: null,
  };
}

// Avature exposes no total-count field to page against the way
// SmartRecruiters' `totalFound` does, and a tenant that ignores `jobOffset`
// the way every tenant checked ignores `jobRecordsPerPage` would answer the
// identical first page forever - 500 fetches (`MAX_PAGES`) for one board
// every run. So the stop is on ids instead: page until a page contributes
// no id a prior page hasn't already returned. That subsumes the empty-page
// case, and unlike a "shorter than the last page" check it catches a
// repeated page, which is the *same* length, not shorter. Only the ids not
// seen before are kept, so a tenant that overlaps its pages returns each
// posting once.
async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const out: Listing[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await getText(
      `https://${board.id}.avature.net/careers/SearchJobs/?jobRecordsPerPage=${PAGE_SIZE}&jobOffset=${offset}`,
      options,
    );
    const entries = parseAvatureListing(html, board.id);
    const fresh = entries.filter((entry) => !seen.has(entry.id));
    for (const entry of fresh) seen.add(entry.id);
    out.push(...fresh);
    if (fresh.length === 0) break;
    // The vendor's own page size, not the one asked for, is what advances
    // the offset - so the count returned, duplicates included.
    offset += entries.length;
  }
  return out;
}

async function body(board: Board, id: string, options?: HttpOptions): Promise<Listing | null> {
  // The slug segment before the id is cosmetic and ignored by the host
  // (confirmed live on both tenants); a fixed placeholder avoids carrying
  // a title-derived slug the caller doesn't have.
  const url = `https://${board.id}.avature.net/en_US/careers/JobDetail/x/${id}`;
  const html = await getText(url, options);
  return { ...parseAvatureDetail(html, id), url };
}

export const avatureReader: Reader = { platform: "avature", list, body };
