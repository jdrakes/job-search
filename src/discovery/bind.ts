import type { Reader } from "../ats/ats.ts";
import { boardKey, isGone } from "../companies.ts";
import { describeError } from "../errors.ts";
import type { HttpOptions } from "../net/http.ts";
import type { Board, Platform } from "../schema.ts";

export interface NamedBoard {
  readonly name: string;
  readonly board: Board;
}

// The probe watches only a slug that answers; a pasted URL names a board
// off a careers page that may since have moved, and the store keeps
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
