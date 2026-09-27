// One-off backfill for #272: clears `body`/`body_hash` off every posting
// that has neither been acted on nor cleared its own judgment, the same
// rule Tasks 1 and 2 now apply on every future write. Run once, by hand,
// against the local Postgres, after a verbatim `pg_dump` of `postings` (see
// the plan) — this script is not part of `daily.ts` and nothing schedules
// it.
//
//   node --env-file=.env scripts/clear-unread-bodies.ts
//
// This recomputes `kept` with `judge()` rather than trusting the stored
// column: a row's stored `kept` was true (or false) under whatever
// criteria were live at its `judged_with`, and a criteria edit since then
// can leave a stale `kept: true` on a row current criteria would now drop —
// exactly the case this backfill exists to catch. Recomputing is one
// `judge()` call per candidate row, no more than `judgeAll` already pays
// per posting on every daily run.
//
// `posting.judged_with` (when present) stands in for "now": judging on the
// criteria version the row actually carries keeps this a backfill against
// what was last decided, not a fresh re-judge under today's criteria and
// today's age — the next real daily run does that re-judging, on its own
// schedule, against `NO_BOARDS` and no duplicate map either way, so nothing
// here does that job twice.
import process from "node:process";

import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import { judge } from "../src/judge/judge.ts";
import { NO_BOARDS } from "../src/judge/listing.ts";
import type { Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

// Everything `judge()`'s `Pick` needs, plus `body_hash` (not part of that
// `Pick`, but read here so a future change to the clearing payload has it
// on hand) and `judged_with` (stands in for "now", see above).
const CANDIDATE_COLUMNS = [
  "key",
  "company",
  "platform",
  "board",
  "title",
  "location",
  "comp_high",
  "posted_at",
  "body",
  "last_seen",
  "workplace",
  "status",
  "body_hash",
  "judged_with",
] as const satisfies readonly (keyof Posting)[];

type CandidateRow = Pick<Posting, (typeof CANDIDATE_COLUMNS)[number]>;

type ClearedRow = Pick<Posting, "key" | "company" | "last_seen" | "body" | "body_hash">;

// Same size `writeVerdicts` (src/ingest.ts) flushes at: small enough that a
// failed batch, on a one-off run like this one, loses little.
const CLEAR_FLUSH = 200;

export interface ClearSummary {
  readonly cleared: number;
  readonly keptAlone: number;
}

export type ClearResult =
  ({ readonly ok: true } & ClearSummary) | { readonly ok: false; readonly reason: string };

async function flush(store: Store, rows: readonly ClearedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await store.upsert("postings", rows);
}

// Every posting neither acted on (`status IS NULL`) nor already bodyless is
// a candidate; `store.select`'s `eq` only tests equality, so the `body IS
// NOT NULL` half of the selection is filtered here.
export async function clearUnreadBodies(store: Store): Promise<ClearResult> {
  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    return { ok: false, reason: criteriaResult.reason };
  }
  const criteria = criteriaResult.value;

  const rows = await store.select<CandidateRow>("postings", { status: null }, CANDIDATE_COLUMNS);
  const candidates = rows.filter((row) => row.body !== null);

  let cleared = 0;
  let keptAlone = 0;
  let batch: ClearedRow[] = [];

  for (const row of candidates) {
    const result = judge(
      row,
      criteria,
      row.judged_with ?? new Date().toISOString(),
      NO_BOARDS,
      new Map(),
    );
    if (result.kept) {
      keptAlone += 1;
      continue;
    }
    cleared += 1;
    batch.push({
      key: row.key,
      company: row.company,
      last_seen: row.last_seen,
      body: null,
      body_hash: null,
    });
    if (batch.length >= CLEAR_FLUSH) {
      await flush(store, batch);
      batch = [];
    }
  }
  await flush(store, batch);

  return { ok: true, cleared, keptAlone };
}

async function main(): Promise<void> {
  const store = openStore();
  const result = await clearUnreadBodies(store);
  if (!result.ok) {
    console.error(`clear-unread-bodies: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `clear-unread-bodies: cleared ${result.cleared}, left alone (kept) ${result.keptAlone}`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`clear-unread-bodies: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
