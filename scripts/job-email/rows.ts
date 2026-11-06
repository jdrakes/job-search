// Turns one thread and its extracted items into the row the agents read.
// The agents' prompts assume these rules, applied in order per thread:
//
// 1. The checked text holds only messages dated on or after the window start
//    (UTC midnight), each as "From / Subject / Date" then the plain-text body,
//    separated by "---".
// 2. A company that is a listing site (Ladders, Clera, Raydar, TalentHop,
//    Jobgether) moves to listing_site and company becomes null. A literal
//    "null" string in any text field becomes null first.
// 3. quote_verified: the quote is a substring of that text after turning
//    curly apostrophes straight, lower-casing and collapsing whitespace. A
//    quote that is empty after that is not verified.
// 4. full_text carries every message of the thread, older ones included, when
//    an item's status is rejected, interviewing or offer, or the seeker sent
//    a message in the thread (label SENT) and the thread yielded any item.
// 5. Known gap: a thread with no items and no full_text cannot be classified.
import type { Item } from "./extract.ts";
import type { GmailMessage, GmailThread } from "./gmail.ts";

export interface RowItem extends Item {
  readonly listing_site: string | null;
  readonly quote_verified: boolean;
}

export interface Row {
  readonly thread: string;
  readonly messages: readonly { sender: string; subject: string; date: string }[];
  readonly items: readonly RowItem[];
  readonly full_text: string | null;
}

const LISTING_SITE = /^(ladders|clera|raydar|talenthop|jobgether)\b/i;
const FULL_TEXT_STATUSES: readonly string[] = ["rejected", "interviewing", "offer"];

// windowStart is "YYYY-MM-DD", read as UTC midnight.
export function windowMessages(thread: GmailThread, windowStart: string): readonly GmailMessage[] {
  const start = Date.parse(`${windowStart}T00:00:00Z`);
  return thread.messages.filter((message) => Date.parse(message.date) >= start);
}

export function threadText(messages: readonly GmailMessage[]): string {
  return messages
    .map(
      (message) =>
        `From: ${message.sender}\nSubject: ${message.subject}\nDate: ${message.date}\n\n${message.text}`,
    )
    .join("\n\n---\n\n");
}

function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
}

function nullIfNullString(value: string | null): string | null {
  return value === "null" ? null : value;
}

// The empty check matters: every string includes the empty string.
function isQuoteIn(quote: string | null, checkedText: string): boolean {
  const normalizedQuote = normalize(quote ?? "");
  return normalizedQuote !== "" && normalize(checkedText).includes(normalizedQuote);
}

function rowItemOf(item: Item, checkedText: string): RowItem {
  const company = nullIfNullString(item.company);
  const quote = nullIfNullString(item.quote);
  const isListingSite = company !== null && LISTING_SITE.test(company);
  return {
    ...item,
    company: isListingSite ? null : company,
    title: nullIfNullString(item.title),
    location: nullIfNullString(item.location),
    pay: nullIfNullString(item.pay),
    quote,
    listing_site: isListingSite ? company : null,
    quote_verified: isQuoteIn(quote, checkedText),
  };
}

export function rowOf(thread: GmailThread, windowStart: string, items: readonly Item[]): Row {
  const inWindow = windowMessages(thread, windowStart);
  const checkedText = threadText(inWindow);
  const rowItems = items.map((item) => rowItemOf(item, checkedText));
  const needsWholeThread =
    rowItems.some((item) => FULL_TEXT_STATUSES.includes(item.status)) ||
    (rowItems.length > 0 && thread.messages.some((message) => message.labels.includes("SENT")));
  return {
    thread: thread.id,
    messages: inWindow.map(({ sender, subject, date }) => ({ sender, subject, date })),
    items: rowItems,
    full_text: needsWholeThread ? threadText(thread.messages) : null,
  };
}

export function isUnclassified(row: Row): boolean {
  return row.items.length === 0 && row.full_text === null;
}
