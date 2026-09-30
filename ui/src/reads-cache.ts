/**
 * The last successful answer to each read, kept in the session store so a
 * reload opens on it at once and refreshes behind it: the first read after
 * the store has been idle is seconds long. Beside the session in the same
 * store, so nothing new is trusted to the device; cleared on sign-out.
 *
 * Each read is kept on its own: the page draws a read as it lands, so one
 * that fails leaves the others' cached rows where they were rather than
 * holding every one of them back.
 */
import type { Candidate, Company, Criteria, PostingSummary } from "../../src/schema.ts";
import type { SessionStore } from "./auth.ts";

export const READS_KEY = "job-search.reads";

export interface Reads {
  readonly queue: PostingSummary[];
  readonly postings: PostingSummary[];
  readonly companies: Company[];
  readonly criteria: Criteria;
  readonly candidates: Candidate[];
}

export type ReadName = keyof Reads;

export const READ_NAMES = [
  "queue",
  "postings",
  "companies",
  "criteria",
  "candidates",
] as const satisfies readonly ReadName[];

/** Whatever reads the store holds; a field that is missing or the wrong shape is left out. */
export type CachedReads = Partial<Reads>;

function wellShaped(name: ReadName, value: unknown): boolean {
  if (name === "criteria") return typeof value === "object" && value !== null;
  return Array.isArray(value);
}

/** The shape is checked, the rows are the store's own. */
export function loadReads(store: SessionStore): CachedReads | null {
  const text = store.getItem(READS_KEY);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    store.removeItem(READS_KEY);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    store.removeItem(READS_KEY);
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const reads: Record<string, unknown> = {};
  for (const name of READ_NAMES) {
    if (wellShaped(name, record[name])) reads[name] = record[name];
  }
  if (Object.keys(reads).length === 0) {
    store.removeItem(READS_KEY);
    return null;
  }
  return reads as CachedReads;
}

/** A full store (the quota) just means the next reload reads cold. */
export function saveReads(store: SessionStore, reads: CachedReads): void {
  try {
    store.setItem(READS_KEY, JSON.stringify(reads));
  } catch {
    store.removeItem(READS_KEY);
  }
}

/** One read's answer, written over that read alone. */
export function saveRead<K extends ReadName>(store: SessionStore, name: K, value: Reads[K]): void {
  saveReads(store, { ...loadReads(store), [name]: value });
}

export function clearReads(store: SessionStore): void {
  store.removeItem(READS_KEY);
}
