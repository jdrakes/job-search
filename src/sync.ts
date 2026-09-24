// Pulls the operator's decisions down from the hosted store into the local store
// of record, and publishes the slice the list reads back up.
//
// The list is the only writer to the hosted store and `ui/src/api.ts` has
// one mutating helper (`patchOne`), so these three are the whole of it:
//
//   setStatus        postings   status, status_at, applied_at, note
//   setCompanyDrop   companies  dropped_at, reason
//   saveCriteria     criteria   the whole row, updated_at included
//
// The pull reads those columns and nothing else. Criteria flows down only:
// its `updated_at` is what `needsJudging` compares `judged_with` against,
// so pulling it is what turns a criteria edit into that morning's re-judge.
import {
  COMPANY_FIELDS,
  CRITERIA_FIELDS,
  POSTING_LIST_FIELDS,
  type Company,
  type Criteria,
  type Posting,
  type Table,
} from "./schema.ts";
import { PRIMARY_KEYS, type Store } from "./store/store.ts";

// Named once and used to read, to compare and to patch, so the pull cannot
// widen past them.
const STATUS_COLUMNS = [
  "status",
  "status_at",
  "applied_at",
  "note",
] as const satisfies readonly (keyof Posting)[];

const DROP_COLUMNS = ["dropped_at", "reason"] as const satisfies readonly (keyof Company)[];

export interface PullResult {
  readonly statuses: number;
  readonly companies: number;
  readonly hasCriteria: boolean;
  // Decisions on rows the local store does not have.
  readonly skipped: number;
}

// `update`, not `upsert`: Postgres checks a NOT NULL constraint while it
// forms the tuple, before `ON CONFLICT` can route the row to its update, and
// `postings.company` and both tables' `first_seen`/`last_seen` are NOT NULL
// with no DEFAULT. An UPDATE names only what it sets.
async function pullColumns(
  local: Store,
  hosted: Store,
  table: Table,
  columns: readonly string[],
  isDecided: (row: Readonly<Record<string, unknown>>) => boolean,
): Promise<{ readonly written: number; readonly skipped: number }> {
  const key = PRIMARY_KEYS[table];
  const read = [key, ...columns];
  const decided = (await hosted.select<Record<string, unknown>>(table, undefined, read)).filter(
    isDecided,
  );
  const stored = new Map(
    (await local.select<Record<string, unknown>>(table, undefined, read)).map((row) => [
      String(row[key]),
      row,
    ]),
  );

  let written = 0;
  let skipped = 0;
  for (const decision of decided) {
    const id = String(decision[key]);
    const before = stored.get(id);
    // The pull holds four columns of a posting, not a posting, so there is
    // nothing to create a missing local row from. The decision stays in the
    // hosted store, where publish never deletes a row that carries a status.
    if (before === undefined) {
      skipped += 1;
      continue;
    }
    // Only what differs is written, so a morning with no new decisions costs
    // two reads and no writes.
    const unchanged = columns.every(
      (column) => (before[column] ?? null) === (decision[column] ?? null),
    );
    if (unchanged) continue;
    const patch = Object.fromEntries(columns.map((column) => [column, decision[column] ?? null]));
    const result = await local.update(table, id, patch);
    // The read said the row was there and the write found it gone.
    if (result.ok) written += 1;
    else skipped += 1;
  }
  return { written, skipped };
}

export async function pullDecisions(local: Store, hosted: Store): Promise<PullResult> {
  // A status is only ever set, never cleared (`StatusPatch` requires a
  // `Status`), so a hosted posting with no status carries no decision, and
  // writing its four null columns down would erase a status the local store
  // holds.
  const statuses = await pullColumns(
    local,
    hosted,
    "postings",
    STATUS_COLUMNS,
    (row) => row["status"] !== null,
  );

  // Every company, nulls included: a cleared drop is a decision too, and
  // only a null `dropped_at` can carry it down. The opposite of the postings
  // rule above, because no processor write ever sets these two columns.
  // Rows with no drop on either side compare equal and cost nothing.
  const companies = await pullColumns(local, hosted, "companies", DROP_COLUMNS, () => true);

  // An upsert, since every NOT NULL column of `criteria` is in it: a local
  // store with no criteria row gets one rather than judging against nothing.
  // A hosted store with no row leaves the local one alone.
  const [criteria] = await hosted.select<Criteria>("criteria", { id: 1 }, CRITERIA_FIELDS);
  if (criteria !== undefined) await local.upsert("criteria", [criteria]);

  return {
    statuses: statuses.written,
    companies: companies.written,
    hasCriteria: criteria !== undefined,
    skipped: statuses.skipped + companies.skipped,
  };
}

// What the list reads, less the four columns James authors. Omitting them is
// what lets a publish run safely after a failed pull: `ON CONFLICT DO
// UPDATE` touches only the columns named, so a decision this process never
// read cannot be overwritten. The invariant is the payload's shape, not the
// order of the phases.
const PUBLISHED_POSTING_FIELDS = POSTING_LIST_FIELDS.filter(
  (field) => !(STATUS_COLUMNS as readonly string[]).includes(field),
);

// The same invariant for companies: a drop made in the list between this
// run's pull and its publish is not on the local row, and a publish that
// named `dropped_at` would write it back to null.
const PUBLISHED_COMPANY_FIELDS = COMPANY_FIELDS.filter(
  (field) => !(DROP_COLUMNS as readonly string[]).includes(field),
);

export interface PublishResult {
  readonly postings: number;
  readonly companies: number;
  readonly removed: number;
}

// What the list shows: `ui/src/api.ts` reads the queue (`kept=is.true&status=is.null`),
// the record (`kept.is.true,status.not.is.null`), every company, and the
// criteria row. A few hundred rows against the store of record's tens of
// thousands.
function inSlice(posting: Pick<Posting, "kept" | "status">): boolean {
  return posting.kept || posting.status !== null;
}

export async function publishSlice(local: Store, hosted: Store): Promise<PublishResult> {
  const slice = (await local.select<Posting>("postings", undefined, POSTING_LIST_FIELDS)).filter(
    inSlice,
  );
  const rows = slice.map((posting) =>
    Object.fromEntries(
      PUBLISHED_POSTING_FIELDS.map((field) => [field, posting[field as keyof Posting]]),
    ),
  );
  if (rows.length > 0) await hosted.upsert("postings", rows);

  // Every company, less the two columns James authors: the table is under a
  // megabyte. The select's column list is the payload's shape.
  const companies = await local.select<Company>("companies", undefined, PUBLISHED_COMPANY_FIELDS);
  if (companies.length > 0) await hosted.upsert("companies", companies);

  // Criteria is not published: the hosted row is the original.

  // The one read that still crosses the whole hosted table; it stays two
  // columns wide.
  const hostedRows = await hosted.select<Pick<Posting, "key" | "status">>("postings", undefined, [
    "key",
    "status",
  ]);
  const keep = new Set(slice.map((posting) => posting.key));
  // Never a row that carries a status: a posting James acted on is his
  // record, whatever the processor now says of it.
  const stale = hostedRows
    .filter((row) => !keep.has(row.key) && row.status === null)
    .map((row) => row.key);
  if (stale.length > 0) await hosted.delete("postings", stale);

  return { postings: rows.length, companies: companies.length, removed: stale.length };
}
