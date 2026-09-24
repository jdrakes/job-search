// The shape every ATS reader answers to, and the helpers they share. A
// `Listing` is one posting exactly as a board states it. A platform whose
// listing carries no body (SmartRecruiters, Workday, Eightfold) exposes
// `body` separately so the caller spends that extra request deliberately.
import type { HttpOptions } from "../net/http.ts";
import { WORKPLACES, type Board, type Platform, type Workplace } from "../schema.ts";

export interface Listing {
  readonly id: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly location: string | null;
  readonly compLow: number | null;
  readonly compHigh: number | null;
  readonly postedAt: string | null;
  readonly body: string | null;
  // The board's own word for its workplace; null where it states none.
  readonly workplace: Workplace | null;
}

export interface Reader {
  readonly platform: Platform;
  list(board: Board, options?: HttpOptions): Promise<Listing[]>;
  body?(board: Board, id: string, options?: HttpOptions): Promise<Listing | null>;
}

// A per-posting read an operator supplies for one board whose listing leaves
// out what the posting's own page states: a workplace, a band, the text. It
// turns that board two-phase, so the page is read once per posting the
// listing criteria admit, not once per posting per run.
export interface DetailRead {
  readonly platform: Platform;
  readonly board: string;
  body(id: string, options?: HttpOptions): Promise<Listing | null>;
}

// Board JSON is untrusted. A missing or wrong-typed field reads as its
// empty value, never a throw: a malformed field is not a malformed board.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// `null` for absent, wrong-typed or empty, so a missing title and an
// empty-string title read the same way downstream.
export function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// Lower-cased and matched against `WORKPLACES` (src/schema.ts): Ashby
// spells it `OnSite`, Lever `onsite`. Anything else (Lever's `unspecified`)
// records null, never a guess.
export function workplaceOf(value: unknown): Workplace | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return (WORKPLACES as readonly string[]).includes(lower) ? (lower as Workplace) : null;
}

// Down to its calendar date: `posted_at` is a SQL `date` (src/schema.ts).
export function isoDate(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // A millisecond epoch is 13 digits, a seconds epoch 10: Lever gives
    // milliseconds, Eightfold seconds.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}

// `comp_low`/`comp_high` are whole US dollars a year, and the floor is a
// dollar figure, so a number in another currency or period would clear it
// on arithmetic alone. A vendor that states currency and interval (Lever,
// Ashby) is read only when it says US dollars a year; anything else records
// no comp, which the processor treats as "pay not posted". Each vendor
// spells its own interval, so that stays in its reader.
export function isUsd(currency: unknown): boolean {
  return currency === "USD";
}

// A stated dollar range in prose, in every spelling boards use:
// "$139,200 — $235,200 USD", "$150,000 to $200,000", Workday's
// "$184,500.00 to $251,900.00" (cents matched, not captured), Eightfold's
// "$600,000.00 - $1,066,000.00" (one digit before the first comma, which
// `{1,3}` admits), "$150000 - $200000" (separators optional; four digits is
// the shortest figure, keeping "$5 - $10" out), `$198K – $319K`, `$120K-145K`,
// `$198,000 USD – $233,000 USD` (currency word before the dash),
// `$ 174,986 - $209,983`. The `i` flag is for `K`.
const COMP_RANGE =
  /\$ ?(\d{1,3}(?:,\d{3})+|\d{4,}|\d{1,3}K)(?:\.\d{2})?(?: USD)?\s*(?:-|–|—|to)\s*\$? ?(\d{1,3}(?:,\d{3})+|\d{4,}|\d{1,3}K)(?:\.\d{2})?/gi;

function asAmount(digits: string): number | null {
  const thousands = /k$/i.test(digits);
  const amount = Number(digits.replace(/,/g, "").replace(/k$/i, "")) * (thousands ? 1_000 : 1);
  return Number.isFinite(amount) ? amount : null;
}

// The range reaching highest wins, not the first: a body often states
// "Relocation of $5,000 - $10,000" ahead of the base pay, or a headline
// range followed by higher ones for named metros. Highest-match takes at
// worst a top-of-market metro band, erring toward looking at a posting.
export function compInText(text: string): { compLow: number; compHigh: number } | null {
  let best: { compLow: number; compHigh: number } | null = null;
  for (const match of text.matchAll(COMP_RANGE)) {
    const first = asAmount(match[1] ?? "");
    const second = asAmount(match[2] ?? "");
    if (first === null || second === null) continue;
    const range =
      first <= second ? { compLow: first, compHigh: second } : { compLow: second, compHigh: first };
    if (best === null || range.compHigh > best.compHigh) best = range;
  }
  return best;
}

// A board that answers a full page whatever offset it is asked for would
// spin its reader forever, and `ingest` awaits a reader with no timeout.
// Eightfold pages ten at a time and its largest boards run to thousands of
// postings, so the cap has to be hundreds of pages.
export const MAX_PAGES = 500;
