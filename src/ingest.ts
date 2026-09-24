// The daily job: list every watched company's boards, then judge every
// posting in the store. Every row shape below leans on `Store#upsert`'s
// contract for what an omitted column means; see `store.ts` and `toRow`.
import { createHash } from "node:crypto";

import { compInText, type Listing, type Reader } from "./ats/ats.ts";
import { boardGone, boardsOf, isGone, recordBoardsRead, watched } from "./companies.ts";
import { loadCriteria } from "./criteria.ts";
import { describeError } from "./errors.ts";
import { judge, needsJudging, representativeByKey } from "./judge/judge.ts";
import { type BoardIndex, boardIndex, judgeListing } from "./judge/listing.ts";
import {
  COMPANY_FIELDS,
  postingKey,
  type Board,
  type Company,
  type Criteria,
  type Platform,
  type Posting,
  type Workplace,
} from "./schema.ts";
import type { Store } from "./store/store.ts";

export interface IngestResult {
  readonly companies: number;
  readonly listed: number;
  readonly recorded: number;
  readonly errors: readonly string[];
  // Companies returned to `discovered` this run, as `<company> <platform>/<id>`.
  readonly returned: readonly string[];
}

export interface JudgeResult {
  readonly judged: number;
  readonly errors: readonly string[];
}

export interface JudgeOptions {
  readonly now?: () => string;
}

export interface IngestOptions {
  readonly now?: () => string;
}

// The columns a re-list always writes. `first_seen` is not among them: the
// column default records the first insert.
type ListedFields = Pick<
  Posting,
  | "key"
  | "company"
  | "platform"
  | "board"
  | "title"
  | "url"
  | "location"
  | "posted_at"
  | "last_seen"
>;

// The rest of what a re-list can write; `toRow` leaves each out where there
// is nothing new to say, so the upsert keeps the stored value.
interface ListedRow extends ListedFields {
  readonly workplace?: Workplace | null;
  readonly comp_low?: number | null;
  readonly comp_high?: number | null;
  readonly body?: string;
  readonly body_hash?: string;
  readonly judged_with?: null;
}

// md5 hex, the same value Postgres's md5(text) gives for the stored column.
function bodyHash(body: string): string {
  return createHash("md5").update(body, "utf8").digest("hex");
}

function toRow(
  company: string,
  board: Board,
  listing: Listing,
  timestamp: string,
  stored: StoredListing | undefined,
): ListedRow {
  const fields: ListedFields = {
    key: postingKey(board, listing.id),
    company,
    platform: board.platform,
    board: board.id,
    title: listing.title,
    url: listing.url,
    location: listing.location,
    posted_at: listing.postedAt,
    last_seen: timestamp,
  };
  const statesWorkplace = listing.body !== null || listing.workplace !== null;
  const bare: ListedRow = statesWorkplace ? { ...fields, workplace: listing.workplace } : fields;
  // Withdrawn (stored set, listed null) counts as changed: the text path
  // takes over. `stored === undefined` (never recorded, or the pre-run
  // sweep's read failed) makes no claim either way, and nor does a listing
  // that leaves the column out.
  const workplaceChanged =
    statesWorkplace && stored !== undefined && stored.workplace !== listing.workplace;
  // Nothing to read a comp from: the comp columns stay out of the payload
  // and the store keeps what the judging pass wrote.
  if (listing.body === null && listing.compLow === null && listing.compHigh === null) {
    return workplaceChanged ? { ...bare, judged_with: null } : bare;
  }
  // Integer columns; a board can post an hourly rate, which Postgres would
  // refuse and lose the whole batch over. An hourly figure is far below any
  // annual floor, so rounding changes no verdict.
  const row: ListedRow = {
    ...bare,
    comp_low: wholeDollars(listing.compLow),
    comp_high: wholeDollars(listing.compHigh),
  };
  // A band that disagrees with what is stored needs a fresh verdict.
  const verdictInputChanged =
    workplaceChanged || (stored !== undefined && stored.comp_high !== row.comp_high);
  if (listing.body === null) return verdictInputChanged ? { ...row, judged_with: null } : row;
  const hash = bodyHash(listing.body);
  // An unchanged body is left out of the payload, so the row goes as a small
  // listing-fields update instead of the text the store already has.
  if (hash === (stored?.body_hash ?? null)) {
    return verdictInputChanged ? { ...row, judged_with: null } : row;
  }
  const withBody: ListedRow = { ...row, body: listing.body, body_hash: hash };
  return verdictInputChanged ? { ...withBody, judged_with: null } : withBody;
}

// Cut at the first `::`, so an id carrying `::` comes back whole.
function postingIdOf(posting: Pick<Posting, "key">): string {
  return posting.key.slice(posting.key.indexOf("::") + 2);
}

// `body` is absent: most of a posting's bytes, read one row at a time by
// `storedBody` only for a posting the text criteria are about to judge.
const JUDGING_COLUMNS = [
  "key",
  "company",
  "platform",
  "board",
  "title",
  "location",
  "posted_at",
  "comp_high",
  "comp_low",
  "workplace",
  // Read by the gone criterion against the board's `last_read`.
  "last_seen",
  // Every row in the sweep can be a key's representative.
  "first_seen",
  "judged_with",
  // `needsJudging` reads both: the age verdict moves with time only for a
  // kept posting, and a gone-dropped posting listed again is told apart by
  // its stored reason.
  "kept",
  "reasons",
] as const satisfies readonly (keyof Posting)[];

type JudgingRow = Pick<Posting, (typeof JUDGING_COLUMNS)[number]>;

async function storedBody(store: Store, key: string): Promise<string | null> {
  const rows = await store.select<Pick<Posting, "body">>("postings", { key }, ["body"]);
  return rows[0]?.body ?? null;
}

// Postgres builds the INSERT tuple before it finds the conflict, so every
// NOT NULL column without a default (`company`, `last_seen`) has to be in
// the payload even though the row exists; they are carried back as read.
// `comp_low`/`comp_high` travel the same way: listing and judging are
// sequential in `daily.ts`, so nothing changes a comp between the read and
// the write. `body` and `workplace` stay out unless the judging pass
// fetched a detail, so the stored values, if any, survive.
interface VerdictRow extends Pick<
  Posting,
  | "key"
  | "company"
  | "last_seen"
  | "comp_low"
  | "comp_high"
  | "kept"
  | "reasons"
  | "evidence"
  | "judged_with"
> {
  readonly body?: string | null;
  readonly workplace?: Workplace | null;
}

// Small enough that a failed flush loses little.
const VERDICT_FLUSH = 200;

interface FlushResult {
  readonly written: number;
  readonly error: string | null;
}

// One upsert for the whole flush; the adapter groups the rows by shape. A
// failed upsert ends the flush with one error line, not a thrown run: rows
// not written keep their old `judged_with` and `needsJudging` picks them up
// next run.
async function writeVerdicts(store: Store, rows: readonly VerdictRow[]): Promise<FlushResult> {
  if (rows.length === 0) return { written: 0, error: null };
  try {
    await store.upsert("postings", rows);
    return { written: rows.length, error: null };
  } catch (err) {
    return { written: 0, error: `judging: writing ${rows.length} verdicts: ${describeError(err)}` };
  }
}

// Whether the judging pass should read this posting's body. The listing
// criteria are final once they say no, except on a two-phase board, where
// pay is body-only: a first-seen row has `comp_high: null` and the level
// criterion refuses a numbered title for want of a pay figure. So the
// listing is judged again with a figure at the floor: if that keeps it, a
// body stating pay can change the verdict and is worth fetching.
function wantsBody(
  posting: Pick<
    Posting,
    | "key"
    | "company"
    | "platform"
    | "board"
    | "title"
    | "location"
    | "comp_high"
    | "posted_at"
    | "last_seen"
  >,
  criteria: Criteria,
  now: string,
  reader: Reader | undefined,
  boards: BoardIndex,
  representative: ReadonlyMap<string, string>,
): boolean {
  if (judgeListing(posting, criteria, now, boards, representative).kept) return true;
  if (posting.comp_high !== null || reader?.body === undefined) return false;
  return judgeListing(
    { ...posting, comp_high: criteria.comp_floor },
    criteria,
    now,
    boards,
    representative,
  ).kept;
}

// Judges every posting in the store that `needsJudging`, not just this
// run's listings, so a criteria edit alone changes verdicts at the next
// run. A missing criteria row is an error only once there is something to
// judge.
export async function judgeAll(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  options?: JudgeOptions,
): Promise<JudgeResult> {
  const now = options?.now ?? (() => new Date().toISOString());
  const errors: string[] = [];
  const postings = await store.select<JudgingRow>("postings", undefined, JUDGING_COLUMNS);
  if (postings.length === 0) return { judged: 0, errors };

  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    errors.push(`judging: ${criteriaResult.reason}`);
    return { judged: 0, errors };
  }
  const criteria = criteriaResult.value;

  // Read and computed once, before the loop: the run's own writes would
  // otherwise change them mid-sweep.
  const companies = await store.select<Company>("companies", undefined, COMPANY_FIELDS);
  const boards = boardIndex(companies);
  const representative = representativeByKey(postings, criteria, boards);

  let judged = 0;
  let pending: VerdictRow[] = [];

  for (const row of postings) {
    // One clock reading per posting: two readings could pick a posting up
    // for aging out and then judge it as still within the max.
    const judgedAt = now();
    if (!needsJudging(row, criteria, judgedAt, boards, representative)) continue;

    const reader = readers[row.platform];

    // A posting the listing criteria dropped is judged without a body and
    // the text criteria never run on it.
    let body: string | null = null;
    // A two-phase board states its workplace on the detail, so a fetched
    // detail's word replaces the stored one the way its body does.
    let workplace = row.workplace;
    let fetched = false;
    // The detail a two-phase read returned this pass; null when no read
    // happened, or when the detail is gone.
    let detail: Listing | null = null;
    if (wantsBody(row, criteria, judgedAt, reader, boards, representative)) {
      body = await storedBody(store, row.key);
      if (body === null && row.board !== null && reader?.body !== undefined) {
        const board: Board = { platform: row.platform, id: row.board };
        try {
          detail = await reader.body(board, postingIdOf(row));
          body = detail?.body ?? null;
          workplace = detail?.workplace ?? null;
          fetched = true;
        } catch (err) {
          // `judged_with` stays as it was, so `needsJudging` tries again next run.
          errors.push(
            `${row.company} ${row.platform}/${board.id}: judge body fetch: ${describeError(err)}`,
          );
          continue;
        }
      }
    }

    // A two-phase board's comp is read here from the detail the judge
    // fetched; every other platform's came with its listing and is carried
    // back as read. A detail that states its pay wins over the prose, as
    // Ashby's structured pay does on a one-phase board. Overwritten only
    // when a detail was fetched this pass: writing null for a two-phase
    // posting the listing criteria dropped would make a posting refused on
    // the floor pass at the next criteria edit, be re-read, and be refused
    // again; and a re-judge from the stored body keeps the stored band,
    // since for Workable and Rippling that band came from the detail's
    // fields and the prose cannot restore it.
    const twoPhase = reader?.body !== undefined;
    // The stated figures are rounded as the listing path's are: the comp
    // columns are integers, and Rippling states its range as floats.
    const statedLow = wholeDollars(detail?.compLow ?? null);
    const statedHigh = wholeDollars(detail?.compHigh ?? null);
    const stated =
      statedLow !== null && statedHigh !== null
        ? { compLow: statedLow, compHigh: statedHigh }
        : null;
    // A detail that states its pay and carries no prose still states its
    // pay, so the detail, not the body, is the gate. A detail that is gone
    // (null) carries the stored band.
    const read = twoPhase && fetched && detail !== null;
    const comp = read ? (stated ?? (body !== null ? compInText(body) : null)) : null;
    const compLow = read ? (comp?.compLow ?? null) : row.comp_low;
    const compHigh = read ? (comp?.compHigh ?? null) : row.comp_high;

    const judgment = judge(
      { ...row, comp_high: compHigh, body, workplace },
      criteria,
      judgedAt,
      boards,
      representative,
    );
    const verdict: VerdictRow = {
      key: row.key,
      company: row.company,
      last_seen: row.last_seen,
      comp_low: compLow,
      comp_high: compHigh,
      kept: judgment.kept,
      reasons: judgment.reasons,
      evidence: judgment.evidence,
      judged_with: judgment.judged_with,
    };
    pending.push(fetched ? { ...verdict, body, workplace } : verdict);
    if (pending.length >= VERDICT_FLUSH) {
      const flushed = await writeVerdicts(store, pending);
      judged += flushed.written;
      if (flushed.error !== null) errors.push(flushed.error);
      pending = [];
    }
  }
  const flushed = await writeVerdicts(store, pending);
  judged += flushed.written;
  if (flushed.error !== null) errors.push(flushed.error);

  return { judged, errors };
}

interface ListedCompany {
  readonly listed: number;
  readonly recorded: number;
  readonly errors: readonly string[];
  readonly returned: readonly string[];
}

async function listCompany(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  company: Company,
  now: () => string,
  stored: ReadonlyMap<string, StoredListing>,
): Promise<ListedCompany> {
  const errors: string[] = [];
  const returned: string[] = [];
  const read: Board[] = [];
  let listed = 0;

  // Taken before any board is listed: every row recorded below gets its
  // `last_seen` from a later `now()`, so no row this run records can read
  // as unseen since the board's `last_read`.
  const readAt = now();

  // Postgres refuses an upsert batch naming one key twice, so the batch is
  // keyed like the store: the last listing for a key wins.
  const batch = new Map<string, ListedRow>();

  for (const board of boardsOf(company)) {
    const reader = readers[board.platform];
    if (reader === undefined) {
      errors.push(
        `${company.name} ${board.platform}/${board.id}: no reader for "${board.platform}"`,
      );
      continue;
    }

    const label = `${company.name} ${board.platform}/${board.id}`;
    let listings: readonly Listing[];
    try {
      listings = await reader.list(board);
    } catch (err) {
      errors.push(`${label}: ${describeError(err)}`);
      // The bookkeeping is a store write; a refusal is one more error line,
      // never a thrown run.
      try {
        if (isGone(board.platform, err) && (await boardGone(store, company, board)).returned) {
          returned.push(label);
        }
      } catch (writeErr) {
        errors.push(`${label}: recording gone board: ${describeError(writeErr)}`);
      }
      continue;
    }
    read.push(board);
    listed += listings.length;

    for (const listing of listings) {
      // A listing with no id would key as `platform/board::`, so every
      // id-less listing of a board would overwrite one row. Refused here,
      // where an id becomes an identity, as an error line so the run's error
      // count carries it.
      if (listing.id === "") {
        errors.push(
          `${company.name} ${board.platform}/${board.id}: listing with no id: ${listing.title ?? "(untitled)"}`,
        );
        continue;
      }
      const key = postingKey(board, listing.id);
      batch.set(key, toRow(company.name, board, listing, now(), stored.get(key)));
    }
  }

  // One upsert for the whole company; the adapter groups the rows by shape.
  // A refused upsert is one error line, not a thrown run: a throw would
  // reject the platforms' `Promise.all` while the other workers kept
  // listing unobserved.
  const rows = [...batch.values()];
  try {
    if (rows.length > 0) await store.upsert("postings", rows);
  } catch (err) {
    errors.push(`${company.name}: recording ${rows.length} postings: ${describeError(err)}`);
    return { listed, recorded: 0, errors, returned };
  }
  // Written only once the rows are in: a board marked read whose rows were
  // refused would have its postings judged gone against a read that never
  // landed.
  try {
    await recordBoardsRead(store, company, read, readAt);
  } catch (err) {
    errors.push(`${company.name}: recording board reads: ${describeError(err)}`);
  }
  return { listed, recorded: rows.length, errors, returned };
}

interface StoredListing {
  readonly body_hash: string | null;
  readonly comp_high: number | null;
  readonly workplace: Workplace | null;
}

// One select of small columns for the whole run.
async function storedListings(store: Store): Promise<Map<string, StoredListing>> {
  const rows = await store.select<Pick<Posting, "key" | "body_hash" | "comp_high" | "workplace">>(
    "postings",
    undefined,
    ["key", "body_hash", "comp_high", "workplace"],
  );
  return new Map(
    rows.map((row) => [
      row.key,
      { body_hash: row.body_hash, comp_high: row.comp_high, workplace: row.workplace },
    ]),
  );
}

// A company with boards on two platforms is walked whole by its first
// board's worker, so its batch and dedupe are unchanged.
function platformOf(company: Company): Platform {
  return boardsOf(company)[0].platform;
}

export async function ingest(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  options?: IngestOptions,
): Promise<IngestResult> {
  const now = options?.now ?? (() => new Date().toISOString());
  const companies = await watched(store);

  // A failed sweep read is one error line: an empty map means every body
  // gets written this run.
  const errors: string[] = [];
  let stored: Map<string, StoredListing>;
  try {
    stored = await storedListings(store);
  } catch (err) {
    errors.push(
      `reading stored body hashes: ${describeError(err)}; every body will be rewritten this run, and band and workplace changes go undetected`,
    );
    stored = new Map();
  }

  // One worker per platform, the platforms concurrently: no host is shared
  // between platforms, so `http.ts`'s per-host delay keeps its meaning and
  // hosts never wait on each other.
  const groups = new Map<Platform, Company[]>();
  for (const company of companies) {
    const platform = platformOf(company);
    const group = groups.get(platform);
    if (group === undefined) groups.set(platform, [company]);
    else group.push(company);
  }

  const walked = await Promise.all(
    [...groups.values()].map(async (group) => {
      const results: ListedCompany[] = [];
      for (const company of group) {
        results.push(await listCompany(store, readers, company, now, stored));
      }
      return results;
    }),
  );

  // Same input, same error lines in the same order every run.
  const results = walked.flat();
  return {
    companies: companies.length,
    listed: results.reduce((sum, result) => sum + result.listed, 0),
    recorded: results.reduce((sum, result) => sum + result.recorded, 0),
    errors: [...errors, ...results.flatMap((result) => result.errors)],
    returned: results.flatMap((result) => result.returned),
  };
}

/** A comp figure as the integer columns hold it, or null. See `toRow`. */
function wholeDollars(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value);
}
