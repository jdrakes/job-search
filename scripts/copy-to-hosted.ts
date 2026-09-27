// One-off copy for the switchover to one store (#284): everything the local
// store of record holds goes into the hosted store the list reads, so that
// store can become the only one. Run once, by hand, right before the run is
// pointed at the hosted store (#285), after a `pg_dump` of both stores.
// Nothing schedules it.
//
//   node --env-file=.env scripts/copy-to-hosted.ts
//
// It never writes a column James authors, the invariant `publishSlice`
// kept: for a posting the hosted store already has, its status, status_at,
// applied_at and note stay as they are there, since the hosted store is
// where they were written; a posting the hosted store lacks is copied whole,
// since there is nothing of his there to keep. For a company only its
// boards are copied: the drop and its reason are his. Criteria are not
// copied: the hosted row is the original. Candidates are copied whole:
// nothing writes a candidate to the hosted store yet, so the local rows are
// the record.
import process from "node:process";

import { describeError } from "../src/errors.ts";
import {
  CANDIDATE_FIELDS,
  POSTING_FIELDS,
  type Candidate,
  type Company,
  type Posting,
} from "../src/schema.ts";
import { postgresStore } from "../src/store/postgres.ts";
import type { Store } from "../src/store/store.ts";

// The four columns the list writes on a posting.
const JAMES_POSTING_COLUMNS = ["status", "status_at", "applied_at", "note"] as const;

// Small enough that one failed statement loses little, large enough that
// 144,000 rows are not 144,000 round trips. A posting's body is the bulk.
const COPY_BATCH = 200;

export interface CopySummary {
  readonly postings: number;
  readonly candidates: number;
  readonly companies: number;
}

async function upsertInBatches(
  store: Store,
  table: "postings" | "candidates" | "companies",
  rows: readonly object[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += COPY_BATCH) {
    await store.upsert(table, rows.slice(start, start + COPY_BATCH));
  }
}

function withoutJamesColumns(posting: Posting): Partial<Posting> {
  const row: Record<string, unknown> = { ...posting };
  for (const column of JAMES_POSTING_COLUMNS) delete row[column];
  return row as Partial<Posting>;
}

export async function copyToHosted(local: Store, hosted: Store): Promise<CopySummary> {
  const hostedKeys = new Set(
    (await hosted.select<Pick<Posting, "key">>("postings", undefined, ["key"])).map(
      (row) => row.key,
    ),
  );
  const postings = await local.select<Posting>("postings", undefined, POSTING_FIELDS);
  await upsertInBatches(
    hosted,
    "postings",
    postings.map((posting) =>
      hostedKeys.has(posting.key) ? withoutJamesColumns(posting) : posting,
    ),
  );

  const candidates = await local.select<Candidate>("candidates", undefined, CANDIDATE_FIELDS);
  await upsertInBatches(hosted, "candidates", candidates);

  const companies = await local.select<Pick<Company, "name" | "boards">>("companies", undefined, [
    "name",
    "boards",
  ]);
  await upsertInBatches(hosted, "companies", companies);

  return {
    postings: postings.length,
    candidates: candidates.length,
    companies: companies.length,
  };
}

function urlOf(name: string): string {
  const url = process.env[name];
  if (url === undefined || url === "") {
    throw new Error(`copy-to-hosted: ${name} is not set`);
  }
  return url;
}

async function main(): Promise<void> {
  const local = postgresStore({ url: urlOf("JOB_SEARCH_DB_URL") });
  const hosted = postgresStore({ url: urlOf("SUPABASE_DB_URL") });
  const summary = await copyToHosted(local, hosted);
  console.log(
    `copy-to-hosted: ${summary.postings} postings, ${summary.candidates} candidates, ` +
      `${summary.companies} companies' boards`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`copy-to-hosted: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
