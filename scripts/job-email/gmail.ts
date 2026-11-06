// Reads mail through the Gmail REST API. `me` is the user id, so the
// address is never put in a request. Nothing here writes to Gmail.
import { describeError } from "../../src/errors.ts";
import type { Result } from "./result.ts";

export interface GmailMessage {
  readonly sender: string; // lower-case address only
  readonly subject: string;
  readonly date: string; // "2026-10-27T20:15:44Z"
  readonly labels: readonly string[];
  readonly text: string;
}

export interface GmailThread {
  readonly id: string;
  readonly messages: readonly GmailMessage[];
}

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DAY_MS = 86_400_000;

// "YYYY-MM-DD" for each UTC day from `since` through the UTC day of `today`.
export function utcDays(since: string, today: Date): readonly string[] {
  const last = Math.floor(today.getTime() / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let day = Date.parse(`${since}T00:00:00Z`); day <= last; day += DAY_MS) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

async function failureReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not JSON: the status line is the reason.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function getJson(
  accessToken: string,
  url: string,
  fetch: typeof globalThis.fetch,
): Promise<Result<unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    return { ok: false, reason: `Gmail request failed: ${describeError(error)}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `Gmail request failed: ${await failureReason(response)}` };
  }
  // The parser's message quotes the text it failed on, which can hold mail,
  // and the skill shows failure reasons in the session, so it is dropped.
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, reason: "Gmail reply was not JSON" };
  }
}

// Epoch seconds of a day's UTC midnight. A date literal in the query would
// be read as midnight Pacific, which is not the window the skill means.
function epochSeconds(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

async function listDay(
  accessToken: string,
  day: string,
  fetch: typeof globalThis.fetch,
): Promise<Result<readonly string[]>> {
  const start = epochSeconds(day);
  const query = `after:${start} before:${start + DAY_MS / 1000}`;
  const ids: string[] = [];
  let pageToken: string | null = null;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "500" });
    if (pageToken !== null) params.set("pageToken", pageToken);
    const page = await getJson(accessToken, `${API}/threads?${params}`, fetch);
    if (!page.ok) return page;
    const body = page.value as { threads?: unknown; nextPageToken?: unknown } | null;
    for (const thread of Array.isArray(body?.threads) ? body.threads : []) {
      const id = (thread as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return { ok: false, reason: "Gmail listed a thread with no id" };
      ids.push(id);
    }
    pageToken = typeof body?.nextPageToken === "string" ? body.nextPageToken : null;
  } while (pageToken !== null);
  return { ok: true, value: ids };
}

// One search per UTC day, deduped by thread id. Any failure fails the whole
// listing: a partial list must not pass as complete.
export async function listWindow(
  accessToken: string,
  days: readonly string[],
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<readonly string[]>> {
  const seen = new Set<string>();
  for (const day of days) {
    const listed = await listDay(accessToken, day, fetch);
    if (!listed.ok) return listed;
    for (const id of listed.value) seen.add(id);
  }
  return { ok: true, value: [...seen] };
}

interface Part {
  readonly mimeType?: unknown;
  readonly filename?: unknown;
  readonly body?: { data?: unknown } | null;
  readonly parts?: unknown;
}

// Depth-first, skipping attachments. Null when any part is not an object.
function collectParts(value: unknown): readonly Part[] | null {
  if (typeof value !== "object" || value === null) return null;
  const part = value as Part;
  if (typeof part.filename === "string" && part.filename !== "") return [];
  const collected: Part[] = [part];
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      const nested = collectParts(child);
      if (nested === null) return null;
      collected.push(...nested);
    }
  }
  return collected;
}

function decodeBody(part: Part): string {
  const data = part.body?.data;
  return typeof data === "string" ? Buffer.from(data, "base64url").toString("utf8") : "";
}

// An entity past the last Unicode code point stays as written.
function decodeEntity(entity: string, codePoint: number): string {
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeEntity(entity, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (entity, decimal: string) => decodeEntity(entity, Number(decimal)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Null when the payload holds a malformed part. A blank plain part does not
// count as plain text, so it cannot block its HTML sibling.
function messageText(payload: unknown): string | null {
  const parts = collectParts(payload);
  if (parts === null) return null;
  const plain = parts
    .filter((part) => part.mimeType === "text/plain")
    .map(decodeBody)
    .filter((text) => text.trim() !== "");
  if (plain.length > 0) return plain.join("\n");
  return parts
    .filter((part) => part.mimeType === "text/html")
    .map((part) => htmlToText(decodeBody(part)))
    .join("\n");
}

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return "";
  for (const header of headers) {
    const entry = header as { name?: unknown; value?: unknown } | null;
    if (typeof entry?.name === "string" && entry.name.toLowerCase() === name) {
      return typeof entry.value === "string" ? entry.value : "";
    }
  }
  return "";
}

function senderAddress(from: string): string {
  const bracketed = /<([^>]*)>/.exec(from);
  return (bracketed ? bracketed[1] : from).trim().toLowerCase();
}

function parseMessage(value: unknown): GmailMessage | null {
  const message = value as {
    internalDate?: unknown;
    labelIds?: unknown;
    payload?: (Part & { headers?: unknown }) | null;
  } | null;
  const epochMs = typeof message?.internalDate === "string" ? Number(message.internalDate) : NaN;
  const date = new Date(epochMs);
  if (message === null || Number.isNaN(date.getTime()) || !message.payload) return null;
  const text = messageText(message.payload);
  if (text === null) return null;
  const labels = Array.isArray(message.labelIds)
    ? message.labelIds.filter((label): label is string => typeof label === "string")
    : [];
  return {
    sender: senderAddress(headerValue(message.payload.headers, "from")),
    subject: headerValue(message.payload.headers, "subject"),
    date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    labels,
    text,
  };
}

// The only place the API's thread shape is read.
export function parseThread(value: unknown): Result<GmailThread> {
  const thread = value as { id?: unknown; messages?: unknown } | null;
  if (typeof thread?.id !== "string" || !Array.isArray(thread.messages)) {
    return { ok: false, reason: "Gmail thread has no id or messages" };
  }
  const messages: GmailMessage[] = [];
  for (const raw of thread.messages) {
    const message = parseMessage(raw);
    if (message === null) {
      return { ok: false, reason: `Gmail thread ${thread.id} has a malformed message` };
    }
    messages.push(message);
  }
  return { ok: true, value: { id: thread.id, messages } };
}

export async function getThread(
  accessToken: string,
  id: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<GmailThread>> {
  const fetched = await getJson(
    accessToken,
    `${API}/threads/${encodeURIComponent(id)}?format=full`,
    fetch,
  );
  if (!fetched.ok) return fetched;
  return parseThread(fetched.value);
}
