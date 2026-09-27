// One-off backfill for #273: converts every posting's `reasons` column from
// its old shape (a `{criterion, verdict, detail}` object per criterion that
// ran) to the new one `judge()` now writes (the failed criteria's names
// only, a `string[]`), and trims `evidence` to match what `judge()` would
// have stored under the new rule. Run once, by hand, against the local
// Postgres, after a verbatim `pg_dump` of `postings` (see the plan). This
// script is not part of `daily.ts` and nothing schedules it.
//
//   node --env-file=.env scripts/shrink-reasons.ts
//
// A row already in the new shape (its `reasons` is empty, or its first
// element is already a string) is left alone: the per-row check below is
// what tells old rows from new, since jsonb introspection at the query
// level is not something this project's `Store` interface exposes. Nothing
// reads a row's old shape before it is converted — `needsJudging`'s
// `hasReasonOut` only asks `Array.isArray(reasons) && reasons.includes(...)`,
// which is false for every object-shaped row, the same as if that row had
// no matching reason at all, so an unconverted row is simply re-judged the
// next time `needsJudging` would have said yes for an unrelated reason, and
// converted then by `judge()` itself.
//
// `evidence` is left as stored when the posting is kept or acted on
// (`status !== null`), the same "kept || acted" rule `judge()` applies when
// it writes a fresh verdict; otherwise it is set to `{}`, since a posting
// neither kept nor acted on is never shown and its detail text is exactly
// the cost this plan removes.
import process from "node:process";

import { describeError } from "../src/errors.ts";
import type { Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

const CANDIDATE_COLUMNS = [
  "key",
  "kept",
  "status",
  "reasons",
  "evidence",
] as const satisfies readonly (keyof Posting)[];

type CandidateRow = Pick<Posting, (typeof CANDIDATE_COLUMNS)[number]>;

type ShrunkRow = Pick<Posting, "key" | "reasons" | "evidence">;

// Same size `clearUnreadBodies` (#272) flushes at: small enough that a
// failed batch, on a one-off run like this one, loses little.
const SHRINK_FLUSH = 200;

export interface ShrinkSummary {
  readonly converted: number;
}

async function flush(store: Store, rows: readonly ShrunkRow[]): Promise<void> {
  if (rows.length === 0) return;
  await store.upsert("postings", rows);
}

// The old shape's one distinguishing mark once `reasons` is non-empty: its
// first element is an object (`{criterion, verdict, detail}`), where the
// new shape's is a string (a criterion name).
function isOldShape(reasons: readonly unknown[]): boolean {
  return reasons.length > 0 && typeof reasons[0] === "object" && reasons[0] !== null;
}

interface OldReason {
  readonly criterion: string;
  readonly verdict: "in" | "out";
}

function isOldReason(value: unknown): value is OldReason {
  return (
    typeof value === "object" &&
    value !== null &&
    "criterion" in value &&
    "verdict" in value &&
    typeof (value as OldReason).criterion === "string"
  );
}

export async function shrinkReasons(store: Store): Promise<ShrinkSummary> {
  const rows = await store.select<CandidateRow>("postings", undefined, CANDIDATE_COLUMNS);
  const candidates = rows.filter((row) => isOldShape(row.reasons));

  let converted = 0;
  let batch: ShrunkRow[] = [];

  for (const row of candidates) {
    const oldReasons = row.reasons.filter(isOldReason);
    const reasons = oldReasons
      .filter((reason) => reason.verdict === "out")
      .map((reason) => reason.criterion);
    const evidence = row.kept === true || row.status !== null ? row.evidence : {};

    batch.push({ key: row.key, reasons, evidence });
    converted += 1;
    if (batch.length >= SHRINK_FLUSH) {
      await flush(store, batch);
      batch = [];
    }
  }
  await flush(store, batch);

  return { converted };
}

async function main(): Promise<void> {
  const store = openStore();
  const result = await shrinkReasons(store);
  console.log(`shrink-reasons: converted ${result.converted}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`shrink-reasons: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
