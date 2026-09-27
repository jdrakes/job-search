// Reproduces one posting's full judgment on request. Judging is
// deterministic, so re-running `fullJudgment` against the row's stored
// columns explains a verdict without waiting for the next daily run to
// re-judge it, and without the trimmed `reasons`/`evidence` `judge()` now
// stores hiding any of it.
//
//   node --env-file=.env scripts/explain-posting.ts <key>
import process from "node:process";

import { READERS } from "../src/ats/readers.ts";
import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import { fullJudgment, representativeByKey } from "../src/judge/judge.ts";
import { boardIndex, type Reason } from "../src/judge/listing.ts";
import { COMPANY_FIELDS, type Company, type Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

// The columns `fullJudgment` reads for the one posting being explained,
// plus `first_seen` for completeness (not read by `fullJudgment` itself,
// only by `representativeByKey`'s sweep over every posting below).
const ROW_COLUMNS = [
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
  "first_seen",
] as const satisfies readonly (keyof Posting)[];

type ExplainedRow = Pick<Posting, (typeof ROW_COLUMNS)[number]>;

// The columns `representativeByKey` needs across every posting in the
// store, so this one row is judged against the same "who wins the
// duplicate key" answer the last daily run would have reached.
const REPRESENTATIVE_COLUMNS = [
  "key",
  "platform",
  "board",
  "posted_at",
  "comp_high",
  "location",
  "title",
  "first_seen",
  "last_seen",
] as const satisfies readonly (keyof Posting)[];

type RepresentativeRow = Pick<Posting, (typeof REPRESENTATIVE_COLUMNS)[number]>;

export interface Explanation {
  readonly ok: true;
  readonly kept: boolean;
  readonly reasons: readonly Reason[];
  // True when the row's platform reads a live detail page (a two-phase
  // board): this run judged from whatever body is already stored rather
  // than fetching a fresh one, so it reproduces what the last run decided,
  // not necessarily what a live read would say today.
  readonly usedStoredBody: boolean;
}

export type ExplainResult = Explanation | { readonly ok: false; readonly reason: string };

export async function explainPosting(store: Store, key: string): Promise<ExplainResult> {
  const rows = await store.select<ExplainedRow>("postings", { key }, ROW_COLUMNS);
  const row = rows[0];
  if (row === undefined) {
    return { ok: false, reason: `no posting with key "${key}"` };
  }

  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    return { ok: false, reason: criteriaResult.reason };
  }
  const criteria = criteriaResult.value;

  const companies = await store.select<Company>("companies", undefined, COMPANY_FIELDS);
  const boards = boardIndex(companies);

  const postings = await store.select<RepresentativeRow>(
    "postings",
    undefined,
    REPRESENTATIVE_COLUMNS,
  );
  const representative = representativeByKey(postings, criteria, boards);

  const reader = READERS[row.platform];
  const usedStoredBody = reader.body !== undefined;

  const { kept, reasons } = fullJudgment(
    row,
    criteria,
    new Date().toISOString(),
    boards,
    representative,
  );
  return { ok: true, kept, reasons, usedStoredBody };
}

function printExplanation(key: string, result: ExplainResult): void {
  if (!result.ok) {
    console.log(`explain-posting: ${result.reason}`);
    return;
  }
  console.log(`${key}:`);
  for (const reason of result.reasons) {
    console.log(`  ${reason.criterion} (${reason.verdict}): ${reason.detail}`);
  }
  console.log(`kept: ${result.kept}`);
  if (result.usedStoredBody) {
    console.log(
      "note: this platform reads a live detail page; this run used whatever body is " +
        "already stored rather than fetching one, so it reproduces the last run's " +
        "decision, not necessarily today's live listing.",
    );
  }
}

async function main(): Promise<void> {
  const key = process.argv[2];
  if (key === undefined) {
    console.error("explain-posting: usage: explain-posting.ts <key>");
    process.exitCode = 1;
    return;
  }
  const store = openStore();
  const result = await explainPosting(store, key);
  printExplanation(key, result);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`explain-posting: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
