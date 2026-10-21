// Says why a role the job email check expected is not in the store, by
// reading the company's boards live with the daily run's own readers and
// judging each matching listing with the storage gate. Read-only: the store
// is only selected from.
//
//   node --env-file=.env scripts/explain-miss.ts "<company>" "<title>"
//
// Since #287 a posting whose title or place fails the criteria is never
// stored, so "watched, posting absent" is often "judged out", and only a
// live read can tell.
import process from "node:process";

import type { Listing } from "../src/ats/ats.ts";
import { boardsOf } from "../src/companies.ts";
import { loadCriteria } from "../src/criteria.ts";
import { resolveReaders } from "../src/daily.ts";
import { describeError } from "../src/errors.ts";
import { groupByRequisition, listingAdmits, twoPhase } from "../src/ingest.ts";
import {
  judgeCountry,
  judgeExcludedWords,
  judgeLevel,
  judgeRole,
  type Reason,
} from "../src/judge/listing.ts";
import { cxsUrl, parseWorkdayId } from "../src/ats/workday.ts";
import { postJson, type HttpOptions } from "../src/net/http.ts";
import {
  COMPANY_FIELDS,
  postingKey,
  type Board,
  type Company,
  type Criteria,
  type Posting,
} from "../src/schema.ts";
import { loadSettings } from "../src/settings.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";
import { storedOutCriteria } from "./explain-posting.ts";

export type MissCause = string;

// What the store holds for a matching listing's key.
export interface StoredState {
  readonly kept: boolean | null;
  readonly hiddenReasons: readonly string[];
}

// One listing whose title matched, already judged.
export interface Match {
  // The failing criterion and its detail when the storage gate rejects the
  // listing; null when the gate admits it.
  readonly rejectedBy: { readonly criterion: string; readonly detail: string } | null;
  readonly stored: StoredState | null;
}

export interface MissInput {
  readonly companyKnown: boolean;
  readonly boardCount: number;
  // How many board reads, or Workday title searches, failed.
  readonly failedReads: number;
  readonly matches: readonly Match[];
  // Whether a Workday search for the title found it; null when none was made.
  readonly searchHit: boolean | null;
}

function storedCause(state: StoredState): MissCause {
  if (state.kept === true) return "stored";
  const reasons = state.hiddenReasons.length === 0 ? "not kept" : state.hiddenReasons.join(", ");
  return `stored, hidden: ${reasons}`;
}

// A stored match wins, since it is what the store holds. Next a match the
// gate admits but the store lacks (listed since the last daily run, or the
// criteria were edited after it), and last the first rejection. With no
// match at all, a failed read means the role may be on the board that
// failed, so the cause is unknown rather than absent.
export function missCause(input: MissInput): MissCause {
  if (!input.companyKnown) return "company unknown";
  if (input.boardCount === 0) return "no board";
  if (input.matches.length === 0) {
    if (input.failedReads > 0) return `unknown, ${input.failedReads} board read(s) failed`;
    return input.searchHit === true ? "outside the reader's search" : "not on board";
  }
  const stored = input.matches.find((match) => match.stored !== null);
  if (stored?.stored) return storedCause(stored.stored);
  if (input.matches.some((match) => match.rejectedBy === null)) return "admitted, not yet stored";
  const rejection = input.matches[0]!.rejectedBy!;
  return `judged out: ${rejection.criterion}: ${rejection.detail}`;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

// Every word of `wanted` appears in `title`, in any order.
export function titleMatches(title: string | null, wanted: string): boolean {
  const have = new Set(words(title ?? ""));
  return words(wanted).every((word) => have.has(word));
}

// The first criterion the title and place rules fail, judged as the storage
// gate judges: a board that reads a detail page and states no pay is judged
// at the pay floor.
export function failingCriterion(
  listing: Pick<Listing, "title" | "location" | "compHigh">,
  readsPage: boolean,
  criteria: Criteria,
): Reason | null {
  const title = listing.title ?? "";
  const compHigh = listing.compHigh ?? (readsPage ? criteria.comp_floor : null);
  const reasons = [
    judgeLevel(title, compHigh, criteria),
    judgeRole(title, criteria),
    judgeExcludedWords(title, criteria),
    judgeCountry(listing.location, criteria, listing.title),
  ];
  return reasons.find((reason) => reason.verdict === "out") ?? null;
}

type StoredRow = Pick<Posting, "key" | "kept" | "reasons">;

async function storedState(
  store: Store,
  board: Board,
  listing: Listing,
): Promise<StoredState | null> {
  const key = postingKey(board, listing.id);
  const rows = await store.select<StoredRow>("postings", { key }, ["key", "kept", "reasons"]);
  const row = rows[0];
  if (row === undefined) return null;
  return { kept: row.kept, hiddenReasons: storedOutCriteria(row.reasons) };
}

// One search by the title on a Workday tenant, outside the reader's own
// queries: whether the tenant lists it at all. A failed search is returned,
// so the caller counts it as one more failed read.
export async function workdaySearchHit(
  board: Board,
  title: string,
  options?: HttpOptions,
): Promise<{ ok: true; value: boolean } | { ok: false; reason: string }> {
  const parsed = parseWorkdayId(board.id);
  if (parsed === null) return { ok: true, value: false };
  const payload = { appliedFacets: {}, limit: 20, offset: 0, searchText: title };
  try {
    const data = await postJson<{ jobPostings?: { title?: string }[] }>(
      `${cxsUrl(parsed)}/jobs`,
      payload,
      options,
    );
    const hit = (data.jobPostings ?? []).some((entry) => titleMatches(entry.title ?? null, title));
    return { ok: true, value: hit };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

async function main(): Promise<void> {
  const [companyName, title] = process.argv.slice(2);
  if (companyName === undefined || title === undefined) {
    console.error('explain-miss: usage: explain-miss.ts "<company>" "<title>"');
    process.exitCode = 1;
    return;
  }
  const store = openStore();
  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    console.error(`explain-miss: ${criteriaResult.reason}`);
    process.exitCode = 1;
    return;
  }
  const criteria = criteriaResult.value;
  const readers = await resolveReaders(loadSettings());

  const companies = await store.select<Company>("companies", undefined, COMPANY_FIELDS);
  const company = companies.find((row) => row.name.toLowerCase() === companyName.toLowerCase());
  const boards = company === undefined ? [] : boardsOf(company);

  const matches: Match[] = [];
  let searchHit: boolean | null = null;
  let readFailures = 0;
  for (const board of boards) {
    const reader = readers[board.platform];
    let listings: readonly Listing[];
    try {
      listings = await reader.list(board);
    } catch (error) {
      readFailures += 1;
      console.log(`${board.platform}/${board.id}: read failed: ${describeError(error)}`);
      continue;
    }
    const grouped = groupByRequisition(listings, new Set(), (listing) =>
      listingAdmits(listing, undefined, board, reader, criteria),
    );
    const found = grouped.filter((listing) => titleMatches(listing.title, title));
    const readsPage = twoPhase(board.platform, board.id, reader);
    for (const listing of found) {
      const rejected = listingAdmits(listing, undefined, board, reader, criteria)
        ? null
        : failingCriterion(listing, readsPage, criteria);
      const stored = await storedState(store, board, listing);
      const match: Match = {
        rejectedBy:
          rejected === null ? null : { criterion: rejected.criterion, detail: rejected.detail },
        stored,
      };
      matches.push(match);
      const gate =
        match.rejectedBy === null
          ? "admitted"
          : `judged out: ${match.rejectedBy.criterion}: ${match.rejectedBy.detail}`;
      const held = stored === null ? "not stored" : storedCause(stored);
      console.log(
        `${board.platform}/${board.id}: ${listing.title} (${listing.location ?? "no place"}): ${gate}; ${held}`,
      );
    }
    if (found.length === 0 && board.platform === "workday") {
      const search = await workdaySearchHit(board, title);
      if (search.ok) {
        searchHit = search.value || searchHit === true;
      } else {
        readFailures += 1;
        console.log(`${board.platform}/${board.id}: title search failed: ${search.reason}`);
      }
    }
  }
  if (readFailures > 0) process.exitCode = 1;
  const cause = missCause({
    companyKnown: company !== undefined,
    boardCount: boards.length,
    failedReads: readFailures,
    matches,
    searchHit,
  });
  console.log(`cause: ${cause}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`explain-miss: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
