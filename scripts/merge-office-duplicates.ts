// One-off backfill for postings stored before same-requisition offices were
// grouped at ingest: a Greenhouse requisition posted once per office was
// written as one `postings` row per office. Future ingests write one row per
// requisition (`groupByRequisition`, src/ingest.ts); this merges the rows
// already on file. Not part of `daily.ts`; nothing schedules it.
//
//   node --env-file=.env scripts/merge-office-duplicates.ts           # print the plan
//   node --env-file=.env scripts/merge-office-duplicates.ts --apply   # print it, then write it
//
// Every board with an unacted-on posting is re-read live and grouped by
// requisition. A group whose offices match two or more stored rows merges
// into the primary's row (the lowest listing id, as ingest picks it): that
// row takes every office in `locations` and the others are deleted. A group
// where a non-primary row carries a status (James decided on that office
// before this fix) or whose primary has no stored row is deferred, printed
// for manual review, and nothing in it is written.
import process from "node:process";

import type { Listing, Reader } from "../src/ats/ats.ts";
import { READERS } from "../src/ats/readers.ts";
import { describeError } from "../src/errors.ts";
import { groupByRequisition } from "../src/ingest.ts";
import { type Board, type Office, type Platform, type Posting, postingKey } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

const STORED_COLUMNS = [
  "key",
  "company",
  "platform",
  "board",
  "status",
] as const satisfies readonly (keyof Posting)[];

export type StoredRow = Pick<Posting, (typeof STORED_COLUMNS)[number]>;

export interface Merge {
  readonly company: string;
  readonly keep: string;
  readonly locations: readonly Office[];
  readonly remove: readonly string[];
}

export interface Deferred {
  readonly keep: string;
  readonly keys: readonly string[];
  readonly reason: string;
}

export interface BoardPlan {
  readonly merges: readonly Merge[];
  readonly deferred: readonly Deferred[];
}

// Pure: one board's fresh listings against every stored row, by key.
export function planBoardMerges(
  board: Board,
  stored: ReadonlyMap<string, StoredRow>,
  listings: readonly Listing[],
): BoardPlan {
  // Keyed the same way `groupByRequisition` (src/ingest.ts) now keys its own
  // groups: `(requisitionId, title)`, not bare `requisitionId`. A reused
  // placeholder requisition id ("N/A", "TBD") can span two different roles,
  // and without the title in the key this map would bundle both roles'
  // stored rows into one merge plan, disagreeing with what a future ingest
  // would write.
  const memberIds = new Map<string, Set<string>>();
  for (const listing of listings) {
    if (listing.requisitionId === null) continue;
    const key = `${listing.requisitionId}\u0000${listing.title}`;
    const ids = memberIds.get(key) ?? new Set<string>();
    ids.add(listing.id);
    memberIds.set(key, ids);
  }

  const merges: Merge[] = [];
  const deferred: Deferred[] = [];
  for (const group of groupByRequisition(listings)) {
    if (group.requisitionId === null) continue;
    const keep = postingKey(board, group.id);
    const groupKey = `${group.requisitionId}\u0000${group.title}`;
    const keys = [...(memberIds.get(groupKey) ?? [])]
      .map((id) => postingKey(board, id))
      .filter((key) => stored.has(key))
      .sort();
    if (keys.length < 2) continue;

    const primary = stored.get(keep);
    if (primary === undefined) {
      deferred.push({ keep, keys, reason: "primary office has no stored row" });
      continue;
    }
    const others = keys.filter((key) => key !== keep);
    const decided = others.filter((key) => stored.get(key)?.status !== null);
    if (decided.length > 0) {
      deferred.push({ keep, keys, reason: `status set on ${decided.join(", ")}` });
      continue;
    }
    merges.push({ company: primary.company, keep, locations: group.locations, remove: others });
  }
  return { merges, deferred };
}

export interface MergeRun {
  readonly merges: readonly Merge[];
  readonly deferred: readonly Deferred[];
  readonly errors: readonly string[];
}

// Every `(platform, board)` holding a posting with no status, in key order.
function boardsToCheck(rows: readonly StoredRow[]): readonly Board[] {
  const boards = new Map<string, Board>();
  for (const row of rows) {
    if (row.status !== null || row.board === null) continue;
    const board = { platform: row.platform, id: row.board };
    boards.set(`${board.platform}/${board.id}`, board);
  }
  return [...boards.values()];
}

// Reads and plans every board; writes only when `apply` is true. A board
// whose read fails is an error line and plans nothing.
export async function mergeOfficeDuplicates(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  apply: boolean,
): Promise<MergeRun> {
  const rows = await store.select<StoredRow>("postings", undefined, STORED_COLUMNS);
  const stored = new Map(rows.map((row) => [row.key, row]));

  const merges: Merge[] = [];
  const deferred: Deferred[] = [];
  const errors: string[] = [];
  for (const board of boardsToCheck(rows)) {
    const reader = readers[board.platform];
    if (reader === undefined) {
      errors.push(`${board.platform}/${board.id}: no reader`);
      continue;
    }
    let listings: readonly Listing[];
    try {
      listings = await reader.list(board);
    } catch (error) {
      errors.push(`${board.platform}/${board.id}: ${describeError(error)}`);
      continue;
    }
    const plan = planBoardMerges(board, stored, listings);
    merges.push(...plan.merges);
    deferred.push(...plan.deferred);
  }

  if (apply && merges.length > 0) {
    // Locations first: a failed delete after it leaves every row in place,
    // and a rerun plans the same merge again.
    await store.upsert(
      "postings",
      merges.map((merge) => ({
        key: merge.keep,
        company: merge.company,
        locations: merge.locations,
      })),
    );
    await store.delete(
      "postings",
      merges.flatMap((merge) => merge.remove),
    );
  }
  return { merges, deferred, errors };
}

function printRun(run: MergeRun, apply: boolean): void {
  for (const merge of run.merges) {
    const offices = merge.locations.map((office) => office.name ?? "(unnamed)").join("; ");
    console.log(`merge: keep ${merge.keep} [${offices}], delete ${merge.remove.join(", ")}`);
  }
  for (const conflict of run.deferred) {
    console.log(`deferred: ${conflict.keys.join(", ")} (${conflict.reason})`);
  }
  for (const error of run.errors) console.error(`error: ${error}`);
  const removed = run.merges.reduce((total, merge) => total + merge.remove.length, 0);
  const verb = apply ? "applied" : "dry run, pass --apply to write";
  console.log(
    `merge-office-duplicates: ${verb}: ${run.merges.length} merges (${removed} rows to delete), ${run.deferred.length} deferred, ${run.errors.length} errors`,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const run = await mergeOfficeDuplicates(openStore(), READERS, apply);
  printRun(run, apply);
  if (run.errors.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`merge-office-duplicates: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
