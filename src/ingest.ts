// The daily job: list every readable company's boards, then judge every
// posting in the store. Both write `postings` only, never `companies`: a
// board that answers gone is returned to the caller. Every row shape below
// leans on `Store#upsert`'s contract for what an omitted column means; see
// `store.ts` and `toRow`.
import { createHash } from "node:crypto";

import { compInText, type Listing, type Reader } from "./ats/ats.ts";
import { READERS } from "./ats/readers.ts";
import { boardKey, boardsOf, isGone, readable } from "./companies.ts";
import { loadCriteria } from "./criteria.ts";
import { describeError } from "./errors.ts";
import { judge, needsJudging, representativeByKey } from "./judge/judge.ts";
import {
  type BoardIndex,
  boardIndex,
  judgeCountry,
  judgeExcludedWords,
  judgeLevel,
  judgeListing,
  judgeRole,
  NO_BOARDS,
} from "./judge/listing.ts";
import {
  COMPANY_FIELDS,
  postingKey,
  type Board,
  type Candidate,
  type Company,
  type Criteria,
  type Office,
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
  // Stored postings deleted this run: not kept, not acted on, and their
  // title and place fail (`prunable`), whether or not a read listed them.
  readonly pruned: number;
  readonly errors: readonly string[];
  // Every board that answered gone this run, with its company's name. The
  // list phase writes postings only; discovery removes these boards
  // (`unbind`, discover.ts).
  readonly gone: readonly GoneBoard[];
  // Counted per company board, the way `listCompany` reads them and its
  // errors are counted: a board two companies carry is read, and can fail,
  // twice. `boardsToday` is every company board `boardsToRead` picked;
  // `boardsWaiting` is every other one, left for Monday.
  readonly boardsToday: number;
  readonly boardsWaiting: number;
  // Every board was picked because the criteria row was edited after the
  // last read of every board (`criteriaEdited`). False when a failed read
  // picked every board instead.
  readonly criteriaEdited: boolean;
}

export interface GoneBoard {
  readonly company: string;
  readonly board: Board;
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
  // The local date the run started, for `boardsToRead`.
  readonly today: Date;
  readonly log?: (line: string) => void;
}

// The columns every written re-list carries. `first_seen` is not among
// them: the column default records the first insert. A re-list that would
// change nothing is not written at all; see `toRow`.
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
  | "locations"
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
  listing: Listing & { readonly locations: readonly Office[] },
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
    locations: listing.locations,
  };
  // `null` below means the upsert would rewrite the row with what it already
  // holds, so there is no write. `stored === undefined` (never recorded, or
  // the pre-run sweep's read failed) always counts as changed: there is
  // nothing to compare against, or the comparison cannot be trusted.
  // `platform` and `board` are not compared: `key` is built from them.
  // `locations` is already deterministically sorted and deduped
  // (`dedupeOffices`), so the same office set is always in the same order.
  // Comparison is still element-by-element, not `JSON.stringify`: Postgres
  // jsonb does not preserve object key order (it normalizes by key length
  // then alphabetically), so a `{name, url}` object read back from a real
  // row can come back as `{url, name}`, and a string comparison would never
  // match once a row has round-tripped through the store.
  const sameLocations =
    stored !== undefined &&
    stored.locations.length === fields.locations.length &&
    stored.locations.every(
      (office, index) =>
        office.name === fields.locations[index]?.name &&
        office.url === fields.locations[index]?.url,
    );
  const fieldsChanged =
    stored === undefined ||
    stored.company !== company ||
    stored.title !== listing.title ||
    stored.url !== listing.url ||
    stored.location !== listing.location ||
    stored.posted_at !== listing.postedAt ||
    !sameLocations;
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

// Each board's stored postings, keyed as the store keys them, under the
// `platform/board` prefix `postingKey` puts before its `::`.
type StoredByBoard<Row> = ReadonlyMap<string, ReadonlyMap<string, Row>>;
type TitleAndPlace = Pick<StoredListing, "title" | "location" | "comp_high">;

function storedPrefix(board: Board): string {
  return `${board.platform}/${board.id}`;
}

// The four listing criteria a title and a location decide, with the pay
// that settles a level: level, role, excluded words and country. Not
// `comp_floor`, age, gone, unwatched or duplicate. Run with the judge's own
// criterion functions, never against stored `reasons`: since #274 a posting
// past max age is rejected on age alone and its reasons never record whether
// its title and place would also have passed.
function passesTitleAndPlace(posting: TitleAndPlace, criteria: Criteria): boolean {
  const title = posting.title ?? "";
  return (
    judgeLevel(title, posting.comp_high, criteria).verdict === "in" &&
    judgeRole(title, criteria).verdict === "in" &&
    judgeExcludedWords(title, criteria).verdict === "in" &&
    judgeCountry(posting.location, criteria).verdict === "in"
  );
}

// Whether a posting is stored at all (#287): its title and place pass. A
// posting on a native two-phase platform with no pay is judged at the floor
// instead, as `wantsBody` does: such a board states pay only on the detail
// `judgeAll` fetches, and only for a stored posting, so without this a
// numbered or Senior title on it would never be stored, never fetched, and
// never found. The floor pass holds after the detail was read and stated no
// pay too, so such a row stays stored though its verdict is out: it is kept
// to be read, so its detail is not fetched again. Pruned, it would be stored
// again as new at the next read and its detail fetched again, every other
// read for as long as it stays listed.
function admits(posting: TitleAndPlace, platform: Platform, criteria: Criteria): boolean {
  if (passesTitleAndPlace(posting, criteria)) return true;
  return (
    nativeTwoPhase(platform) &&
    posting.comp_high === null &&
    passesTitleAndPlace({ ...posting, comp_high: criteria.comp_floor }, criteria)
  );
}

// Whether a platform's own reader lists postings with no body and fetches
// each detail: asked of `READERS`, never of the reader `ingest` is handed.
// `withDetailReads` wraps a whole platform for one board's detail read, so
// every Greenhouse board's reader has a `body`, though a Greenhouse listing
// states all the pay it ever will.
function nativeTwoPhase(platform: Platform): boolean {
  return READERS[platform].body !== undefined;
}

// A listing is judged on the pay `toRow` leaves on its row: the listing's own
// when it states a body or a band, else the stored band.
function listingAdmits(
  listing: Listing,
  stored: StoredListing | undefined,
  platform: Platform,
  criteria: Criteria,
): boolean {
  const statesPay = listing.body !== null || listing.compLow !== null || listing.compHigh !== null;
  const compHigh = statesPay ? wholeDollars(listing.compHigh) : (stored?.comp_high ?? null);
  const posting = { title: listing.title, location: listing.location, comp_high: compHigh };
  return admits(posting, platform, criteria);
}

// A stored posting nothing reads is deleted (#287; Design, Data: the store
// holds "every posting the title and place checks admit, and every one James
// acted on"): not kept, no status, and its title and place fail on what is
// stored. A key a read listed this run goes by that listing's verdict
// instead (`admitted`, `rejected`), since the stored title may be the one
// the listing replaces. A board need not be read for its postings to be
// pruned: a gone posting, one on a board waiting for Monday, and one of a
// dropped company are decided on their stored row alone.
function prunable(
  stored: ReadonlyMap<string, StoredListing>,
  admitted: ReadonlySet<string>,
  rejected: ReadonlySet<string>,
  criteria: Criteria,
): string[] {
  const keys: string[] = [];
  for (const [key, row] of stored) {
    if (row.kept === true || row.status !== null || admitted.has(key)) continue;
    if (rejected.has(key) || !admits(row, row.platform, criteria)) keys.push(key);
  }
  return keys;
}

// Milliseconds in a day, for `boundRecently`'s week window.
const DAY_MS = 86_400_000;

// Whether `company`'s boards count as newly bound (Design, Ingestion: "A
// board bound in the last week ... is read every weekday"): it has a
// `boundSince` entry less than 7 days before `today`. A company `boundSince`
// never heard of (no candidate outcome `watched` or `added`, ever) is not
// recent.
function boundRecently(
  company: string,
  boundSince: ReadonlyMap<string, string>,
  today: Date,
): boolean {
  const at = boundSince.get(company);
  if (at === undefined) return false;
  const days = Math.floor((today.getTime() - Date.parse(at)) / DAY_MS);
  return days < 7;
}

// Whether the criteria row was edited after the last read of every board:
// `full_read_at` (the `updated_at` that read was made for) is null or older
// than `updated_at`. Compared as instants, not strings: the memory store and
// Postgres need not spell one instant alike. No criteria row is never edited.
export function criteriaEdited(criteria: Criteria | undefined): boolean {
  if (criteria === undefined) return false;
  if (criteria.full_read_at === null) return true;
  return Date.parse(criteria.full_read_at) < Date.parse(criteria.updated_at);
}

// The board keys (`boardKey`) listed today. A board is read when: it is
// Monday (`today`'s local day); the criteria row was edited since the last
// read of every board (`criteriaEdited`), so an edit reaches every board at
// the next run rather than the next Monday; its company was bound (a candidate outcome
// `watched` or `added`) less than a week before `today`; or any of its
// stored postings, judged fresh, passes `passesTitleAndPlace` (a posting that
// later aged out still marks its board as one that hires for the role).
// Every other board waits for Monday. With #287 a board whose postings all
// fail never stores one, so "no stored posting" is not itself a reason to
// read: a board that has produced nothing since it was bound a week or more
// ago waits like any other non-producing board. With no criteria row nothing
// can pass, so a weekday reads only newly bound boards.
//
// Postings are found by their key's prefix, not their `board` column: a
// legacy key not in the `platform/board::id` form is counted on no board. A
// board holding only such keys is decided on bound-recently alone; a board
// that also holds current keys is decided by those too.
export function boardsToRead(
  companies: readonly Company[],
  storedByBoard: StoredByBoard<TitleAndPlace>,
  criteria: Criteria | undefined,
  today: Date,
  boundSince: ReadonlyMap<string, string>,
): Set<string> {
  const isMonday = today.getDay() === 1;
  const edited = criteriaEdited(criteria);
  const read = new Set<string>();
  for (const company of companies) {
    const recent = boundRecently(company.name, boundSince, today);
    for (const board of boardsOf(company)) {
      const postings = [...(storedByBoard.get(storedPrefix(board))?.values() ?? [])];
      const producing =
        criteria !== undefined &&
        postings.some((posting) => passesTitleAndPlace(posting, criteria));
      if (isMonday || edited || recent || producing) read.add(boardKey(board));
    }
  }
  return read;
}

interface ListedCompany {
  readonly listed: number;
  readonly recorded: number;
  // Every key this company's reads listed, by whether its title and place
  // pass; see `prunable`.
  readonly admitted: ReadonlySet<string>;
  readonly rejected: ReadonlySet<string>;
  readonly errors: readonly string[];
  readonly gone: readonly GoneBoard[];
}

// `null` sorts last; two `null`s (or two equal strings) keep their relative
// order from `dedupeOffices`'s stable sort.
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

// Distinct `(name, url)` pairs, sorted by name then url (nulls last), so the
// same office set always serializes the same way regardless of the read
// order the board answered in.
function dedupeOffices(offices: readonly Office[]): readonly Office[] {
  const seen = new Map<string, Office>();
  for (const office of offices) {
    const key = `${office.name ?? ""}\u0000${office.url ?? ""}`;
    if (!seen.has(key)) seen.set(key, office);
  }
  return [...seen.values()].sort(
    (a, b) => compareNullable(a.name, b.name) || compareNullable(a.url, b.url),
  );
}

// Collapses same-requisition, multi-office listings (Greenhouse today; every
// other reader leaves `requisitionId` null, so this is a no-op for them)
// into one entry per requisition. The primary listing — the one every other
// field comes from — is whichever group member's id already has a stored
// `postings` row (`storedIds`), so a row James has decided on stays the
// primary across re-lists even if the board later drops specifically that
// office; falling back to the lowest numeric id only when no member is on
// file yet (a brand new group, or a caller such as the backfill script that
// has no stored rows to prefer). Recomputing the lowest id from scratch on
// every run, with no such preference, would silently mint a fresh,
// undecided row and orphan the one James acted on. A `null` requisitionId
// is its own singleton group: keyed by the listing object itself, not its
// id, so two listings that happen to share an id (an empty id, or a genuine
// duplicate-id bug on the board) still pass through as separate entries —
// the existing per-listing loop's own id-refusal and last-wins dedup keep
// handling that, unchanged.
export function groupByRequisition(
  listings: readonly Listing[],
  storedIds: ReadonlySet<string> = new Set(),
): readonly (Listing & { readonly locations: readonly Office[] })[] {
  const groups = new Map<string | Listing, Listing[]>();
  for (const listing of listings) {
    // A bare `requisitionId` is free text a company's recruiters type in;
    // a placeholder value ("N/A", "TBD", "0") can be reused across
    // genuinely different roles on the same board. A legitimate
    // same-requisition, multi-office listing always carries the identical
    // title, so keying on the pair merges only the real case and never two
    // different roles that happen to share a requisition id.
    const key =
      listing.requisitionId === null ? listing : `${listing.requisitionId}\u0000${listing.title}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [listing]);
    else group.push(listing);
  }
  return [...groups.values()].map((group) => {
    const onFile = group.filter((listing) => storedIds.has(listing.id));
    // Strict `<` keeps the first-seen listing on a tie, as ties should not
    // occur (equal ids would already collide as the same stored row).
    let primary = onFile[0] ?? group[0]!;
    for (const listing of onFile.length > 0 ? onFile : group) {
      if (Number(listing.id) < Number(primary.id)) primary = listing;
    }
    const locations = dedupeOffices(
      group.map((listing) => ({ name: listing.location, url: listing.url })),
    );
    return { ...primary, locations };
  });
}

async function listCompany(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  company: Company,
  now: () => string,
  stored: ReadonlyMap<string, StoredListing>,
  storedByBoard: StoredByBoard<StoredListing>,
  criteria: Criteria | undefined,
  boardsForToday: ReadonlySet<string>,
): Promise<ListedCompany> {
  const errors: string[] = [];
  const gone: GoneBoard[] = [];
  let listed = 0;

  // Taken before any board is listed: the `gone_at` of every posting a
  // board's read here no longer lists.
  const readAt = now();

  // Postgres refuses an upsert batch naming one key twice, so the batch is
  // keyed like the store: the last listing for a key wins.
  const batch = new Map<string, ListedRow | GoneRow>();
  // Every key a read listed, by its title-and-place verdict (`prunable`).
  const admitted = new Set<string>();
  const rejected = new Set<string>();

  for (const board of boardsOf(company)) {
    // Waiting for Monday: not read, not marked gone, no error.
    if (!boardsForToday.has(boardKey(board))) continue;
    const reader = readers[board.platform];
    if (reader === undefined) {
      errors.push(
        `${company.name} ${board.platform}/${board.id}: no reader for "${board.platform}"`,
      );
      continue;
    }

    const label = `${company.name} ${board.platform}/${board.id}`;
    let rawListings: readonly Listing[];
    try {
      rawListings = await reader.list(board);
    } catch (err) {
      // The error line is the log of a gone answer too; the board itself is
      // handed back, not written.
      errors.push(`${label}: ${describeError(err)}`);
      if (isGone(board.platform, err)) gone.push({ company: company.name, board });
      continue;
    }
    // The ids this board already has a stored row for, so `groupByRequisition`
    // can keep the row James decided on as the primary even if the board
    // later drops specifically that office (see its own comment).
    const prefix = storedPrefix(board);
    const storedIds = new Set(
      [...(storedByBoard.get(prefix)?.keys() ?? [])].map((key) => key.slice(prefix.length + 2)),
    );
    const listings = groupByRequisition(rawListings, storedIds);
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
      const before = stored.get(key);
      // Only a posting whose title and place pass is stored (#287). One that
      // fails is not written when new; stored, it is not written unless it
      // is acted on or kept (those go on as before, and `judgeAll` re-judges
      // them), and `ingest`'s prune deletes it. A key the same read lists
      // twice goes by its last listing, as the batch does.
      if (criteria !== undefined && !listingAdmits(listing, before, board.platform, criteria)) {
        rejected.add(key);
        admitted.delete(key);
        batch.delete(key);
        if (before === undefined) continue;
        if (before.kept !== true && before.status === null) continue;
      } else {
        admitted.add(key);
        rejected.delete(key);
      }
      const row = toRow(company.name, board, listing, now(), before, criteria);
      if (row !== null) batch.set(key, row);
    }

    // Only here, after a read that answered: a failed read says nothing
    // about which postings are still up. Goes in the same upsert as the
    // listed rows. A posting already marked keeps its first mark and gets
    // no write. A key `ingest` prunes this run may be marked here first: the
    // prune runs once every company's upsert has landed, so no mark can
    // follow a delete and recreate the key as a stub.
    for (const [key, before] of storedByBoard.get(storedPrefix(board)) ?? []) {
      if (seenKeys.has(key) || before.gone_at !== null) continue;
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
  let recorded = rows.length;
  try {
    if (rows.length > 0) await store.upsert("postings", rows);
  } catch (err) {
    errors.push(`${company.name}: recording ${rows.length} postings: ${describeError(err)}`);
    recorded = 0;
  }
  return { listed, recorded, admitted, rejected, errors, gone };
}

// Every column a re-list can write, bar `body`: `body_hash` stands for it.
interface StoredListing {
  readonly company: string;
  // Whether `prunable` gives the posting the floor pass (`nativeTwoPhase`).
  readonly platform: Platform;
  readonly title: string | null;
  readonly url: string | null;
  readonly location: string | null;
  readonly posted_at: string | null;
  readonly locations: readonly Office[];
  readonly body_hash: string | null;
  readonly comp_low: number | null;
  readonly comp_high: number | null;
  readonly workplace: Workplace | null;
  // `kept` and `status` spare a posting from pruning; see `prunable`.
  readonly kept: boolean | null;
  readonly status: Status | null;
  readonly gone_at: string | null;
}

const STORED_LISTING_COLUMNS = [
  "company",
  "platform",
  "title",
  "url",
  "location",
  "posted_at",
  "locations",
  "body_hash",
  "comp_low",
  "comp_high",
  "workplace",
  "kept",
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
        platform: row.platform,
        title: row.title,
        url: row.url,
        location: row.location,
        posted_at: row.posted_at,
        locations: row.locations,
        body_hash: row.body_hash,
        comp_low: row.comp_low,
        comp_high: row.comp_high,
        workplace: row.workplace,
        kept: row.kept,
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

// Every company's latest `outcome_at` among candidates bound `watched` or
// `added` (`boardsToRead`'s "bound in the last week"). A candidate with no
// `company` or no `outcome_at` names nothing to bind; an outcome other than
// `watched` or `added` (a duplicate, a dropped one, ...) does not bind
// either. `outcome_at` sorts lexically like every other timestamp column
// here.
async function boundSince(store: Store): Promise<Map<string, string>> {
  const rows = await store.select<Pick<Candidate, "company" | "outcome" | "outcome_at">>(
    "candidates",
    undefined,
    ["company", "outcome", "outcome_at"],
  );
  const bound = new Map<string, string>();
  for (const row of rows) {
    if (row.company === null || row.outcome_at === null) continue;
    if (row.outcome !== "watched" && row.outcome !== "added") continue;
    const latest = bound.get(row.company);
    if (latest === undefined || row.outcome_at > latest) bound.set(row.company, row.outcome_at);
  }
  return bound;
}

export async function ingest(
  store: Store,
  readers: Partial<Record<Platform, Reader>>,
  options: IngestOptions,
): Promise<IngestResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? console.log;
  const companies = await readable(store);

  // A failed sweep read is one error line: an empty map means every body
  // gets rewritten this run and no posting is marked gone. `readFailed`
  // below forces every board to be read, since an empty map can no longer be
  // told apart from a board with genuinely nothing stored.
  const errors: string[] = [];
  let stored: Map<string, StoredListing>;
  let readFailed = false;
  try {
    stored = await storedListings(store);
  } catch (err) {
    errors.push(
      `reading stored body hashes: ${describeError(err)}; every body will be rewritten this run, band and workplace changes go undetected, no posting is marked gone or pruned, and every board is read`,
    );
    stored = new Map();
    readFailed = true;
  }

  // Each board's stored postings, by the `platform/board` prefix `postingKey`
  // puts before its `::`, so a read can tell which of its postings it no
  // longer lists and `boardsToRead` which boards have produced. A key with no
  // `::` (the old company-name form has one, but nothing guarantees it)
  // belongs to no board.
  const storedByBoard = new Map<string, Map<string, StoredListing>>();
  for (const [key, listing] of stored) {
    const cut = key.indexOf("::");
    if (cut === -1) continue;
    const prefix = key.slice(0, cut);
    const group = storedByBoard.get(prefix);
    if (group === undefined) storedByBoard.set(prefix, new Map([[key, listing]]));
    else group.set(key, listing);
  }

  // Decides which listings are stored and which bodies they keep; see
  // `listCompany` and `toRow`. No criteria row stores every listing and every
  // body and prunes nothing, as one log line, not an error: an error line
  // here would count toward `daily.ts`'s every-board-failed check.
  const criteriaResult = await loadCriteria(store);
  const criteria = criteriaResult.ok ? criteriaResult.value : undefined;
  if (!criteriaResult.ok) {
    log("ingest: no criteria row; every listing is stored and none is pruned");
  }

  // `boardsToRead`'s other input: a company bound (a candidate outcome
  // `watched` or `added`) inside the last week is read daily even with
  // nothing stored yet. A failed read is one error line and, like a failed
  // stored-postings read, forces every board to be read: there is no way to
  // tell a company truly never bound from one `boundSince` could not read.
  let bound: ReadonlyMap<string, string>;
  try {
    bound = await boundSince(store);
  } catch (err) {
    errors.push(`reading candidates: ${describeError(err)}; every board is read`);
    bound = new Map();
    readFailed = true;
  }

  // Only a read `boardsToRead` chose counts toward `full_read_at`: a failed
  // read above also reads every board, but for its own reason.
  const edited = !readFailed && criteriaEdited(criteria);
  const companyBoards = companies.flatMap(boardsOf);
  const boardsForToday = readFailed
    ? new Set(companyBoards.map(boardKey))
    : boardsToRead(companies, storedByBoard, criteria, options.today, bound);
  const boardsToday = companyBoards.filter((board) => boardsForToday.has(boardKey(board))).length;
  const boardsWaiting = companyBoards.length - boardsToday;

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
          await listCompany(
            store,
            readers,
            company,
            now,
            stored,
            storedByBoard,
            criteria,
            boardsForToday,
          ),
        );
      }
      return results;
    }),
  );

  // Same input, same error lines in the same order every run.
  const results = walked.flat();

  // One prune per run, once every company's upsert has landed (`prunable`).
  // A key one read admitted and another rejected (two companies carrying one
  // board, its listing changed between their reads) was written by the one
  // that admitted it, so it stays. With no criteria row nothing is judged,
  // and with a failed stored read `stored` is empty: either way nothing is
  // deleted.
  const admitted = new Set(results.flatMap((result) => [...result.admitted]));
  const rejected = new Set(results.flatMap((result) => [...result.rejected]));
  const keys = criteria === undefined ? [] : prunable(stored, admitted, rejected, criteria);
  let pruned = keys.length;
  const pruneErrors: string[] = [];
  try {
    if (keys.length > 0) await store.delete("postings", keys);
  } catch (err) {
    pruneErrors.push(`pruning ${keys.length} postings: ${describeError(err)}`);
    pruned = 0;
  }

  // Every board has been read for this criteria row, so the next run need
  // not repeat it until the next edit. Written once every read has landed,
  // so a run that dies part way reads every board again. A few failed boards
  // do not hold the marker back: a run over thousands of external boards
  // almost always has some, and holding it would read every board every day.
  // Only a run where practically every board failed (`everyBoardFailed`, the
  // same test `daily.ts` exits non-zero on) leaves it unwritten, so the next
  // run reads every board again. A failed write is a log line, not an error:
  // `daily.ts`'s every-board-failed check counts errors against boards, and
  // this is not a board. The next run then reads every board again, which
  // costs a Monday-sized run and nothing else.
  const allErrors = [...errors, ...results.flatMap((result) => result.errors), ...pruneErrors];
  if (edited && everyBoardFailed(boardsToday, allErrors.length)) {
    log(
      `ingest: every board picked for the criteria edit, but every board failed (${allErrors.length} errors, ${boardsToday} boards); full_read_at not written, the next run reads every board again`,
    );
  } else if (edited && criteria !== undefined) {
    const marked = await store
      .update("criteria", "1", { full_read_at: criteria.updated_at })
      .catch((err: unknown) => ({ ok: false as const, reason: describeError(err) }));
    if (!marked.ok) {
      log(
        `ingest: every board read for the criteria edit, but full_read_at not written: ${marked.reason}`,
      );
    }
  }

  return {
    companies: companies.length,
    listed: results.reduce((sum, result) => sum + result.listed, 0),
    recorded: results.reduce((sum, result) => sum + result.recorded, 0),
    pruned,
    errors: allErrors,
    gone: results.flatMap((result) => result.gone),
    boardsToday,
    boardsWaiting,
    criteriaEdited: edited,
  };
}

// Practically every board picked today failed: errors and boards are both
// counted per company board, so errors at or past the board count means no
// board can be assumed read. Shared by the `full_read_at` gate here and
// `daily.ts`'s `listExitCode`, so the two agree on what "every board failed"
// means.
export function everyBoardFailed(boardsToday: number, errorCount: number): boolean {
  return boardsToday > 0 && errorCount >= boardsToday;
}

/** A comp figure as the integer columns hold it, or null. See `toRow`. */
function wholeDollars(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value);
}
