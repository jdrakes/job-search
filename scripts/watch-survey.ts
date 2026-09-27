// Imports every survey row whose ATS the engine reads: bucket `a` as
// surveyed, and a bucket-`b` row whose ATS has since gained a reader. A
// board another company already carries is recorded as that name's alias,
// otherwise the board is written and the company watched.
//
// The TSV is written by hand and read by column name, not position:
// `name` is the company, `ats` one of `PLATFORMS`, and the board's id
// comes from `slug` or `tenant_url` depending on the platform, since
// three of them spell a board with something no rule derives from a
// name. What to put where, for whoever fills a row in:
//
//   most platforms  `slug`        the company's own board slug
//   workday         `slug`        `tenant/wdN/site`, respelled here
//   eightfold       `tenant_url`  the careers host, path ignored
//   icims           `tenant_url`  the resolved `{slug}.jibeapply.com`
//                                 host, found by opening
//                                 `careers.{company}.com` and following
//                                 the iCIMS redirect to the link its
//                                 page or JS bundle carries. `slug`
//                                 keeps whatever guess was tried, for a
//                                 human auditing the row; it is not read.
//
// A row whose board cannot be formed is reported as malformed rather
// than watched, naming the column that failed.
import { readFile } from "node:fs/promises";
import process from "node:process";

import { READERS } from "../src/ats/readers.ts";
import {
  answering,
  boardIndex,
  watchSurvey,
  wouldBeUnchanged,
  type NamedBoard,
  type WatchSummary,
} from "../src/discovery/bind.ts";
import { describeError } from "../src/errors.ts";
import { PLATFORMS, type Board, type Platform } from "../src/schema.ts";
import { openHostedStore, openStore } from "../src/store/open.ts";

const PLATFORM_SET: ReadonlySet<string> = new Set(PLATFORMS);

function isPlatform(ats: string): ats is Platform {
  return PLATFORM_SET.has(ats);
}

// `slug` is `tenant/wdN/site`; the registry spells the board `wd/site/tenant`
// (`parseWorkdayId` in `src/ats/workday.ts`).
function workdayBoard(slug: string): Board | null {
  const parts = slug.split("/");
  if (parts.length !== 3) return null;
  const [tenant, wd, site] = parts;
  if (!tenant || !wd || !site) return null;
  return { platform: "workday", id: `${wd}/${site}/${tenant}` };
}

// An iCIMS board's real id is a jibeapply.com host that isn't derivable
// from the company's name (a suffix appears, or the punctuation is
// dropped); it can't be probed and is resolved by hand into the survey's
// tenant_url column the same way Eightfold's host is, while `slug` keeps
// whatever guess the automated pass tried and failed (kept for a human
// auditing the row, not read here).
function icimsBoard(tenantUrl: string): Board | null {
  const host = tenantUrl.replace(/^https?:\/\//, "").split("/")[0];
  if (!host || !host.endsWith(".jibeapply.com")) return null;
  const slug = host.slice(0, -".jibeapply.com".length);
  return slug ? { platform: "icims", id: slug } : null;
}

function rowBoard(ats: Platform, slug: string, tenantUrl: string): Board | null {
  if (ats === "workday") return workdayBoard(slug);
  if (ats === "eightfold") {
    const host = tenantUrl.split("/")[0];
    return host ? { platform: "eightfold", id: host } : null;
  }
  if (ats === "icims") return icimsBoard(tenantUrl);
  return slug ? { platform: ats, id: slug } : null;
}

export interface SurveyRows {
  readonly rows: readonly NamedBoard[];
  // A row on a read platform whose board cannot be formed,
  // as `<name>: <ats> <slug or tenant_url>`.
  readonly malformed: readonly string[];
}

export function surveyRows(tsv: string): SurveyRows {
  const lines = tsv.split("\n").filter((line) => line !== "");
  const header = lines[0];
  if (header === undefined) return { rows: [], malformed: [] };
  const columns = header.split("\t");
  const indexOf = (column: string): number => columns.indexOf(column);
  const nameIndex = indexOf("name");
  const atsIndex = indexOf("ats");
  const slugIndex = indexOf("slug");
  const tenantUrlIndex = indexOf("tenant_url");

  const rows: NamedBoard[] = [];
  const malformed: string[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    const name = fields[nameIndex];
    const ats = fields[atsIndex];
    if (name === undefined || ats === undefined) continue;
    if (!isPlatform(ats)) continue;
    const slug = fields[slugIndex] ?? "";
    const tenantUrl = fields[tenantUrlIndex] ?? "";
    const board = rowBoard(ats, slug, tenantUrl);
    if (board === null) {
      const shown = ats === "eightfold" || ats === "icims" ? tenantUrl : slug;
      malformed.push(`${name}: ${ats} ${shown}`.trimEnd());
      continue;
    }
    rows.push({ name, board });
  }
  return { rows, malformed };
}

function printSummary(summary: WatchSummary): void {
  console.log(`  watched: ${summary.watched}`);
  console.log(`  aliases: ${summary.aliases}`);
  console.log(`  unchanged: ${summary.unchanged}`);
  for (const error of summary.errors) {
    console.log(`  error: ${error}`);
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("watch-survey: usage: watch-survey.ts <tsv-path>");
    process.exitCode = 1;
    return;
  }
  const tsv = await readFile(path, "utf8");
  const { rows, malformed } = surveyRows(tsv);

  // Ruling 2: only rows the archive loop would write are checked; a row
  // already unchanged there costs nothing at either store.
  const archive = openStore();
  const index = await boardIndex(archive);
  const toCheck: NamedBoard[] = [];
  const skipped: NamedBoard[] = [];
  for (const row of rows) {
    (wouldBeUnchanged(index, row) ? skipped : toCheck).push(row);
  }
  const { rows: kept, gone, unreachable } = await answering(toCheck, READERS);
  const watchable = [...kept, ...skipped];

  console.log("archive:");
  printSummary(await watchSurvey(archive, watchable, "survey"));

  const hosted = openHostedStore();
  if (hosted === null) {
    console.log("hosted: not configured");
  } else {
    console.log("hosted:");
    printSummary(await watchSurvey(hosted, watchable, "survey"));
  }

  console.log(`gone (not watched): ${gone.length}`);
  for (const entry of gone) console.log(`  ${entry.line}`);
  console.log(`unreachable (not watched, re-run): ${unreachable.length}`);
  for (const line of unreachable) console.log(`  ${line}`);

  for (const entry of malformed) {
    console.log(`malformed: ${entry}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`watch-survey: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
