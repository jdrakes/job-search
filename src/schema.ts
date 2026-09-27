// The store's shape, one place. The field lists are checked against this
// file's interfaces (`satisfies`) and the migration's column list
// (tests/schema.test.ts), so a column can only drift if both are edited.

export const TABLES = ["postings", "companies", "criteria", "candidates"] as const;
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
  // When a board's successful read first stopped listing the posting; null
  // while its latest successful read lists it (`listCompany`, ingest.ts).
  readonly gone_at: string | null;
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
  "gone_at",
] as const satisfies readonly (keyof Posting)[];

// Never the body: most of the bytes, on a page that renders the evidence.
// `body_hash` and `gone_at` are listing's bookkeeping; `workplace` is
// already named by the remote reason.
export const POSTING_LIST_FIELDS = POSTING_FIELDS.filter(
  (field) =>
    field !== "body" && field !== "body_hash" && field !== "workplace" && field !== "gone_at",
);
export type PostingSummary = Omit<Posting, "body" | "body_hash" | "workplace" | "gone_at">;

// `boards` is the processor's (discover writes it); `dropped_at` and
// `reason` are the operator's and no publish writes them. Everything else
// said of a company is derived: it is read when it is not dropped and has a
// board (`readable`, companies.ts); where it came from and its aliases are
// its candidates'.
export interface Company {
  readonly name: string;
  readonly boards: readonly Board[];
  readonly reason: string | null;
  readonly dropped_at: string | null;
}

export const COMPANY_FIELDS = [
  "name",
  "boards",
  "reason",
  "dropped_at",
] as const satisfies readonly (keyof Company)[];

// What discover made of a candidate. `wrong_company` is reserved for a
// board that answers under another employer's name.
export const OUTCOMES = [
  "watched",
  "added",
  "known",
  "alias",
  "no_board",
  "wrong_company",
  "gone",
  "dropped",
  "bad_url",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

// A name on its way in. `name`, `url`, `origin` and `evidence` are what the
// input said (at least one of `name` and `url`); `outcome`, `outcome_at` and
// `company` are discover's. `outcome` null is unresolved; `company` is set
// when the outcome names one (watched, added, known when a company matched,
// alias, dropped).
export interface Candidate {
  readonly id: string;
  readonly name: string | null;
  readonly url: string | null;
  readonly origin: string;
  readonly evidence: string | null;
  readonly added_at: string;
  readonly outcome: Outcome | null;
  readonly outcome_at: string | null;
  readonly company: string | null;
}

export const CANDIDATE_FIELDS = [
  "id",
  "name",
  "url",
  "origin",
  "evidence",
  "added_at",
  "outcome",
  "outcome_at",
  "company",
] as const satisfies readonly (keyof Candidate)[];

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

// Read by `src/store/memory.ts` to answer a select with the table's whole
// column list, the way Postgres does.
export const TABLE_FIELDS = {
  postings: POSTING_FIELDS,
  companies: COMPANY_FIELDS,
  criteria: CRITERIA_FIELDS,
  candidates: CANDIDATE_FIELDS,
} as const satisfies Record<Table, readonly string[]>;
