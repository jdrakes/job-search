// Hacker News's monthly "Who is hiring?" thread as a discovery source:
// every name is a candidate for `probe`, nothing here decides whether it is
// worth watching. Algolia's `items` endpoint hands back a whole thread's
// comments in one request, where Firebase's costs one per comment.
import { getJson, htmlToText, type HttpOptions } from "../net/http.ts";
import { asArray, asRecord, asText } from "../ats/ats.ts";
import type { Source } from "./source.ts";

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";

function itemUrl(id: number): string {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

// Posted by the same account alongside "Who wants to be hired?" and
// "Freelancer? Seeking freelancer?" in the same batch; the title tells them
// apart.
const HIRING_TITLE = /^Ask HN: Who is hiring\?/i;

// Null when the search answers with nothing recognizable: a source failing
// is one error line to its caller, never a throw.
async function newestThreadId(options?: HttpOptions): Promise<number | null> {
  const data = await getJson<unknown>(SEARCH_URL, options);
  for (const hit of asArray(asRecord(data)["hits"])) {
    const title = asText(asRecord(hit)["title"]) ?? "";
    if (!HIRING_TITLE.test(title)) continue;
    const id = asRecord(hit)["objectID"];
    const parsed = typeof id === "string" ? Number(id) : null;
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Longer than this is prose that happened to contain a pipe.
const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 8;

// HN's posting guidelines ask for "Company | Role | Location | ..."; a
// first line with no "|" is not confidently a name (replies, questions),
// and skipping it is more honest than guessing which word is the company.
function companyName(text: string): string | null {
  const firstLine = text.split(/<p>/i)[0] ?? "";
  const segments = firstLine.split("|");
  if (segments.length < 2) return null;

  const name = htmlToText(segments[0] ?? "").trim();
  if (name === "") return null;
  if (name.length > MAX_NAME_LENGTH) return null;
  if (name.split(/\s+/).length > MAX_NAME_WORDS) return null;
  if (/[.!?]$/.test(name)) return null;

  return name;
}

export function parseHnThread(data: unknown): string[] {
  const names: string[] = [];
  for (const child of asArray(asRecord(data)["children"])) {
    const text = asText(asRecord(child)["text"]);
    if (text === null) continue;
    const name = companyName(text);
    if (name !== null) names.push(name);
  }
  return names;
}

async function companies(options?: HttpOptions): Promise<string[]> {
  const id = await newestThreadId(options);
  if (id === null) return [];
  const data = await getJson<unknown>(itemUrl(id), options);
  return parseHnThread(data);
}

export const hnSource: Source = { name: "hn", companies };
