// The daily job: list every watched company's boards, then judge every
// posting in the store. Every row shape below leans on `Store#upsert`'s
// contract for what an omitted column means; see `store.ts` and `toRow`.
import { createHash } from "node:crypto";

import { compInText, type Listing, type Reader } from "./ats/ats.ts";
import { boardGone, boardsOf, isGone, recordBoardsRead, watched } from "./companies.ts";
import { loadCriteria } from "./criteria.ts";
import { describeError } from "./errors.ts";
import { judge, needsJudging, representativeByKey } from "./judge/judge.ts";
import { type BoardIndex, boardIndex, judgeListing, NO_BOARDS } from "./judge/listing.ts";
import {
  COMPANY_FIELDS,
  postingKey,
  type Board,
  type Company,
  type Criteria,
  type Platform,
  type Posting,
  type Status,
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
  readonly log?: (line: string) => void;
  // Wall-clock milliseconds, for throttling the progress line below;
  // distinct from `now`, which stamps a judgment. Defaults to `Date.now`.
  readonly clock?: () => number;
}

// How often the sweep below logs how far it has gotten. A full sweep (every
// stored posting stale at once, e.g. after a criteria edit) can run long
// with no other output in between, which reads the same as a hang. This
// progress line is the difference between the two.
const PROGRESS_INTERVAL_MS = 30_000;

export interface IngestOptions {
  readonly now?: () => string;
}

// The columns every written re-list carries. `first_seen` is not among
// them: the column default records the first insert. A re-list that would
// change nothing is not written at all; see `toRow`.
type ListedFields = Pick<
  Posting,
  "key" | "company" | "platform" | "board" | "title" | "url" | "location" | "posted_at"
>;

// The rest of what a re-list can write; `toRow` leaves each out where there
// is nothing new to say, so the upsert keeps the stored value.
interface ListedRow extends ListedFields {
  readonly workplace?: Workplace | null;
  readonly comp_low?: number | null;
  readonly comp_high?: number | null;
  // `undefined` leaves the stored text alone; `null` clears it.
  readonly body?: string | null;
  readonly body_hash?: string | null;
  readonly judged_with?: null;
  // Written only on a posting stored as gone that this read lists again.
  readonly gone_at?: null;
}

// A stored posting its board's successful read no longer lists: marked gone
// once, at that read, and re-judged. `company` is carried for the column's
// NOT NULL (see `VerdictRow`).
interface GoneRow {
  readonly key: string;
  readonly company: string;
  readonly gone_at: string;
  readonly judged_with: null;
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
  criteria: Criteria | undefined,
): ListedRow | null {
  const fields: ListedFields = {
    key: postingKey(board, listing.id),
    company,
    platform: board.platform,
    board: board.id,
    title: listing.title,
    url: listing.url,
    location: listing.location,
    posted_at: listing.postedAt,
  };
  // `null` below means the upsert would rewrite the row with what it already
  // holds, so there is no write. `stored === undefined` (never recorded, or
  // the pre-run sweep's read failed) always counts as changed: there is
  // nothing to compare against, or the comparison cannot be trusted.
  // `platform` and `board` are not compared: `key` is built from them.
  const fieldsChanged =
    stored === undefined ||
    stored.company !== company ||
    stored.title !== listing.title ||
    stored.url !== listing.url ||
    stored.location !== listing.location ||
    stored.posted_at !== listing.postedAt;
  const statesWorkplace = listing.body !== null || listing.workplace !== null;
  // A posting on record as gone that this read lists again: back, and its
  // last verdict (reached on its absence) is judged again.
  const returning = (stored?.gone_at ?? null) !== null;
  const listed: ListedRow = returning ? { ...fields, gone_at: null } : fields;
  const bare: ListedRow = statesWorkplace ? { ...listed, workplace: listing.workplace } : listed;
  // Withdrawn (stored set, listed null) counts as changed: the text path
  // takes over. `stored === undefined` (never recorded, or the pre-run
  // sweep's read failed) makes no claim either way, and nor does a listing
  // that leaves the column out.
  const workplaceChanged =
    statesWorkplace && stored !== undefined && stored.workplace !== listing.workplace;
  const verdictStale = workplaceChanged || returning;
  // Nothing to read a comp from: the comp columns stay out of the payload
  // and the store keeps what the judging pass wrote.
  if (listing.body === null && listing.compLow === null && listing.compHigh === null) {
    if (verdictStale) return { ...bare, judged_with: null };
    // `bare` is the listed fields, plus `workplace` only where the listing
    // states one; a changed workplace or a return is `verdictStale`, taken
    // above. So with the listed fields unchanged it repeats the stored row.
    return fieldsChanged ? bare : null;
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
    verdictStale || (stored !== undefined && stored.comp_high !== row.comp_high);
  // Every column `row` carries, against what is stored: the listed fields,
  // `workplace` and `comp_high` (both in `verdictInputChanged`), and
  // `comp_low`, which feeds no verdict but is still a write.
  const rowChanged = fieldsChanged || verdictInputChanged || stored.comp_low !== row.comp_low;
  if (listing.body === null) {
    if (verdictInputChanged) return { ...row, judged_with: null };
    return rowChanged ? row : null;
  }
  // A body is stored unless nothing can ever read it. Readers: a posting
  // acted on; one whose board states `remote` or `onsite`, which
  // `scripts/score-remote.ts` scores the text detector against whatever the
  // verdict; and one the listing criteria keep, since `judgeAll` reads the
  // body back to run the text criteria on exactly those. The decision is
  // `judgeListing`, never the full `judge()`: `judgeAll`'s `wantsBody` asks
  // for a body on the listing criteria alone, and a one-phase board has no
  // detail to refetch it from, so a body dropped here on a text criterion
  // would be judged back in as empty text. A text rejection keeps its body
  // for good: `judgeAll` never clears a one-phase body either.
  // `NO_BOARDS` and an empty representative map leave gone, unwatched and
  // duplicate "in"; real context can only drop more, so an "out" here is one
  // `wantsBody` also reaches. Decided before the unchanged-hash check, so a
  // criteria edit that newly drops a posting clears the body it already has.
  // No criteria row (a fresh install) stores every body, as before.
  const acted = (stored?.status ?? null) !== null;
  const workplaceScored = bare.workplace === "remote" || bare.workplace === "onsite";
  const keep =
    acted ||
    workplaceScored ||
    criteria === undefined ||
    judgeListing(
      // A listing just read this run: not gone by definition.
      { ...fields, comp_high: row.comp_high ?? null, gone_at: null },
      criteria,
      timestamp,
      NO_BOARDS,
      new Map(),
    ).kept;
  if (!keep) {
    // A stored body being cleared is a write whatever else holds; with none
    // stored, `cleared` is `row` and no write is needed unless it changed.
    const clearsBody = (stored?.body_hash ?? null) !== null;
    const cleared: ListedRow = clearsBody ? { ...row, body: null, body_hash: null } : row;
    if (verdictInputChanged) return { ...cleared, judged_with: null };
    return clearsBody || rowChanged ? cleared : null;
  }
  const hash = bodyHash(listing.body);
  // An unchanged body is left out of the payload, so the row goes as a small
  // listing-fields update instead of the text the store already has.
  // With `row` unchanged too, the upsert would rewrite the row as it is.
  if (hash === (stored?.body_hash ?? null)) {
    if (verdictInputChanged) return { ...row, judged_with: null };
    return rowChanged ? row : null;
  }
  // From here the body differs from the stored hash: always a write.
  const withBody: ListedRow = { ...row, body: listing.body, body_hash: hash };
  // A body landing where none was stored: the last verdict was reached
  // without its text, so it is judged again with it.
  const bodyIsNew = (stored?.body_hash ?? null) === null;
  return verdictInputChanged || bodyIsNew ? { ...withBody, judged_with: null } : withBody;
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
  // Read by the gone criterion.
  "gone_at",
  // Every row in the sweep can be a key's representative.
  "first_seen",
  "judged_with",
  // `needsJudging` reads it: the age verdict moves with time only for a
  // kept posting.
  "kept",
  "reasons",
  // Read by `judge()` to decide age alone for a posting not acted on.
  "status",
] as const satisfies readonly (keyof Posting)[];

type JudgingRow = Pick<Posting, (typeof JUDGING_COLUMNS)[number]>;

async function storedBody(store: Store, key: string): Promise<string | null> {
  const rows = await store.select<Pick<Posting, "body">>("postings", { key }, ["body"]);
  return rows[0]?.body ?? null;
}

// Postgres builds the INSERT tuple before it finds the conflict, so every
// NOT NULL column without a default (`company`) has to be in the payload
// even though the row exists; it is carried back as read.
// `comp_low`/`comp_high` travel the same way: listing and judging are
// sequential in `daily.ts`, so nothing changes a comp between the read and
// the write. `body` and `workplace` stay out unless the judging pass
// fetched a detail, so the stored values, if any, survive.
interface VerdictRow extends Pick<
  Posting,
  "key" | "company" | "comp_low" | "comp_high" | "kept" | "reasons" | "evidence" | "judged_with"
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
    | "gone_at"
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
  const log = options?.log ?? console.log;
  const clock = options?.clock ?? Date.now;
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
  const representative = representativeByKey(postings, criteria);

  let judged = 0;
  let pending: VerdictRow[] = [];
  let lastProgressAt = clock();
  let scanned = 0;

  for (const row of postings) {
    scanned += 1;
    const sinceProgress = clock();
    if (sinceProgress - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      log(`judge: ${scanned}/${postings.length} scanned, ${judged} judged so far`);
      lastProgressAt = sinceProgress;
    }
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
      comp_low: compLow,
      comp_high: compHigh,
      kept: judgment.kept,
      reasons: judgment.reasons,
      evidence: judgment.evidence,
      judged_with: judgment.judged_with,
    };
    // A fetched detail's workplace is cheap structured data and multiple
    // criteria read it directly, so it is kept whenever fetched regardless
    // of verdict. The body is kept only where something reads it: a
    // posting kept, acted on (`row.status`, read before this pass's write,
    // so a posting acted on this same run still counts), or stating
    // `remote` or `onsite` (`scripts/score-remote.ts`). Decided only on a
    // body fetched this pass, from the same detail the verdict just read.
    // A body read back from the store is never cleared here: nothing
    // guarantees it can be read again. A one-phase board's body returns
    // only with a fresh listing, and a re-judge can run without one (the
    // board's read failed that day, or a criteria edit alone). A reader
    // having `body` does not mean this board has a detail read either:
    // `withDetailRead` wraps a whole platform for one board's read and
    // answers null for the rest. Either way `wantsBody` would ask for the
    // body again, find none, and judge the empty text back in. A stored
    // body is cleared only by `toRow`, on a listing "out" `wantsBody` agrees
    // with; a stored body out only on its text is kept, stale in size, not
    // in content.
    const workplaceScored = workplace === "remote" || workplace === "onsite";
    const keepBody = judgment.kept || row.status !== null || workplaceScored;
    pending.push(fetched ? { ...verdict, body: keepBody ? body : null, workplace } : verdict);
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
  storedByBoard: ReadonlyMap<string, ReadonlySet<string>>,
  criteria: Criteria | undefined,
): Promise<ListedCompany> {
  const errors: string[] = [];
  const returned: string[] = [];
  const read: Board[] = [];
  let listed = 0;

  // Taken before any board is listed: the `gone_at` of every posting a
  // board's read here no longer lists.
  const readAt = now();

  // Postgres refuses an upsert batch naming one key twice, so the batch is
  // keyed like the store: the last listing for a key wins.
  const batch = new Map<string, ListedRow | GoneRow>();

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

    const seenKeys = new Set<string>();
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
      // Seen whether or not it needs a write, so the sweep below never marks
      // an unchanged posting gone.
      seenKeys.add(key);
      const row = toRow(company.name, board, listing, now(), stored.get(key), criteria);
      if (row !== null) batch.set(key, row);
    }

    // Only here, after a read that answered: a failed read says nothing
    // about which postings are still up. Goes in the same upsert as the
    // listed rows, so `recordBoardsRead` below never records a read whose
    // gone marks were refused. A posting already marked keeps its first
    // mark and gets no write.
    const prefix = `${board.platform}/${board.id}`;
    for (const key of storedByBoard.get(prefix) ?? []) {
      const before = stored.get(key);
      if (seenKeys.has(key) || before === undefined || before.gone_at !== null) continue;
      batch.set(key, {
        key,
        company: company.name,
        gone_at: readAt,
        judged_with: null,
      });
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

// Every column a re-list can write, bar `body`: `body_hash` stands for it.
interface StoredListing {
  readonly company: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly location: string | null;
  readonly posted_at: string | null;
  readonly body_hash: string | null;
  readonly comp_low: number | null;
  readonly comp_high: number | null;
  readonly workplace: Workplace | null;
  readonly status: Status | null;
  readonly gone_at: string | null;
}

const STORED_LISTING_COLUMNS = [
  "company",
  "title",
  "url",
  "location",
  "posted_at",
  "body_hash",
  "comp_low",
  "comp_high",
  "workplace",
  "status",
  "gone_at",
] as const satisfies readonly (keyof StoredListing)[];
type StoredListingColumn = (typeof STORED_LISTING_COLUMNS)[number];

// One select of small columns for the whole run.
async function storedListings(store: Store): Promise<Map<string, StoredListing>> {
  const rows = await store.select<Pick<Posting, "key" | StoredListingColumn>>(
    "postings",
    undefined,
    ["key", ...STORED_LISTING_COLUMNS],
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        company: row.company,
        title: row.title,
        url: row.url,
        location: row.location,
        posted_at: row.posted_at,
        body_hash: row.body_hash,
        comp_low: row.comp_low,
        comp_high: row.comp_high,
        workplace: row.workplace,
        status: row.status,
        gone_at: row.gone_at,
      },
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
      `reading stored body hashes: ${describeError(err)}; every body will be rewritten this run, band and workplace changes go undetected, and no posting is marked gone`,
    );
    stored = new Map();
  }

  // Each board's stored keys, by the `platform/board` prefix `postingKey`
  // puts before its `::`, so a read can tell which of its postings it no
  // longer lists. A key with no `::` (the old company-name form has one, but
  // nothing guarantees it) belongs to no board.
  const storedByBoard = new Map<string, Set<string>>();
  for (const key of stored.keys()) {
    const cut = key.indexOf("::");
    if (cut === -1) continue;
    const prefix = key.slice(0, cut);
    const group = storedByBoard.get(prefix);
    if (group === undefined) storedByBoard.set(prefix, new Set([key]));
    else group.add(key);
  }

  // Judges each listed body before it is stored; see `toRow`.
  // No criteria row stores every body, silently: an error line here would
  // count toward `daily.ts`'s every-board-failed check.
  const criteriaResult = await loadCriteria(store);
  const criteria = criteriaResult.ok ? criteriaResult.value : undefined;

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
        results.push(
          await listCompany(store, readers, company, now, stored, storedByBoard, criteria),
        );
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
