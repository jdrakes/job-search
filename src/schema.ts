// The store's shape, one place. The field lists are checked against this
// file's interfaces (`satisfies`) and the migration's column list
// (tests/schema.test.ts), so a column can only drift if both are edited.

export const TABLES = ["postings", "companies", "criteria", "reprobe_runs"] as const;
export type Table = (typeof TABLES)[number];

export const PLATFORMS = [
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "eightfold",
  "smartrecruiters",
  "amazon",
  "workable",
  "rippling",
  "jobvite",
  "bamboohr",
  "avature",
  "breezy",
  "jazzhr",
  "recruitee",
  "personio",
  "hrmdirect",
  "icims",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const STATUSES = ["applied", "interviewing", "rejected", "offer", "closed"] as const;
export type Status = (typeof STATUSES)[number];

// The processor's column. A drop is the operator's and lives in `dropped_at` and
// `reason` beside it; `alias` is a name whose board another company owns.
export const COMPANY_STATES = ["discovered", "watched", "alias"] as const;
export type CompanyState = (typeof COMPANY_STATES)[number];

export const WORKPLACES = ["remote", "hybrid", "onsite"] as const;
export type Workplace = (typeof WORKPLACES)[number];

// Never derived from the company's name. `gone: 1` marks a board that
// answered "not here" on the last run (`isGone` in companies.ts); absent
// means it answered. `last_read` is the start of the last run that listed
// and recorded this board; absent until one has. Identity is `platform`
// and `id` alone.
export interface Board {
  readonly platform: Platform;
  readonly id: string;
  readonly gone?: number;
  readonly last_read?: string;
}

// `platform/board::id`: two employers can share an ATS listing id, and a
// name can be renamed or reached under a second spelling, so the board is
// the identity. The key holds exactly one `::`: a platform and a board slug
// carry none, while a listing id is a board's free text, so the id reads
// back by cutting at the first `::` (`postingIdOf` in ingest.ts).
export function postingKey(board: Board, id: string): string {
  return `${board.platform}/${board.id}::${id}`;
}

// snake_case, matching the columns one for one: the same array is checked
// against this interface's keys and the migration's column list.
export interface Posting {
  readonly key: string;
  readonly company: string;
  readonly platform: Platform;
  readonly board: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly location: string | null;
  readonly comp_low: number | null;
  readonly comp_high: number | null;
  readonly posted_at: string | null;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly live: boolean | null;
  readonly body: string | null;
  readonly kept: boolean | null;
  readonly reasons: readonly unknown[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly judged_with: string | null;
  readonly status: Status | null;
  readonly applied_at: string | null;
  readonly status_at: string | null;
  readonly note: string | null;
  // md5 of `body`; null until a listing writes one.
  readonly body_hash: string | null;
  // The board's stated workplace where a system states one; null otherwise.
  readonly workplace: Workplace | null;
}

export const POSTING_FIELDS = [
  "key",
  "company",
  "platform",
  "board",
  "title",
  "url",
  "location",
  "comp_low",
  "comp_high",
  "posted_at",
  "first_seen",
  "last_seen",
  "live",
  "body",
  "kept",
  "reasons",
  "evidence",
  "judged_with",
  "status",
  "applied_at",
  "status_at",
  "note",
  "body_hash",
  "workplace",
] as const satisfies readonly (keyof Posting)[];

// Never the body: most of the bytes, on a page that renders the evidence.
// `body_hash` is listing's bookkeeping; `workplace` is already named by the
// remote reason.
export const POSTING_LIST_FIELDS = POSTING_FIELDS.filter(
  (field) => field !== "body" && field !== "body_hash" && field !== "workplace",
);
export type PostingSummary = Omit<Posting, "body" | "body_hash" | "workplace">;

// `state`, `boards`, `source`, `alias_of` and the timestamps are the
// processor's; `dropped_at` and `reason` are the operator's and no publish writes
// them. A watched company with `dropped_at` set is not read.
export interface Company {
  readonly name: string;
  readonly state: CompanyState;
  readonly boards: readonly Board[];
  readonly source: string | null;
  readonly reason: string | null;
  readonly first_seen: string;
  readonly last_seen: string;
  readonly dropped_at: string | null;
  // The owning company's name when `state` is `alias`; null otherwise.
  readonly alias_of: string | null;
}

export const COMPANY_FIELDS = [
  "name",
  "state",
  "boards",
  "source",
  "reason",
  "first_seen",
  "last_seen",
  "dropped_at",
  "alias_of",
] as const satisfies readonly (keyof Company)[];

export interface Criteria {
  readonly id: number;
  readonly level_words: readonly string[];
  readonly role_words: readonly string[];
  readonly excluded_title_words: readonly string[];
  readonly team_name_words: readonly string[];
  readonly excluded_states: readonly string[];
  readonly missing_languages: readonly string[];
  readonly comp_floor: number;
  readonly max_age_days: number | null;
  readonly excluded_locations: readonly string[];
  readonly product_words: readonly string[];
  readonly assumed_bonus_pct: number | null;
  readonly updated_at: string;
}

export const CRITERIA_FIELDS = [
  "id",
  "level_words",
  "role_words",
  "excluded_title_words",
  "team_name_words",
  "excluded_states",
  "missing_languages",
  "comp_floor",
  "updated_at",
  "max_age_days",
  "excluded_locations",
  "product_words",
  "assumed_bonus_pct",
] as const satisfies readonly (keyof Criteria)[];

// One row per `scripts/reprobe.ts` pass. The backlog pass is by hand,
// costs thousands of vendor requests and takes hours, and nothing recorded
// that one had run: on 2026-09-23 a pass re-asked six platforms the
// backlog had been cleared against the day before, ~14,000 requests for
// nothing, and the redundancy only showed once it had returned zero across
// 2,100 names.
//
// `platforms` is the pass's platform list sorted and comma-joined, so two
// runs naming the same set in a different order match. `refused_at` is the
// name a vendor's 429 stopped the pass on, and it is where the next pass
// over the same platforms resumes. `finished` is null while a pass is
// running and stays null if it is killed, which is what distinguishes
// "never completed" from "completed and found nothing" - the distinction
// whose absence cost the morning.
export interface ReprobeRun {
  readonly started: string;
  readonly platforms: string;
  readonly names: number;
  readonly probed: number;
  readonly watched: number;
  readonly aliases: number;
  readonly errors: number;
  readonly refused_at: string | null;
  readonly finished: string | null;
}

export const REPROBE_RUN_FIELDS = [
  "started",
  "platforms",
  "names",
  "probed",
  "watched",
  "aliases",
  "errors",
  "refused_at",
  "finished",
] as const satisfies readonly (keyof ReprobeRun)[];

// Read by `src/store/memory.ts` to answer a select with the table's whole
// column list, the way Postgres does.
export const TABLE_FIELDS = {
  postings: POSTING_FIELDS,
  companies: COMPANY_FIELDS,
  criteria: CRITERIA_FIELDS,
  reprobe_runs: REPROBE_RUN_FIELDS,
} as const satisfies Record<Table, readonly string[]>;
