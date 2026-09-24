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

import type { Reader } from "../src/ats/ats.ts";
import { READERS } from "../src/ats/readers.ts";
import { aliased, boardKey, isGone, seen } from "../src/companies.ts";
import { describeError } from "../src/errors.ts";
import type { HttpOptions } from "../src/net/http.ts";
import { PLATFORMS, type Board, type Company, type Platform } from "../src/schema.ts";
import { openHostedStore, openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

export interface SurveyRow {
  readonly name: string;
  readonly board: Board;
}

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
  readonly rows: readonly SurveyRow[];
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

  const rows: SurveyRow[] = [];
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

export interface WatchSummary {
  readonly watched: number;
  readonly aliases: number;
  readonly unchanged: number;
  readonly errors: readonly string[];
}

interface BoardIndex {
  // boardKey -> every company carrying it that is not an alias; a row's owner is
  // any of them other than the row's own name.
  readonly carriers: Map<string, Set<string>>;
  // name -> the company row on file, for the state-aware unchanged check.
  readonly companies: Map<string, Company>;
}

async function boardIndex(store: Store): Promise<BoardIndex> {
  const rows = await store.select<Company>("companies");
  const carriers = new Map<string, Set<string>>();
  const companies = new Map<string, Company>();
  for (const row of rows) {
    companies.set(row.name, row);
    if (row.state !== "alias") {
      for (const board of row.boards) {
        addCarrier(carriers, boardKey(board), row.name);
      }
    }
  }
  return { carriers, companies };
}

function addCarrier(carriers: Map<string, Set<string>>, key: string, name: string): void {
  const names = carriers.get(key);
  if (names === undefined) carriers.set(key, new Set([name]));
  else names.add(name);
}

function ownerOf(carriers: Map<string, Set<string>>, key: string, name: string): string | null {
  for (const carrier of carriers.get(key) ?? []) {
    if (carrier !== name) return carrier;
  }
  return null;
}

function carriesBoard(company: Company, key: string): boolean {
  return company.boards.some((board) => boardKey(board) === key);
}

// The two branches under which `watchSurvey`'s loop leaves a row untouched:
// an alias on file is never revived, and a watched company already
// carrying the row's board (and not itself another company's board, which
// would make it that company's alias instead) gains nothing from being
// written again. Shared with `main`'s pre-pass, so `answering` below is
// asked only about rows a write would actually touch.
function wouldBeUnchanged(index: BoardIndex, row: SurveyRow): boolean {
  const key = boardKey(row.board);
  const existing = index.companies.get(row.name);
  if (existing === undefined) return false;
  if (existing.state === "alias") return true;
  const owner = ownerOf(index.carriers, key, row.name);
  return owner === null && existing.state === "watched" && carriesBoard(existing, key);
}

// Refetches the row a write just produced, to keep "on file" current.
async function refresh(store: Store, companies: Map<string, Company>, name: string): Promise<void> {
  const [row] = await store.select<Company>("companies", { name });
  if (row !== undefined) companies.set(name, row);
}

export async function watchSurvey(store: Store, rows: readonly SurveyRow[]): Promise<WatchSummary> {
  const { carriers, companies } = await boardIndex(store);
  const errors: string[] = [];
  let watched = 0;
  let aliases = 0;
  let unchanged = 0;

  for (const row of rows) {
    const key = boardKey(row.board);

    // See wouldBeUnchanged.
    if (wouldBeUnchanged({ carriers, companies }, row)) {
      unchanged += 1;
      continue;
    }

    const owner = ownerOf(carriers, key, row.name);
    if (owner !== null) {
      await aliased(store, row.name, "survey", [row.board], owner);
      aliases += 1;
      await refresh(store, companies, row.name);
      continue;
    }

    await seen(store, row.name, "survey", [row.board]);
    const result = await store.update("companies", row.name, { state: "watched" });
    if (result.ok) {
      watched += 1;
    } else {
      errors.push(`${row.name}: ${result.reason}`);
    }
    addCarrier(carriers, key, row.name);
    await refresh(store, companies, row.name);
  }

  return { watched, aliases, unchanged, errors };
}

// The probe watches only a slug that answers; the survey wrote its rows by
// hand from careers pages that may since have moved, and the store keeps
// nothing about a board a company lost. So each board is asked once
// before either store is written. Gone and unreachable are told apart so
// a bad morning at the vendor is re-run, not recorded.
export async function answering(
  rows: readonly SurveyRow[],
  readers: Partial<Record<Platform, Reader>>,
  options?: HttpOptions,
): Promise<{ rows: SurveyRow[]; gone: string[]; unreachable: string[] }> {
  const kept: SurveyRow[] = [];
  const gone: string[] = [];
  const unreachable: string[] = [];
  for (const row of rows) {
    const reader = readers[row.board.platform];
    if (reader === undefined) {
      unreachable.push(`${row.name} ${boardKey(row.board)}: no reader`);
      continue;
    }
    try {
      await reader.list(row.board, options);
      kept.push(row);
    } catch (error) {
      const line = `${row.name} ${boardKey(row.board)}: ${describeError(error)}`;
      if (isGone(row.board.platform, error)) gone.push(line);
      else unreachable.push(line);
    }
  }
  return { rows: kept, gone, unreachable };
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
  const toCheck: SurveyRow[] = [];
  const skipped: SurveyRow[] = [];
  for (const row of rows) {
    (wouldBeUnchanged(index, row) ? skipped : toCheck).push(row);
  }
  const { rows: kept, gone, unreachable } = await answering(toCheck, READERS);
  const watchable = [...kept, ...skipped];

  console.log("archive:");
  printSummary(await watchSurvey(archive, watchable));

  const hosted = openHostedStore();
  if (hosted === null) {
    console.log("hosted: not configured");
  } else {
    console.log("hosted:");
    printSummary(await watchSurvey(hosted, watchable));
  }

  console.log(`gone (not watched): ${gone.length}`);
  for (const line of gone) console.log(`  ${line}`);
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
