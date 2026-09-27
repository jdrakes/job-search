// The only reader and writer of the `companies` table. A board is data,
// `{platform, id}`, never derived from a company's name; every board
// written here was supplied by a caller that knows it.
import { HttpError } from "./net/http.ts";
import type { Board, Company, Platform } from "./schema.ts";
import type { Store } from "./store/store.ts";

// A board is only ever compared as the pair, never by id alone: two
// platforms can hand out the same id.
export function boardKey(board: Board): string {
  return `${board.platform}::${board.id}`;
}

function sameBoard(a: Board, b: Board): boolean {
  return boardKey(a) === boardKey(b);
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

// The row is read back rather than taken from the caller: the caller holds
// the row as the run began, and a sibling board's removal or `last_read`
// written since would be lost under it.
async function writeBoards(
  store: Store,
  name: string,
  rewrite: (boards: readonly Board[]) => readonly Board[],
): Promise<Company | null> {
  const [current] = await store.select<Company>("companies", { name });
  if (current === undefined) return null;
  const row: Company = { ...current, boards: rewrite(current.boards) };
  await store.upsert("companies", [row]);
  return row;
}

// A board that answers gone is removed from its company at once, no
// two-run mark. A company left with no board is simply not read
// (`readable`); `returned` reports whether this call took its last one.
export async function boardGone(
  store: Store,
  company: Company,
  board: Board,
): Promise<{ returned: boolean }> {
  const row = await writeBoards(store, company.name, (boards) =>
    boards.filter((candidate) => !sameBoard(candidate, board)),
  );
  return { returned: row !== null && row.boards.length === 0 };
}

// A board that listed and had its rows recorded carries the run's start as
// `last_read`; the company's other boards are untouched. No boards read, no
// write.
export async function recordBoardsRead(
  store: Store,
  company: Company,
  boards: readonly Board[],
  at: string,
): Promise<void> {
  if (boards.length === 0) return;
  const read = boards.map(boardKey);
  await writeBoards(store, company.name, (current) =>
    current.map((candidate) =>
      read.includes(boardKey(candidate))
        ? { platform: candidate.platform, id: candidate.id, last_read: at }
        : candidate,
    ),
  );
}

// The set the ingest job walks: not dropped, and at least one board to list.
export async function readable(store: Store): Promise<Company[]> {
  const rows = await store.select<Company>("companies", { dropped_at: null });
  return rows.filter((company) => company.boards.length > 0);
}
