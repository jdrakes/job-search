// One-off backfill for #272: clears `body`/`body_hash` off every posting
// that has neither been acted on nor passed its listing criteria, the rule
// `toRow` applies on every future listed body. Run once, by hand, against
// the local Postgres, after a verbatim `pg_dump` of `postings` (see the
// plan). This script is not part of `daily.ts` and nothing schedules it.
//
//   node --env-file=.env scripts/clear-unread-bodies.ts
//
// It clears a body only where the listing criteria alone reject the
// posting: `judgeListing`, the same rule and call shape `toRow`
// (src/ingest.ts) applies on every listed body, for the same reason. It no
// longer recomputes the full text judgment. A body cleared on a text
// criterion may never come back: a one-phase board returns it only with a
// fresh listing, and a platform wrapped for one board's detail read answers
// null for every other board. `judgeAll`'s `wantsBody` asks for the body on
// the listing criteria alone, so a later re-judge with no relist would find
// none and judge the empty text back in. A listing "out" is one `wantsBody`
// also reaches, so that body is never asked for again. Bodies out only on
// their text stay; this reclaims the smaller, safe intersection.
//
// It judges against the current criteria and the current time, as any
// other re-judge does. `judged_with` is a criteria-version marker, not a
// clock, so it plays no part here. Board and duplicate context are left
// out (`NO_BOARDS`, no representative map), which can only keep more rows,
// never clear one the daily run would keep.
//
// A row whose board states `remote` or `onsite` keeps its body whatever
// the verdict: `scripts/score-remote.ts` scores the text detector against
// that stated word and reads those bodies unconditionally. Such rows are
// counted apart, as `workplaceScored`.
import process from "node:process";

import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import { judgeListing, NO_BOARDS } from "../src/judge/listing.ts";
import type { Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

// Everything `judgeListing()`'s `Pick` needs, plus what the candidate
// filter and the two exemptions read: `body`, `workplace`, `status`.
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
  "workplace",
  "status",
] as const satisfies readonly (keyof Posting)[];

type CandidateRow = Pick<Posting, (typeof CANDIDATE_COLUMNS)[number]>;

type ClearedRow = Pick<Posting, "key" | "company" | "body" | "body_hash">;

// Same size `writeVerdicts` (src/ingest.ts) flushes at: small enough that a
// failed batch, on a one-off run like this one, loses little.
const CLEAR_FLUSH = 200;

export interface ClearSummary {
  readonly cleared: number;
  readonly listingKept: number;
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
  let listingKept = 0;
  let workplaceScored = 0;
  let batch: ClearedRow[] = [];
  const now = new Date().toISOString();

  for (const row of candidates) {
    if (row.workplace === "remote" || row.workplace === "onsite") {
      workplaceScored += 1;
      continue;
    }
    const listing = judgeListing(
      {
        key: row.key,
        company: row.company,
        platform: row.platform,
        board: row.board,
        title: row.title,
        location: row.location,
        comp_high: row.comp_high,
        posted_at: row.posted_at,
        // Not gone, as `toRow` (src/ingest.ts) judges a listing it just
        // read: the body is cleared on the listing criteria alone.
        gone_at: null,
      },
      criteria,
      now,
      NO_BOARDS,
      new Map(),
    );
    if (listing.kept) {
      listingKept += 1;
      continue;
    }
    cleared += 1;
    batch.push({
      key: row.key,
      company: row.company,
      body: null,
      body_hash: null,
    });
    if (batch.length >= CLEAR_FLUSH) {
      await flush(store, batch);
      batch = [];
    }
  }
  await flush(store, batch);

  return { ok: true, cleared, listingKept, workplaceScored };
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
    `clear-unread-bodies: cleared ${result.cleared}, left alone (listing kept) ${result.listingKept}, left alone (workplace scored) ${result.workplaceScored}`,
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
