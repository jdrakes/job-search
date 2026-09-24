// Personio's public XML board feed. "workzag-jobs" (the vendor's earlier
// product name) is the feed's own root element. One request lists every
// open position with its full description body already attached -
// one-phase, like `ashby.ts` - so no detail call exists on this platform
// (Ruling 2, plan). The board id is the full listing host
// (`${slug}.jobs.personio.de` or `.com`; only `.com` is guessable, Ruling
// 6), confirmed live 2026-09-22 against a `.de` board's `/xml`.
//
// Parsed with regexes over the raw XML text, the same approach
// `weworkremotely.ts` takes on its RSS feed: one field extracted at a
// time, no XML parser dependency (standard library first).
import { getText, htmlToText, type HttpOptions } from "../net/http.ts";
import type { Board } from "../schema.ts";
import { asText, compInText, isoDate, type Listing, type Reader } from "./ats.ts";

const POSITION = /<position>([\s\S]*?)<\/position>/g;

// Cut out before any header field is read: a position's title lives in a
// `<name>` tag, and so does every job-description section's own heading
// ("Our Mission", "About the Role", ...) - both spellings share a tag
// name, and every position checked states its title before
// `<jobDescriptions>` opens. Reading header fields only from the text
// before this split keeps a section heading from ever being mistaken for
// the position's title.
const JOB_DESCRIPTIONS_SPLIT = "<jobDescriptions>";
const VALUE = /<value>([\s\S]*?)<\/value>/g;
const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

function tag(source: string, name: string): string | null {
  // `office` is the one header field that recurs: a position open in more
  // than one place restates it inside `<additionalOffices>`. The direct
  // child always comes first in the source, so the first match is always
  // it - confirmed live against a multi-office posting.
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(source);
  return match ? (match[1] ?? "").trim() : null;
}

// A `<value>` block's content is CDATA-wrapped on every position checked;
// read the raw text either way rather than assume the wrapper.
function valueText(raw: string): string {
  const cdata = CDATA.exec(raw);
  return (cdata ? cdata[1] : raw) ?? "";
}

// Everything before `<jobDescriptions>` opens; see `JOB_DESCRIPTIONS_SPLIT`
// above. A position with no `<jobDescriptions>` block at all reads as the
// whole of `positionRaw` here - still correct, since there is then no
// section heading downstream to collide with.
function headerOf(positionRaw: string): string {
  const index = positionRaw.indexOf(JOB_DESCRIPTIONS_SPLIT);
  return index === -1 ? positionRaw : positionRaw.slice(0, index);
}

// Every `<jobDescription><value>` block, `htmlToText`'d and joined in
// document order. A position with no `<jobDescriptions>` block at all (or
// an empty one) reads as an empty string here, never a throw.
function bodyOf(positionRaw: string): string {
  const start = positionRaw.indexOf(JOB_DESCRIPTIONS_SPLIT);
  if (start === -1) return "";
  const block = positionRaw.slice(start);
  const sections: string[] = [];
  for (const match of block.matchAll(VALUE)) {
    const text = htmlToText(valueText(match[1] ?? ""));
    if (text !== "") sections.push(text);
  }
  return sections.join(" ");
}

function toListing(positionRaw: string, board: string): Listing | null {
  const id = tag(positionRaw, "id");
  if (id === null || id === "") return null;

  const header = headerOf(positionRaw);
  const body = bodyOf(positionRaw);
  // No comp field exists on this feed; the only source is prose.
  const comp = compInText(body);

  return {
    id,
    title: asText(htmlToText(tag(header, "name") ?? "")),
    // Confirmed live: the feed states no url field itself.
    url: `https://${board}/job/${id}`,
    location: asText(htmlToText(tag(header, "office") ?? "")),
    compLow: comp?.compLow ?? null,
    compHigh: comp?.compHigh ?? null,
    postedAt: isoDate(tag(positionRaw, "createdAt")),
    body: asText(body),
    // No live posting checked states its workplace structurally.
    workplace: null,
  };
}

export function parsePersonioFeed(xml: string, board: string): Listing[] {
  const listings: Listing[] = [];
  for (const match of xml.matchAll(POSITION)) {
    const listing = toListing(match[1] ?? "", board);
    if (listing !== null) listings.push(listing);
  }
  return listings;
}

async function list(board: Board, options?: HttpOptions): Promise<Listing[]> {
  const xml = await getText(`https://${board.id}/xml`, options);
  return parsePersonioFeed(xml, board.id);
}

export const personioReader: Reader = { platform: "personio", list };
