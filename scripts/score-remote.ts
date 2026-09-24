/**
 * The gate for the remote criterion's text path: every posting whose board
 * states its workplace, with that field hidden, so `judgeRemote`'s
 * field-first branch never fires and what this scores is the text path
 * alone. `scoreRemote` is pure so a test can score a stub.
 */
import process from "node:process";

import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import { judgeText } from "../src/judge/text.ts";
import type { Reason } from "../src/judge/listing.ts";
import { STATUSES, type Platform, type Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";

const SCORE_COLUMNS = [
  "key",
  "company",
  "platform",
  "body",
  "location",
  "comp_high",
  "workplace",
  "status",
] as const;

export type RemoteRow = Pick<Posting, (typeof SCORE_COLUMNS)[number]>;

// The board's workplace word is already hidden by the caller, so a stub
// never sees the label it is scored against.
export type Judge = (
  row: Pick<RemoteRow, "key" | "body" | "location" | "comp_high" | "workplace">,
) => Reason;

export interface CountAndPct {
  readonly count: number;
  readonly pct: number;
}

export interface Score {
  readonly rows: number;
  readonly remoteLost: CountAndPct;
  readonly onsiteAdmitted: CountAndPct;
  readonly accuracy: CountAndPct;
}

export interface ActedOn {
  readonly rows: number;
  readonly kept: number;
}

export interface RemoteScore {
  readonly full: Score;
  readonly capped: Score;
  readonly byPlatform: Partial<Record<Platform, Score>>;
  readonly actedOn: ActedOn;
}

// Capped per company: the biggest companies are a large share of the
// labelled set. One per distinct body: a company's boilerplate sentence
// repeated across its postings can otherwise make or break a phrase.
export const COMPANY_CAP = 20;

function countAndPct(count: number, denominator: number): CountAndPct {
  // An empty subset scores 0%, not NaN.
  const pct = denominator === 0 ? 0 : Math.round((count / denominator) * 1000) / 10;
  return { count, pct };
}

// First-seen wins, in key order. `perCompany` is a parameter so a test can
// exercise the boundary without 21 rows for one company.
export function capRows<
  T extends { readonly key: string; readonly company: string; readonly body: string | null },
>(rows: readonly T[], perCompany: number = COMPANY_CAP): T[] {
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seenBodies = new Set<string | null>();
  const keptPerCompany = new Map<string, number>();
  const kept: T[] = [];
  for (const row of sorted) {
    if (seenBodies.has(row.body)) continue;
    const keptSoFar = keptPerCompany.get(row.company) ?? 0;
    if (keptSoFar >= perCompany) continue;
    seenBodies.add(row.body);
    keptPerCompany.set(row.company, keptSoFar + 1);
    kept.push(row);
  }
  return kept;
}

function scoreRows(rows: readonly RemoteRow[], judge: Judge): Score {
  let remoteRows = 0;
  let remoteLost = 0;
  let onsiteRows = 0;
  let onsiteAdmitted = 0;
  let agreements = 0;
  for (const row of rows) {
    const verdict = judge({
      key: row.key,
      body: row.body,
      location: row.location,
      comp_high: row.comp_high,
      workplace: null,
    }).verdict;
    if (row.workplace === "remote") {
      remoteRows += 1;
      if (verdict === "out") remoteLost += 1;
      else agreements += 1;
    } else if (row.workplace === "onsite") {
      onsiteRows += 1;
      if (verdict === "in") onsiteAdmitted += 1;
      else agreements += 1;
    }
  }
  return {
    rows: rows.length,
    remoteLost: countAndPct(remoteLost, remoteRows),
    onsiteAdmitted: countAndPct(onsiteAdmitted, onsiteRows),
    accuracy: countAndPct(agreements, rows.length),
  };
}

// A separate read from `rows`: James's record is every posting he has
// acted on, not only the Ashby/Lever rows. Every row here carries a status.
export function scoreRemote(
  rows: readonly RemoteRow[],
  judge: Judge,
  actedOnRows: readonly RemoteRow[],
): RemoteScore {
  const byPlatform: Partial<Record<Platform, Score>> = {};
  for (const platform of new Set(rows.map((row) => row.platform))) {
    byPlatform[platform] = scoreRows(
      rows.filter((row) => row.platform === platform),
      judge,
    );
  }
  const kept = actedOnRows.filter(
    (row) =>
      judge({
        key: row.key,
        body: row.body,
        location: row.location,
        comp_high: row.comp_high,
        workplace: null,
      }).verdict === "in",
  ).length;
  return {
    full: scoreRows(rows, judge),
    capped: scoreRows(capRows(rows), judge),
    byPlatform,
    actedOn: { rows: actedOnRows.length, kept },
  };
}

function formatScore(view: string, score: Score): string {
  return [
    view.padEnd(18),
    String(score.rows).padStart(6),
    `${score.remoteLost.pct.toFixed(1)}%`.padStart(10),
    `${score.onsiteAdmitted.pct.toFixed(1)}%`.padStart(10),
    `${score.accuracy.pct.toFixed(1)}%`.padStart(10),
  ].join("  ");
}

function printTable(score: RemoteScore): void {
  console.log(
    [
      "view".padEnd(18),
      "rows".padStart(6),
      "remote lost".padStart(10),
      "onsite in".padStart(10),
      "accuracy".padStart(10),
    ].join("  "),
  );
  console.log(formatScore("full", score.full));
  console.log(formatScore("capped", score.capped));
  for (const [platform, platformScore] of Object.entries(score.byPlatform)) {
    console.log(formatScore(`platform: ${platform}`, platformScore));
  }
  console.log(
    `${"acted-on".padEnd(18)}${String(score.actedOn.kept).padStart(6)} in / ${score.actedOn.rows} rows with a status`,
  );
}

async function main(): Promise<void> {
  const dbUrl = process.env["JOB_SEARCH_DB_URL"];
  if (dbUrl === undefined || dbUrl === "") {
    console.error("score-remote: no JOB_SEARCH_DB_URL — the score needs the local store");
    process.exitCode = 1;
    return;
  }
  const store = openStore();
  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    console.error(`score-remote: ${criteriaResult.reason}`);
    process.exitCode = 1;
    return;
  }
  const criteria = criteriaResult.value;
  const judge: Judge = (row) => {
    const reason = judgeText(row, criteria).reasons.find(
      (candidate) => candidate.criterion === "remote",
    );
    if (reason === undefined) {
      throw new Error(
        "judgeText answered with no remote reason — a bug in judgeText, not a refusal",
      );
    }
    return reason;
  };
  const [remote, onsite, ...byStatus] = await Promise.all([
    store.select<Posting>("postings", { workplace: "remote" }, SCORE_COLUMNS),
    store.select<Posting>("postings", { workplace: "onsite" }, SCORE_COLUMNS),
    // The store's select filters by equality only, so "status is not null"
    // is one select per status value.
    ...STATUSES.map((status) => store.select<Posting>("postings", { status }, SCORE_COLUMNS)),
  ]);
  const rows = [...remote, ...onsite].filter((row) => (row.body ?? "").length > 200);
  const actedOnByKey = new Map<string, Posting>();
  for (const row of byStatus.flat()) {
    actedOnByKey.set(row.key, row);
  }
  printTable(scoreRemote(rows, judge, [...actedOnByKey.values()]));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`score-remote: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
