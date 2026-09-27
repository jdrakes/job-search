// Re-runs one posting's full judgment on request and sets it beside the
// verdict already stored. Judging is deterministic, so re-running
// `fullJudgment` against the row's stored columns explains a verdict
// without waiting for the next daily run, and without the trimmed
// `reasons`/`evidence` `judge()` now stores hiding any of it. It is only a
// reproduction when it judged the same body the last run did: a two-phase
// posting whose body was cleared after it was rejected on a text criterion
// (#272's body-storage rule) is judged here with no body, which can read
// more permissively than the stored verdict. The stored verdict is printed
// too, and a disagreement is flagged.
//
//   node --env-file=.env scripts/explain-posting.ts <key>
import process from "node:process";

import { READERS } from "../src/ats/readers.ts";
import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import { fullJudgment, representativeByKey } from "../src/judge/judge.ts";
import { boardIndex, type Reason } from "../src/judge/listing.ts";
import { COMPANY_FIELDS, type Company, type Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

// The columns `fullJudgment` reads for the one posting being explained,
// plus `first_seen` for completeness (not read by `fullJudgment` itself,
// only by `representativeByKey`'s sweep over every posting below), and the
// stored verdict (`kept`, `reasons`) the live one is compared against.
const ROW_COLUMNS = [
  "key",
  "company",
  "platform",
  "board",
  "title",
  "location",
  "comp_high",
  "posted_at",
  "body",
  "last_seen",
  "workplace",
  "status",
  "first_seen",
  "kept",
  "reasons",
] as const satisfies readonly (keyof Posting)[];

type ExplainedRow = Pick<Posting, (typeof ROW_COLUMNS)[number]>;

// The columns `representativeByKey` needs across every posting in the
// store, so this one row is judged against the same "who wins the
// duplicate key" answer the last daily run would have reached.
const REPRESENTATIVE_COLUMNS = [
  "key",
  "platform",
  "board",
  "posted_at",
  "comp_high",
  "location",
  "title",
  "first_seen",
  "last_seen",
] as const satisfies readonly (keyof Posting)[];

type RepresentativeRow = Pick<Posting, (typeof REPRESENTATIVE_COLUMNS)[number]>;

// Which body this run's judgment read:
// - "listing": a one-phase board; the stored body is what a fresh listing
//   carries, so the text criteria read what the last run read.
// - "stored": a two-phase board with a body on file; judged from it rather
//   than a fresh fetch of the detail page.
// - "absent": a two-phase board with no body on file (never fetched, or
//   cleared by #272's rule after a text-criterion rejection); the text
//   criteria read an empty body, so this run may not match the last one.
export type JudgedBody = "listing" | "stored" | "absent";

export interface Explanation {
  readonly ok: true;
  // This run's judgment.
  readonly kept: boolean;
  readonly reasons: readonly Reason[];
  readonly judgedBody: JudgedBody;
  // What the last daily run stored: `kept` is null for a posting never
  // judged; `reasons` names the criteria that were out.
  readonly storedKept: boolean | null;
  readonly storedReasons: readonly string[];
  // Whether this run reached the stored verdict: the same `kept` and the
  // same out criteria. Null when nothing is stored to compare against.
  readonly agreesWithStored: boolean | null;
}

export type ExplainResult = Explanation | { readonly ok: false; readonly reason: string };

export async function explainPosting(store: Store, key: string): Promise<ExplainResult> {
  const rows = await store.select<ExplainedRow>("postings", { key }, ROW_COLUMNS);
  const row = rows[0];
  if (row === undefined) {
    return { ok: false, reason: `no posting with key "${key}"` };
  }

  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    return { ok: false, reason: criteriaResult.reason };
  }
  const criteria = criteriaResult.value;

  const companies = await store.select<Company>("companies", undefined, COMPANY_FIELDS);
  const boards = boardIndex(companies);

  const postings = await store.select<RepresentativeRow>(
    "postings",
    undefined,
    REPRESENTATIVE_COLUMNS,
  );
  const representative = representativeByKey(postings, criteria, boards);

  const twoPhase = READERS[row.platform].body !== undefined;
  const judgedBody: JudgedBody = !twoPhase ? "listing" : row.body === null ? "absent" : "stored";

  const { kept, reasons } = fullJudgment(
    row,
    criteria,
    new Date().toISOString(),
    boards,
    representative,
  );
  const storedReasons = storedOutCriteria(row.reasons);
  const liveOut = reasons
    .filter((reason) => reason.verdict === "out")
    .map((reason) => reason.criterion);
  const agreesWithStored =
    row.kept === null ? null : row.kept === kept && sameNames(liveOut, storedReasons);
  return {
    ok: true,
    kept,
    reasons,
    judgedBody,
    storedKept: row.kept,
    storedReasons,
    agreesWithStored,
  };
}

// `reasons` is jsonb. A row converted or judged since #273 holds the out
// criteria's names; one not yet converted by `scripts/shrink-reasons.ts`
// holds a `{criterion, verdict}` object per criterion, of which the "out"
// ones are the same names.
function storedOutCriteria(reasons: readonly unknown[] | null): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((reason: unknown) => {
    if (typeof reason === "string") return [reason];
    if (typeof reason !== "object" || reason === null) return [];
    const { criterion, verdict } = reason as { criterion?: unknown; verdict?: unknown };
    return typeof criterion === "string" && verdict === "out" ? [criterion] : [];
  });
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((name, index) => name === sortedRight[index])
  );
}

const BODY_NOTES: Record<JudgedBody, string | null> = {
  listing: null,
  stored:
    "note: this platform reads a live detail page; this run judged the stored body " +
    "rather than fetching one, so a live read today could differ.",
  absent:
    "note: this platform reads a live detail page, but no body is stored for this " +
    "posting (never fetched, or cleared after a text-criterion rejection). This run " +
    "judged an empty body, so the text criteria (excluded_states, country_restriction, " +
    "missing_languages, bonus, remote) read nothing; the stored verdict is the one " +
    "reached with the body the last run read.",
};

function printExplanation(key: string, result: ExplainResult): void {
  if (!result.ok) {
    console.log(`explain-posting: ${result.reason}`);
    return;
  }
  console.log(`${key}, judged now:`);
  for (const reason of result.reasons) {
    console.log(`  ${reason.criterion} (${reason.verdict}): ${reason.detail}`);
  }
  console.log(`kept now: ${result.kept}`);
  if (result.storedKept === null) {
    console.log("stored: never judged");
  } else {
    const out = result.storedReasons.length === 0 ? "none" : result.storedReasons.join(", ");
    console.log(`stored: kept ${result.storedKept}, out: ${out}`);
  }
  if (result.agreesWithStored === false) {
    console.log("DISAGREES: this run did not reach the stored verdict.");
  }
  const note = BODY_NOTES[result.judgedBody];
  if (note !== null) console.log(note);
}

async function main(): Promise<void> {
  const key = process.argv[2];
  if (key === undefined) {
    console.error("explain-posting: usage: explain-posting.ts <key>");
    process.exitCode = 1;
    return;
  }
  const store = openStore();
  const result = await explainPosting(store, key);
  printExplanation(key, result);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`explain-posting: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
