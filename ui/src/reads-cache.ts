/**
 * The last successful round of reads, kept in the session store so a
 * reload opens on it at once and refreshes behind it: the first read after
 * the store has been idle is seconds long. Beside the session in the same
 * store, so nothing new is trusted to the device; cleared on sign-out.
 */
import type { Company, Criteria, PostingSummary } from "../../src/schema.ts";
import type { SessionStore } from "./auth.ts";

export const READS_KEY = "job-search.reads";

export interface Reads {
  readonly queue: PostingSummary[];
  readonly postings: PostingSummary[];
  readonly companies: Company[];
  readonly criteria: Criteria | null;
}

/** The shape is checked, the rows are the store's own. */
export function loadReads(store: SessionStore): Reads | null {
  const text = store.getItem(READS_KEY);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    store.removeItem(READS_KEY);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { queue, postings, companies, criteria } = record;
  if (!Array.isArray(queue) || !Array.isArray(postings) || !Array.isArray(companies)) {
    store.removeItem(READS_KEY);
    return null;
  }
  if (criteria !== null && (typeof criteria !== "object" || criteria === undefined)) return null;
  return {
    queue: queue as PostingSummary[],
    postings: postings as PostingSummary[],
    companies: companies as Company[],
    criteria: criteria as Criteria | null,
  };
}

/** A full store (the quota) just means the next reload reads cold. */
export function saveReads(store: SessionStore, reads: Reads): void {
  try {
    store.setItem(READS_KEY, JSON.stringify(reads));
  } catch {
    store.removeItem(READS_KEY);
  }
}

export function clearReads(store: SessionStore): void {
  store.removeItem(READS_KEY);
}
