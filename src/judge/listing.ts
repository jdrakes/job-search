// The criteria judged off a posting's title, location label and comp band.
// `judge.ts` runs these first and fetches a body, for the text criteria,
// only on what these keep. Every criterion returns a `Reason` whichever way
// it falls: the reasons are what a run stores and what James reads.
import { boardKey } from "../companies.ts";
import type { Company, Criteria, Posting } from "../schema.ts";
import { foreignPlace, unitedStatesPlace } from "./countries.ts";
import { findWholeWord, wholeWordPattern } from "./whole-word.ts";

export interface Reason {
  readonly criterion: string;
  readonly verdict: "in" | "out";
  readonly detail: string;
}

// II-IX only: nothing above IX appears in practice.
const ROMAN_LEVELS = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX"] as const;

// "Senior" (or "Sr." or "Sr") is a pay-settled marker, not a level word:
// a title with one is out unless comp_high names a pay band.
const SENIOR_MARKERS = ["Senior", "Sr.", "Sr"] as const;

// A title naming engineering work but no level is settled by pay, same as
// the numbered and Senior markers. `judgeLevel` matches these against the
// role part only (`roleEnd`): "RVP, SOLUTION ENGINEERING, FINANCIAL
// SERVICES" names a team, not the work. `judgeRole` matches the wider list
// below against the whole title.
const ENGINEERING_WORDS = ["engineer", "engineering", "developer", "swe", "programmer"] as const;

// What the role rule reads as engineering work: the level rule's words plus
// two that are level words in their own right and so never reach
// `judgeLevel`'s engineering-work branch.
const ENGINEERING_WORK_WORDS = [...ENGINEERING_WORDS, "architect", "technical staff"] as const;

function matchesAny(
  text: string,
  terms: readonly string[],
): { readonly term: string; readonly index: number } | null {
  for (const term of terms) {
    const index = findWholeWord(text, term);
    if (index !== null) return { term, index };
  }
  return null;
}

function judgeLevel(title: string, compHigh: number | null, criteria: Criteria): Reason {
  const word = matchesAny(title, criteria.level_words);
  if (word !== null) {
    return { criterion: "level", verdict: "in", detail: `title carries level word "${word.term}"` };
  }
  const roman = matchesAny(title, ROMAN_LEVELS);
  if (roman !== null) {
    if (compHigh === null) {
      return {
        criterion: "level",
        verdict: "out",
        detail: `title carries level marker "${roman.term}" but no pay is posted to settle it`,
      };
    }
    return {
      criterion: "level",
      verdict: "in",
      detail: `title carries level marker "${roman.term}"`,
    };
  }
  const senior = matchesAny(title, SENIOR_MARKERS);
  if (senior !== null) {
    if (compHigh === null) {
      return {
        criterion: "level",
        verdict: "out",
        detail: `title carries "${senior.term}" but no pay is posted to settle it`,
      };
    }
    return {
      criterion: "level",
      verdict: "in",
      detail: `title carries "${senior.term}", settled by the posted pay`,
    };
  }
  // A level is a small number: an employer that numbers its levels uses one
  // or two digits. "2027" and "1099" are not levels, and the pay-settled
  // rules would otherwise admit a posting titled with a year and a band.
  const bareNumber = /\b\d{1,2}\b/.exec(title);
  if (bareNumber !== null) {
    if (compHigh === null) {
      return {
        criterion: "level",
        verdict: "out",
        detail: `title carries a bare number "${bareNumber[0]}" but no pay is posted to settle it`,
      };
    }
    return {
      criterion: "level",
      verdict: "in",
      detail: `title carries a bare number "${bareNumber[0]}" used as a level`,
    };
  }
  const work = matchesAny(title.slice(0, roleEnd(title)), ENGINEERING_WORDS);
  if (work !== null) {
    if (compHigh === null) {
      return {
        criterion: "level",
        verdict: "out",
        detail: `title names engineering work ("${work.term}") but no level, and no pay is posted to settle it`,
      };
    }
    return {
      criterion: "level",
      verdict: "in",
      detail: `title names engineering work ("${work.term}") and no level; settled by the posted pay`,
    };
  }
  return { criterion: "level", verdict: "out", detail: "title carries no level word or marker" };
}

// Read straight off `judgeLevel`'s own verdict rather than a second copy of
// its rule; `representativeByKey` (judge.ts) needs this for every row.
export function admitsLevel(
  posting: Pick<Posting, "title" | "comp_high">,
  criteria: Criteria,
): boolean {
  return judgeLevel(posting.title ?? "", posting.comp_high, criteria).verdict === "in";
}

function judgeRole(title: string, criteria: Criteria): Reason {
  const word = matchesAny(title, criteria.role_words);
  if (word !== null) {
    const work = matchesAny(title, ENGINEERING_WORK_WORDS);
    if (work === null) {
      return {
        criterion: "role",
        verdict: "out",
        detail: `title carries role word "${word.term}" but names no engineering work`,
      };
    }
    return { criterion: "role", verdict: "in", detail: `title carries role word "${word.term}"` };
  }
  return { criterion: "role", verdict: "out", detail: "title carries no role word" };
}

// Everything before the first comma, en dash or hyphen-with-spaces, the
// marker that starts a team, level or location suffix. A title with none is
// the role part entire.
function roleEnd(title: string): number {
  const indices = [
    title.indexOf(","),
    title.indexOf("–"),
    title.indexOf(" - "),
    title.indexOf("- "),
  ].filter((index) => index !== -1);
  return indices.length === 0 ? title.length : Math.min(...indices);
}

// Out on an excluded word, except a `team_name_words` word whose only match
// sits after the role part: "Staff Software Engineer, Customer
// Administration" keeps "customer" there as a team. A word not on
// `team_name_words` names an excluded discipline wherever it sits.
function judgeExcludedWords(title: string, criteria: Criteria): Reason {
  const boundary = roleEnd(title);
  const teamNames = new Set(criteria.team_name_words.map((word) => word.toLowerCase()));

  for (const term of criteria.excluded_title_words) {
    const index = findWholeWord(title, term);
    if (index === null) continue;
    if (teamNames.has(term.toLowerCase()) && index >= boundary) continue;
    return {
      criterion: "excluded_words",
      verdict: "out",
      detail: `title carries excluded word "${term}"`,
    };
  }
  return {
    criterion: "excluded_words",
    verdict: "in",
    detail: "title carries no excluded word outside a team name",
  };
}

// The label half of "United States only"; the body's half is
// `country_restriction` in text.ts. Here rather than there because the
// label is free and the body is not. A label naming only a city ("Seoul")
// falls to the "names no country is in" default.
function judgeCountry(location: string | null, criteria: Criteria): Reason {
  if (location === null || location.trim() === "") {
    return { criterion: "country", verdict: "in", detail: "posting names no location" };
  }
  const excluded = matchesAny(location, criteria.excluded_locations);
  if (excluded !== null && unitedStatesPlace(location) === null) {
    return {
      criterion: "country",
      verdict: "out",
      detail: `location "${location}" names excluded place "${excluded.term}"`,
    };
  }
  const foreign = foreignPlace(location);
  if (foreign === null) {
    return {
      criterion: "country",
      verdict: "in",
      detail: `location "${location}" names no country other than the United States`,
    };
  }
  const domestic = unitedStatesPlace(location);
  if (domestic !== null) {
    return {
      criterion: "country",
      verdict: "in",
      detail: `location "${location}" names "${foreign}" but also the United States ("${domestic}")`,
    };
  }
  return {
    criterion: "country",
    verdict: "out",
    detail: `location "${location}" names "${foreign}", not the United States`,
  };
}

// No band is in: pay that is not posted is not a low offer. A base below
// the floor that an assumed bonus would carry over it is in provisionally:
// `assumed_bonus_pct` is a guess, so the listing only opens the door for
// the text criterion (`bonus`, text.ts) to settle it. A null percentage
// means a base below the floor is out.
function judgeCompFloor(posting: Pick<Posting, "comp_high">, criteria: Criteria): Reason {
  if (posting.comp_high === null) {
    return { criterion: "comp_floor", verdict: "in", detail: "no comp band posted" };
  }
  if (posting.comp_high < criteria.comp_floor) {
    if (
      criteria.assumed_bonus_pct !== null &&
      posting.comp_high * (1 + criteria.assumed_bonus_pct / 100) >= criteria.comp_floor
    ) {
      return {
        criterion: "comp_floor",
        verdict: "in",
        detail: `comp_high ${posting.comp_high} is below the floor ${criteria.comp_floor}; a bonus of ${criteria.assumed_bonus_pct}% would reach it, so the text decides`,
      };
    }
    return {
      criterion: "comp_floor",
      verdict: "out",
      detail: `comp_high ${posting.comp_high} is below the floor ${criteria.comp_floor}`,
    };
  }
  return {
    criterion: "comp_floor",
    verdict: "in",
    detail: `comp_high ${posting.comp_high} is at or above the floor ${criteria.comp_floor}`,
  };
}

const DAY_MS = 86_400_000;

// Exported because `needsJudging` (judge.ts) asks the same question between
// runs, and the two have to answer it the same way or a row is re-judged to
// the verdict it already holds.
export function ageInDays(postedAt: string, now: string): number {
  return Math.floor((Date.parse(now) - Date.parse(postedAt)) / DAY_MS);
}

function postedAgo(days: number): string {
  return days === 1 ? "posted 1 day ago" : `posted ${days} days ago`;
}

// `now` is handed in, never read here, so a test and a run judge the same
// posting the same way.
function judgeAge(postedAt: string | null, criteria: Criteria, now: string): Reason {
  if (criteria.max_age_days === null) {
    return { criterion: "age", verdict: "in", detail: "no max age set" };
  }
  if (postedAt === null) {
    return { criterion: "age", verdict: "in", detail: "board gave no posting date" };
  }
  const days = ageInDays(postedAt, now);
  if (days > criteria.max_age_days) {
    return {
      criterion: "age",
      verdict: "out",
      detail: `${postedAgo(days)}, past the max age ${criteria.max_age_days}`,
    };
  }
  return {
    criterion: "age",
    verdict: "in",
    detail: `${postedAgo(days)}, within the max age ${criteria.max_age_days}`,
  };
}

// What the judging sweep knows about the boards it judges against, read
// once from `companies` (`judgeAll`, ingest.ts). `lastRead` and `watched`
// are keyed by `boardKey` and built from `watched`, undropped rows only;
// `stateOf` carries every company by name, `dropped` the names with
// `dropped_at` set. `NO_BOARDS` finds nothing gone.
export interface BoardIndex {
  readonly lastRead: ReadonlyMap<string, string>;
  readonly watched: ReadonlySet<string>;
  readonly stateOf: ReadonlyMap<string, Pick<Company, "state" | "alias_of">>;
  readonly dropped: ReadonlySet<string>;
}

export const NO_BOARDS: BoardIndex = {
  lastRead: new Map(),
  watched: new Set(),
  stateOf: new Map(),
  dropped: new Set(),
};

export function boardIndex(companies: readonly Company[]): BoardIndex {
  const lastRead = new Map<string, string>();
  const watched = new Set<string>();
  const stateOf = new Map<string, Pick<Company, "state" | "alias_of">>();
  const dropped = new Set<string>();
  for (const company of companies) {
    stateOf.set(company.name, { state: company.state, alias_of: company.alias_of });
    if (company.dropped_at !== null) dropped.add(company.name);
    // A dropped company's boards are not read, so nothing asks after them.
    if (company.state !== "watched" || company.dropped_at !== null) continue;
    for (const board of company.boards) {
      const key = boardKey(board);
      watched.add(key);
      if (board.last_read !== undefined) lastRead.set(key, board.last_read);
    }
  }
  return { lastRead, watched, stateOf, dropped };
}

// The board's `last_read`, or null for a posting with no board or a board
// with no recorded read.
function lastReadOf(
  posting: Pick<Posting, "platform" | "board">,
  boards: BoardIndex,
): string | null {
  if (posting.board === null) return null;
  return boards.lastRead.get(boardKey({ platform: posting.platform, id: posting.board })) ?? null;
}

// True when the board has been read since the posting was last seen: the
// board listed without it. Both values are `toISOString()` output (the
// store's timestamptz parser, postgres.ts; `now()` in ingest.ts), so the
// string comparison is chronological. `judge.ts` reads this for the
// re-judge trigger and the duplicate representative, so the two agree.
export function goneBy(
  posting: Pick<Posting, "platform" | "board" | "last_seen">,
  boards: BoardIndex,
): boolean {
  const lastRead = lastReadOf(posting, boards);
  return lastRead !== null && posting.last_seen < lastRead;
}

// True when the board has been read and the posting was seen at that read:
// the board listed it. Not `goneBy`'s negation: a board with no read on
// record is neither, and says nothing about the posting. `judge.ts` reads
// this for the gone re-judge trigger's reverse arm, so a watched board
// whose read failed never pulls its gone-out rows back in.
export function listedBy(
  posting: Pick<Posting, "platform" | "board" | "last_seen">,
  boards: BoardIndex,
): boolean {
  const lastRead = lastReadOf(posting, boards);
  return lastRead !== null && posting.last_seen >= lastRead;
}

function judgeGone(
  posting: Pick<Posting, "platform" | "board" | "last_seen">,
  boards: BoardIndex,
): Reason {
  const lastRead = lastReadOf(posting, boards);
  if (lastRead === null) {
    return { criterion: "gone", verdict: "in", detail: "board has no recorded read" };
  }
  const lastReadDay = lastRead.slice(0, 10);
  if (goneBy(posting, boards)) {
    return {
      criterion: "gone",
      verdict: "out",
      detail: `last seen ${posting.last_seen.slice(0, 10)}, board read ${lastReadDay} without it`,
    };
  }
  return {
    criterion: "gone",
    verdict: "in",
    detail: `listed at the board's last read ${lastReadDay}`,
  };
}

// True when the posting's company is dropped or no longer watched, or is
// watched but this board is not one of its own: `judgeUnwatched`'s "out"
// conditions, mirrored the way `goneBy` mirrors `judgeGone`, for
// `judge.ts`'s re-judge trigger. A posting with no board, or whose company
// is not on record, is never unwatched — nothing to compare, and an orphan
// row is not a judgement.
export function unwatchedBy(
  posting: Pick<Posting, "company" | "platform" | "board">,
  boards: BoardIndex,
): boolean {
  if (posting.board === null) return false;
  const company = boards.stateOf.get(posting.company);
  if (company === undefined) return false;
  if (boards.dropped.has(posting.company)) return true;
  if (company.state !== "watched") return true;
  return !boards.watched.has(boardKey({ platform: posting.platform, id: posting.board }));
}

function judgeUnwatched(
  posting: Pick<Posting, "company" | "platform" | "board">,
  boards: BoardIndex,
): Reason {
  if (posting.board === null) {
    return { criterion: "unwatched", verdict: "in", detail: "posting names no board" };
  }
  const company = boards.stateOf.get(posting.company);
  if (company === undefined) {
    return { criterion: "unwatched", verdict: "in", detail: "company not on record" };
  }
  // The flag before the state: a drop is the operator's word on the company,
  // whatever the processor's column says.
  if (boards.dropped.has(posting.company)) {
    return {
      criterion: "unwatched",
      verdict: "out",
      detail: `company ${posting.company} is dropped`,
    };
  }
  if (company.state === "discovered") {
    return {
      criterion: "unwatched",
      verdict: "out",
      detail: `company ${posting.company} returned to discovered`,
    };
  }
  if (company.state === "alias") {
    return {
      criterion: "unwatched",
      verdict: "out",
      detail: `company ${posting.company} is an alias of ${company.alias_of ?? "another company"}`,
    };
  }
  const key = boardKey({ platform: posting.platform, id: posting.board });
  if (!boards.watched.has(key)) {
    return {
      criterion: "unwatched",
      verdict: "out",
      detail: `board ${posting.platform}/${posting.board} is no longer on ${posting.company}`,
    };
  }
  return {
    criterion: "unwatched",
    verdict: "in",
    detail: `board ${posting.platform}/${posting.board} is watched`,
  };
}

// The title with every level word stripped, a step apart from the level
// criterion so a bare number or "founding" can count here without meaning
// anything to `judgeLevel`: boards post "Founding Product Engineer" beside
// plain "Product Engineer" for the same req. No parenthetical strip: a
// parenthetical usually names the team ("(Online Storage)"), and stripping
// it merges different teams' reqs into one key.
function strippedTitleForKey(title: string, criteria: Criteria): string {
  const words = [...criteria.level_words, ...ROMAN_LEVELS, ...SENIOR_MARKERS, "founding"];
  let stripped = title;
  for (const word of words) {
    stripped = stripped.replace(new RegExp(wholeWordPattern(word), "gi"), " ");
  }
  // The same bare number `judgeLevel` reads, so "Engineer 3" and
  // "Engineer" share a key the way "Staff Engineer" and "Engineer" do.
  stripped = stripped.replace(/\b\d{1,2}\b/g, " ");
  stripped = stripped.replace(/\s+/g, " ").trim();
  stripped = stripped.replace(/^\p{P}+|\p{P}+$/gu, "").trim();
  return stripped.toLowerCase();
}

// Two postings on one board, posted the same day, in the same band and
// place, whose titles differ only by a level word are one req. A null
// `posted_at` or `title` gets its own key from its own identity: two
// postings must not share a key just because both are missing a field. No
// platform value is ever "own" (see `PLATFORMS`), so it cannot collide with
// a real composite key.
export function duplicateKey(
  posting: Pick<
    Posting,
    "key" | "platform" | "board" | "posted_at" | "comp_high" | "location" | "title"
  >,
  criteria: Criteria,
): string {
  if (posting.posted_at === null || posting.title === null) {
    return `own:${posting.key}`;
  }
  return [
    posting.platform,
    posting.board,
    posting.posted_at,
    // Two postings that post no band share a band for this key; the rest of
    // the key still has to match.
    posting.comp_high,
    posting.location,
    strippedTitleForKey(posting.title, criteria),
  ].join("::");
}

// In when nothing else in `representativeByKey` claims this posting's key,
// or the key names this row itself; out otherwise, naming the
// representative ("the latest seen that the level criterion admits",
// computed in judge.ts). An empty map reads as "no duplicates known"; a
// group with no level-admitted row has no entry, and `judgeLevel` drops
// each of its members on its own.
function judgeDuplicate(
  posting: Pick<
    Posting,
    "key" | "platform" | "board" | "posted_at" | "comp_high" | "location" | "title"
  >,
  criteria: Criteria,
  representativeByKey: ReadonlyMap<string, string>,
): Reason {
  const representativeKey = representativeByKey.get(duplicateKey(posting, criteria));
  if (representativeKey === undefined || representativeKey === posting.key) {
    return {
      criterion: "duplicate",
      verdict: "in",
      detail: "no later, level-admitted posting shares its board, date, band, place and title",
    };
  }
  return {
    criterion: "duplicate",
    verdict: "out",
    detail: `duplicate of ${representativeKey}: same board, date, band and place, title differs only by level words; that posting is the latest the level criterion admits`,
  };
}

// Takes the columns it reads, not a whole `Posting`, so `ingest`'s judging
// pass can decide without pulling every body. `boards` and
// `representativeByKey` default to "no board read on record" and "no
// duplicates known"; the gone and duplicate criteria always run and always
// add a reason.
export function judgeListing(
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
  now: string = new Date().toISOString(),
  boards: BoardIndex = NO_BOARDS,
  representativeByKey: ReadonlyMap<string, string> = new Map(),
): { readonly kept: boolean; readonly reasons: Reason[] } {
  const title = posting.title ?? "";
  // Ordered as the design page lists the criteria.
  const reasons: Reason[] = [
    judgeLevel(title, posting.comp_high, criteria),
    judgeRole(title, criteria),
    judgeExcludedWords(title, criteria),
    judgeCountry(posting.location, criteria),
    judgeCompFloor(posting, criteria),
    judgeAge(posting.posted_at, criteria, now),
    judgeGone(posting, boards),
    judgeUnwatched(posting, boards),
    judgeDuplicate(posting, criteria, representativeByKey),
  ];
  return { kept: reasons.every((reason) => reason.verdict === "in"), reasons };
}
