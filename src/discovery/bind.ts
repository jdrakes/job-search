import type { Reader } from "../ats/ats.ts";
import { aliased, boardKey, isGone, seen } from "../companies.ts";
import { describeError } from "../errors.ts";
import type { HttpOptions } from "../net/http.ts";
import type { Board, Company, Platform } from "../schema.ts";
import type { Store } from "../store/store.ts";

export interface NamedBoard {
  readonly name: string;
  readonly board: Board;
}

export interface WatchSummary {
  readonly watched: number;
  readonly aliases: number;
  readonly unchanged: number;
  readonly errors: readonly string[];
}

export interface BoardIndex {
  // boardKey -> every company carrying it that is not an alias; a row's owner is
  // any of them other than the row's own name.
  readonly carriers: Map<string, Set<string>>;
  // name -> the company row on file, for the state-aware unchanged check.
  readonly companies: Map<string, Company>;
}

export async function boardIndex(store: Store): Promise<BoardIndex> {
  const rows = await store.select<Company>("companies");
  const carriers = new Map<string, Set<string>>();
  const companies = new Map<string, Company>();
  for (const row of rows) {
    companies.set(row.name, row);
    if (row.state !== "alias") {
      for (const board of row.boards) {
        addCarrier(carriers, boardKey(board), row.name);
      }
    }
  }
  return { carriers, companies };
}

export function addCarrier(carriers: Map<string, Set<string>>, key: string, name: string): void {
  const names = carriers.get(key);
  if (names === undefined) carriers.set(key, new Set([name]));
  else names.add(name);
}

export function ownerOf(
  carriers: Map<string, Set<string>>,
  key: string,
  name: string,
): string | null {
  for (const carrier of carriers.get(key) ?? []) {
    if (carrier !== name) return carrier;
  }
  return null;
}

export function carriesBoard(company: Company, key: string): boolean {
  return company.boards.some((board) => boardKey(board) === key);
}

// The two branches under which `watchSurvey`'s loop leaves a row untouched:
// an alias on file is never revived, and a watched company already
// carrying the row's board (and not itself another company's board, which
// would make it that company's alias instead) gains nothing from being
// written again. Shared with `main`'s pre-pass, so `answering` below is
// asked only about rows a write would actually touch.
export function wouldBeUnchanged(index: BoardIndex, row: NamedBoard): boolean {
  const key = boardKey(row.board);
  const existing = index.companies.get(row.name);
  if (existing === undefined) return false;
  if (existing.state === "alias") return true;
  const owner = ownerOf(index.carriers, key, row.name);
  return owner === null && existing.state === "watched" && carriesBoard(existing, key);
}

// Refetches the row a write just produced, to keep "on file" current.
export async function refresh(
  store: Store,
  companies: Map<string, Company>,
  name: string,
): Promise<void> {
  const [row] = await store.select<Company>("companies", { name });
  if (row !== undefined) companies.set(name, row);
}

// `onWrite` hears each row the moment its write lands, never an unchanged
// one, so a caller logging writes keeps every line already written when a
// later row's store call throws.
export async function watchSurvey(
  store: Store,
  rows: readonly NamedBoard[],
  source: string,
  onWrite?: (row: NamedBoard) => void,
): Promise<WatchSummary> {
  const { carriers, companies } = await boardIndex(store);
  const errors: string[] = [];
  let watched = 0;
  let aliases = 0;
  let unchanged = 0;

  for (const row of rows) {
    const key = boardKey(row.board);

    // See wouldBeUnchanged.
    if (wouldBeUnchanged({ carriers, companies }, row)) {
      unchanged += 1;
      continue;
    }

    const owner = ownerOf(carriers, key, row.name);
    if (owner !== null) {
      await aliased(store, row.name, source, [row.board], owner);
      aliases += 1;
      await refresh(store, companies, row.name);
      onWrite?.(row);
      continue;
    }

    await seen(store, row.name, source, [row.board]);
    const result = await store.update("companies", row.name, { state: "watched" });
    if (result.ok) {
      watched += 1;
    } else {
      errors.push(`${row.name}: ${result.reason}`);
    }
    addCarrier(carriers, key, row.name);
    await refresh(store, companies, row.name);
    onWrite?.(row);
  }

  return { watched, aliases, unchanged, errors };
}

// The probe watches only a slug that answers; the survey wrote its rows by
// hand from careers pages that may since have moved, and the store keeps
// nothing about a board a company lost. So each board is asked once
// before either store is written. Gone and unreachable are told apart so
// a bad morning at the vendor is re-run, not recorded.
export async function answering(
  rows: readonly NamedBoard[],
  readers: Partial<Record<Platform, Reader>>,
  options?: HttpOptions,
): Promise<{
  rows: NamedBoard[];
  gone: { row: NamedBoard; line: string }[];
  unreachable: string[];
}> {
  const kept: NamedBoard[] = [];
  const gone: { row: NamedBoard; line: string }[] = [];
  const unreachable: string[] = [];
  for (const row of rows) {
    const reader = readers[row.board.platform];
    if (reader === undefined) {
      unreachable.push(`${row.name} ${boardKey(row.board)}: no reader`);
      continue;
    }
    try {
      await reader.list(row.board, options);
      kept.push(row);
    } catch (error) {
      const line = `${row.name} ${boardKey(row.board)}: ${describeError(error)}`;
      if (isGone(row.board.platform, error)) gone.push({ row, line });
      else unreachable.push(line);
    }
  }
  return { rows: kept, gone, unreachable };
}
