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
// It is a one-time backfill against the current criteria and the current
// time, as any other re-judge is. `judged_with` is a criteria-version
// marker, not a clock, so it plays no part here. Board and duplicate
// context are left out (`NO_BOARDS`, no representative map), which can
// only keep more rows, never clear one the daily run would keep.
//
// A row whose board states `remote` or `onsite` keeps its body whatever
// the verdict: `scripts/score-remote.ts` scores the text detector against
// that stated word and reads those bodies unconditionally. Such rows are
// counted apart, as `workplaceScored`.
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
// on hand).
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
] as const satisfies readonly (keyof Posting)[];

type CandidateRow = Pick<Posting, (typeof CANDIDATE_COLUMNS)[number]>;

type ClearedRow = Pick<Posting, "key" | "company" | "last_seen" | "body" | "body_hash">;

// Same size `writeVerdicts` (src/ingest.ts) flushes at: small enough that a
// failed batch, on a one-off run like this one, loses little.
const CLEAR_FLUSH = 200;

export interface ClearSummary {
  readonly cleared: number;
  readonly keptAlone: number;
  readonly workplaceScored: number;
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
  let workplaceScored = 0;
  let batch: ClearedRow[] = [];
  const now = new Date().toISOString();

  for (const row of candidates) {
    if (row.workplace === "remote" || row.workplace === "onsite") {
      workplaceScored += 1;
      continue;
    }
    const result = judge(row, criteria, now, NO_BOARDS, new Map());
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

  return { ok: true, cleared, keptAlone, workplaceScored };
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
    `clear-unread-bodies: cleared ${result.cleared}, left alone (kept) ${result.keptAlone}, left alone (workplace scored) ${result.workplaceScored}`,
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
