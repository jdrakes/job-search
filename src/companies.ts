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
// the row as the run began, and a sibling board's mark written since would
// be lost under it.
async function writeBoards(
  store: Store,
  name: string,
  rewrite: (boards: readonly Board[]) => readonly Board[],
): Promise<Company | null> {
  const [current] = await store.select<Company>("companies", { name });
  if (current === undefined) return null;
  const boards = rewrite(current.boards);
  const row: Company =
    boards.length === 0 && current.state === "watched"
      ? { ...current, boards, state: "discovered" }
      : { ...current, boards };
  await store.upsert("companies", [row]);
  return row;
}

// First gone run marks the board; the next removes it. A company left with
// no boards returns to `discovered`, which is what `returned` reports.
export async function boardGone(
  store: Store,
  company: Company,
  board: Board,
): Promise<{ returned: boolean }> {
  const marked = boardsOf(company).find((candidate) => sameBoard(candidate, board))?.gone;
  const row = await writeBoards(store, company.name, (boards) =>
    marked === undefined
      ? boards.map((candidate) =>
          sameBoard(candidate, board) ? { ...candidate, gone: 1 } : candidate,
        )
      : boards.filter((candidate) => !sameBoard(candidate, board)),
  );
  return { returned: row !== null && row.state !== company.state };
}

// A board that listed and had its rows recorded carries the run's start as
// `last_read` and loses any gone mark; the company's other boards are
// untouched. No boards read, no write.
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

// The set the ingest job walks: `watched` and not dropped. A `watched`
// company with no boards yet has nothing to list.
export async function watched(store: Store): Promise<Company[]> {
  const rows = await store.select<Company>("companies", { state: "watched", dropped_at: null });
  return rows.filter((company) => company.boards.length > 0);
}

// A name never seen becomes `discovered`. A name already present keeps its
// state and gains any board it did not have; existing boards are never
// replaced. An `alias` is left untouched: it is never revived as
// `discovered`. A dropped company's boards and `last_seen` are the
// processor's and move as any row's do; the flag alone keeps it unread.
export async function seen(
  store: Store,
  name: string,
  source: string,
  boards: readonly Board[],
): Promise<void> {
  const existing = await store.select<Company>("companies", { name });
  const current = existing[0];
  const now = new Date().toISOString();

  if (current === undefined) {
    const row: Company = {
      name,
      state: "discovered",
      boards,
      source,
      reason: null,
      first_seen: now,
      last_seen: now,
      dropped_at: null,
      alias_of: null,
    };
    await store.upsert("companies", [row]);
    return;
  }

  if (current.state === "alias") return;

  const merged = [...current.boards];
  for (const board of boards) {
    if (!merged.some((existingBoard) => sameBoard(existingBoard, board))) {
      merged.push(board);
    }
  }

  const row: Company = { ...current, boards: merged, last_seen: now };
  await store.upsert("companies", [row]);
}

// A board another company already carries means this name is that company:
// recorded `alias` with the owner, so it is never read and never revived.
// `dropped_at` and `reason` are the operator's and stay as the row has them.
export async function aliased(
  store: Store,
  name: string,
  source: string,
  boards: readonly Board[],
  owner: string,
): Promise<void> {
  const existing = await store.select<Company>("companies", { name });
  const current = existing[0];
  const now = new Date().toISOString();
  const row: Company = {
    name,
    state: "alias",
    boards,
    source: current?.source ?? source,
    reason: current?.reason ?? null,
    first_seen: current?.first_seen ?? now,
    last_seen: now,
    dropped_at: current?.dropped_at ?? null,
    alias_of: owner,
  };
  await store.upsert("companies", [row]);
}
