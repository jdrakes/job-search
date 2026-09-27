// Reads the `companies` table for the list phase and says what a board's
// answer means. It writes nothing: discovery (discover.ts) is the daily
// run's only writer of `companies`. A board is data, `{platform, id}`, never derived
// from a company's name.
import { HttpError } from "./net/http.ts";
import type { Board, Company, Platform } from "./schema.ts";
import type { Store } from "./store/store.ts";

// A board is only ever compared as the pair, never by id alone: two
// platforms can hand out the same id.
export function boardKey(board: Board): string {
  return `${board.platform}::${board.id}`;
}

export function boardsOf(company: Company): readonly Board[] {
  return company.boards;
}

// The statuses each ATS answers for a board that does not exist. A platform
// absent here gives no signal that tells gone from empty. Workday 422 is a
// tenant that is gone, measured 2026-09-22. Six of the nine platforms added
// alongside this comment (2026-09-22) redirect or DNS-fail on a dead slug
// rather than answering a distinguishable HttpError: Jobvite and JazzHR
// redirect to the vendor's own marketing page, BambooHR redirects into a
// 200 that fails JSON parsing rather than answering an HttpError, Avature
// and iCIMS DNS-fail, and Personio answers a 307. None of those is visible
// here; only the three that answer a clean 404 (Breezy, Recruitee,
// HRMDirect) get entries.
const GONE_STATUSES: Partial<Record<Platform, readonly number[]>> = {
  greenhouse: [404],
  ashby: [404],
  lever: [404],
  workday: [400, 404, 422],
  eightfold: [404],
  workable: [404],
  rippling: [404],
  breezy: [404],
  recruitee: [404],
  hrmdirect: [404],
};

export function isGone(platform: Platform, error: unknown): boolean {
  return error instanceof HttpError && (GONE_STATUSES[platform] ?? []).includes(error.status);
}

// The set the ingest job walks: not dropped, and at least one board to list.
export async function readable(store: Store): Promise<Company[]> {
  const rows = await store.select<Company>("companies", { dropped_at: null });
  return rows.filter((company) => company.boards.length > 0);
}
