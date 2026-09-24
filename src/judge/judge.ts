// The one judgment a posting gets, and the rule for when it needs another.
// The text criteria only run on what the listing criteria kept; `ingest.ts`
// uses the same ordering to decide whether a body is worth fetching.
import type { Criteria, Posting } from "../schema.ts";
import {
  admitsLevel,
  ageInDays,
  type BoardIndex,
  duplicateKey,
  goneBy,
  judgeListing,
  listedBy,
  NO_BOARDS,
  type Reason,
  unwatchedBy,
} from "./listing.ts";
import { judgeText } from "./text.ts";

export interface Judgment {
  readonly kept: boolean;
  readonly reasons: readonly Reason[];
  // Keyed by criterion: the same string each reason carries in `detail`,
  // indexed.
  readonly evidence: Readonly<Record<string, string>>;
  readonly judged_with: string;
}

function evidenceOf(reasons: readonly Reason[]): Record<string, string> {
  const evidence: Record<string, string> = {};
  for (const reason of reasons) {
    evidence[reason.criterion] = reason.detail;
  }
  return evidence;
}

// The columns a verdict is reached from, not a whole `Posting`: `ingest`'s
// judging pass has a body in hand only for the few about to be judged on
// text. `boards` defaults to no board read on record; `judgeAll`
// (ingest.ts) passes the index it built from `companies`.
export function judge(
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
    | "body"
    | "last_seen"
    | "workplace"
  >,
  criteria: Criteria,
  now: string = new Date().toISOString(),
  boards: BoardIndex = NO_BOARDS,
  representativeByKey: ReadonlyMap<string, string> = new Map(),
): Judgment {
  const listing = judgeListing(posting, criteria, now, boards, representativeByKey);
  // The listing criteria are final once they say no: no text criterion
  // runs, and a body already on the row plays no part.
  const reasons = listing.kept
    ? [...listing.reasons, ...judgeText(posting, criteria).reasons]
    : [...listing.reasons];
  return {
    kept: reasons.every((reason) => reason.verdict === "in"),
    reasons,
    evidence: evidenceOf(reasons),
    judged_with: criteria.updated_at,
  };
}

// True when a posting has never been judged, or was judged against an older
// criteria row (`judged_with`/`updated_at` are ISO strings, so a string
// comparison is chronological). Also true when a criterion's verdict has
// moved on its own, since only a row whose verdict actually moves is
// re-judged:
//
// - age: a kept posting has passed the max age.
// - gone: a kept posting's board has been read since it was last seen; and
//   the reverse, a gone-dropped posting a board lists again, qualified by
//   its stored reasons so a fresh `last_seen` alone never re-judges the
//   whole dropped set. The reverse needs a read on record that listed the
//   row (`listedBy`), or the board gone from watch (`unwatchedBy`, so the
//   row is judged once more and reads unwatched) — not merely the absence
//   of a read: a watched board whose read failed says nothing.
// - duplicate: a kept posting that is no longer its group's representative,
//   or a duplicate-out posting that now is.
// - unwatched: a kept posting whose company or board is no longer watched;
//   and the reverse, an unwatched-out posting whose board is watched again
//   (James put the company back), qualified by its stored reasons the same
//   way gone is.
//
// `NO_BOARDS` and an empty `representativeByKey` never find a posting out
// of place.
export function needsJudging(
  posting: Pick<
    Posting,
    | "key"
    | "company"
    | "platform"
    | "board"
    | "title"
    | "location"
    | "comp_high"
    | "judged_with"
    | "kept"
    | "posted_at"
    | "last_seen"
    | "reasons"
  >,
  criteria: Criteria,
  now: string = new Date().toISOString(),
  boards: BoardIndex = NO_BOARDS,
  representativeByKey: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (posting.judged_with === null || posting.judged_with < criteria.updated_at) return true;
  if (
    criteria.max_age_days !== null &&
    posting.kept === true &&
    posting.posted_at !== null &&
    ageInDays(posting.posted_at, now) > criteria.max_age_days
  ) {
    return true;
  }
  const representativeKey = representativeByKey.get(duplicateKey(posting, criteria));
  if (
    posting.kept === true &&
    representativeKey !== undefined &&
    representativeKey !== posting.key
  ) {
    return true;
  }
  if (
    posting.kept === false &&
    hasReasonOut(posting.reasons, "duplicate") &&
    representativeKey === posting.key
  ) {
    return true;
  }
  if (posting.kept === true && goneBy(posting, boards)) return true;
  if (
    posting.kept === false &&
    hasReasonOut(posting.reasons, "gone") &&
    (listedBy(posting, boards) || unwatchedBy(posting, boards))
  ) {
    return true;
  }
  if (posting.kept === true && unwatchedBy(posting, boards)) return true;
  return (
    posting.kept === false &&
    hasReasonOut(posting.reasons, "unwatched") &&
    !unwatchedBy(posting, boards)
  );
}

// `reasons` is jsonb and arrives as `unknown[]`, so it is checked here, at
// the one point that reads it back. The memory store reads the column as
// null until a verdict writes it, hence the array check first.
function hasReasonOut(reasons: unknown, criterion: string): boolean {
  if (!Array.isArray(reasons)) return false;
  return reasons.some(
    (reason: unknown) =>
      typeof reason === "object" &&
      reason !== null &&
      "criterion" in reason &&
      reason.criterion === criterion &&
      "verdict" in reason &&
      reason.verdict === "out",
  );
}

// The Duplicate criterion's representative at every key: "the latest seen
// that the level criterion admits", computed once per run so every row in
// the sweep shares one answer. Two filters before a row can compete:
//
// - A row gone by `goneBy` is skipped, or a group's duplicates would stay
//   out forever naming a row nothing will bring back. `NO_BOARDS` skips
//   nothing.
// - A row the level criterion would not admit is skipped: the req is judged
//   as the posting James would actually see, not a pay-less "Software
//   Engineer II" that merely posted later.
//
// A tie on `first_seen` (one upsert batch) is broken by the larger key, so
// the same input always names the same winner. A key with no row clearing
// both filters gets no entry: every member reads "in" on duplicate and the
// level criterion drops each on its own.
export function representativeByKey(
  rows: readonly Pick<
    Posting,
    | "key"
    | "platform"
    | "board"
    | "posted_at"
    | "comp_high"
    | "location"
    | "title"
    | "first_seen"
    | "last_seen"
  >[],
  criteria: Criteria,
  boards: BoardIndex = NO_BOARDS,
): Map<string, string> {
  const latest = new Map<string, Pick<Posting, "key" | "first_seen">>();
  for (const row of rows) {
    if (goneBy(row, boards)) continue;
    if (!admitsLevel(row, criteria)) continue;
    const key = duplicateKey(row, criteria);
    const current = latest.get(key);
    if (
      current === undefined ||
      row.first_seen > current.first_seen ||
      (row.first_seen === current.first_seen && row.key > current.key)
    ) {
      latest.set(key, row);
    }
  }
  return new Map([...latest].map(([key, row]) => [key, row.key]));
}
