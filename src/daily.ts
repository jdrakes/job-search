// Entry point for the scheduled run, once each weekday. Each phase is wrapped in `phase` so the log carries its wall
// clock and its HTTP and store request counts.
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { boardsOf, watched } from "./companies.ts";
import { loadCriteria } from "./criteria.ts";
import { discover } from "./discover.ts";
import { builtInSource } from "./discovery/builtin.ts";
import { hnSource } from "./discovery/hn.ts";
import { remoteOkSource } from "./discovery/remoteok.ts";
import type { Source } from "./discovery/source.ts";
import { theMuseSource } from "./discovery/themuse.ts";
import { weWorkRemotelySource } from "./discovery/weworkremotely.ts";
import { describeError } from "./errors.ts";
import { ingest, judgeAll } from "./ingest.ts";
import { phase } from "./phase.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { openHostedStore, openStore } from "./store/open.ts";
import type { Store } from "./store/store.ts";
import { publishSlice, pullDecisions } from "./sync.ts";

import { READERS } from "./ats/readers.ts";

const SOURCES = [hnSource, remoteOkSource, weWorkRemotelySource, builtInSource, theMuseSource];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Absent `discoverySources` runs every source, matching the tree before
// settings existed. A name settings lists that no source carries is an
// operator's typo, not a source to silently skip, so it throws naming the
// valid names rather than running a shorter list than the operator asked
// for.
export function selectSources(
  sources: readonly Source[],
  discoverySources: Settings["discoverySources"],
): readonly Source[] {
  if (discoverySources === undefined) return sources;
  const byName = new Map(sources.map((source) => [source.name, source] as const));
  return discoverySources.map((name) => {
    const source = byName.get(name);
    if (source === undefined) {
      const valid = sources.map((candidate) => candidate.name).join(", ");
      throw new Error(
        `settings: discoverySources names unknown source "${name}" (valid: ${valid})`,
      );
    }
    return source;
  });
}

// `extraSourcePath` names a module whose default export is a factory taking
// `level_words` and returning a `Source`. It takes the criteria's level words
// because a source that searches by keyword needs to know what to search for,
// which the shipped sources read from the same place. An operator adds a
// source this project does not ship without carrying a patch.
async function loadExtraSource(
  extraSourcePath: string,
  levelWords: readonly string[],
): Promise<Source> {
  const resolvedPath = resolve(REPO_ROOT, extraSourcePath);
  let module: { default?: unknown };
  try {
    module = (await import(resolvedPath)) as { default?: unknown };
  } catch (error) {
    throw new Error(
      `settings: extraSourcePath "${extraSourcePath}" (resolved to ${resolvedPath}) ` +
        `could not be imported: ${describeError(error)}`,
    );
  }
  if (typeof module.default !== "function") {
    throw new Error(
      `settings: extraSourcePath "${extraSourcePath}" must have a default export that is a ` +
        "factory function taking level_words and returning a discovery source",
    );
  }
  const factory = module.default as (words: readonly string[]) => Source | Promise<Source>;
  return factory(levelWords);
}

// Filters `sources` per settings, then appends the extra source when one is
// configured. The extra source's factory needs criteria, which nothing else
// in this run loads before `judgeAll`, so this loads it itself, only when
// `extraSourcePath` is set.
//
// A criteria row that cannot be read is a runtime condition rather than an
// operator's mistake, so the extra source is skipped and the reason logged
// and the rest of the run proceeds. On a two-store install whose only row
// lives in the hosted store, refusing here would stop discovery, ingestion
// and judging over a row the next pull supplies. An unknown source name and
// a module path that will not resolve stay loud: neither is recoverable by
// running again.
export async function resolveSources(
  sources: readonly Source[],
  settings: Settings,
  store: Store,
  log: (line: string) => void = console.log,
): Promise<readonly Source[]> {
  const selected = selectSources(sources, settings.discoverySources);
  if (settings.extraSourcePath === undefined) return selected;

  const criteriaResult = await loadCriteria(store);
  if (!criteriaResult.ok) {
    log(`discover: extra source skipped, ${criteriaResult.reason}`);
    return selected;
  }

  const extra = await loadExtraSource(settings.extraSourcePath, criteriaResult.value.level_words);
  return [...selected, extra];
}

async function main(): Promise<number> {
  const store = openStore();
  const settings = loadSettings();

  // Before discovery: a company James dropped in the list has to be dropped
  // locally before discovery decides what to watch. Not wrapped: a pull
  // that fails stops the run here, loudly.
  const hosted = openHostedStore();
  if (hosted === null) {
    console.log("pull: skipped, no second store to pull from");
  } else {
    const pulled = await phase("pull", () => pullDecisions(store, hosted), console.log);
    console.log(
      `pull: ${pulled.statuses} statuses, ${pulled.companies} company states, ` +
        `criteria ${pulled.hasCriteria ? "pulled" : "absent"}, ${pulled.skipped} skipped`,
    );
  }

  // An extra source is searched for the criteria's level words, so the row is
  // read here, after the pull that may have changed it. `ingest` reads it
  // again for judging; two reads of one row beat threading it through. Read
  // before the pull instead, an edit made in the Criteria view would not
  // reach the extra source until the run after next.
  const sources = await resolveSources(SOURCES, settings, store);

  // Before ingestion: a company discovery watches this morning is read this
  // morning. Wrapped, so discovery failing costs no watched company its
  // read.
  try {
    const discovered = await phase("discover", () => discover(store, sources), console.log);
    console.log(
      `discover: ${discovered.seen} seen, ${discovered.probed} probed, ` +
        `${discovered.watched} watched, ${discovered.aliases} aliases, ${discovered.errors.length} errors`,
    );
    for (const error of discovered.errors) {
      console.log(`  ${error}`);
    }
  } catch (error) {
    console.error(`discover failed, ingesting anyway: ${describeError(error)}`);
  }

  // Read separately from `ingest`'s own call to `watched`: the only way to
  // tell "every board failed" from "some boards listed zero postings".
  const companies = await watched(store);
  const totalBoards = companies.reduce((sum, company) => sum + boardsOf(company).length, 0);

  const result = await phase("list", () => ingest(store, READERS), console.log);

  console.log(
    `ingest: ${result.companies} companies, ${result.listed} listed, ${result.recorded} recorded, ` +
      `${result.errors.length} errors, ${result.returned.length} returned`,
  );
  for (const error of result.errors) {
    console.log(`  ${error}`);
  }
  for (const line of result.returned) {
    console.log(`  returned: ${line}`);
  }

  // Every HTTP request this phase makes is a body fetch.
  const judging = await phase("judge", () => judgeAll(store, READERS), console.log);
  console.log(`judge: ${judging.judged} judged, ${judging.errors.length} errors`);
  for (const error of judging.errors) {
    console.log(`  ${error}`);
  }

  // Last, because it publishes what judging just decided. Skipped with no
  // second store: one store is already the one the list reads. Wrapped and
  // reported rather than thrown: the day's work is already in the store of
  // record, and a failed publish costs the list a day of freshness and the
  // run its exit code.
  let publishFailed = false;
  if (hosted !== null) {
    try {
      const published = await phase("publish", () => publishSlice(store, hosted), console.log);
      console.log(
        `publish: ${published.postings} postings, ${published.companies} companies, ` +
          `${published.removed} removed`,
      );
    } catch (error) {
      publishFailed = true;
      console.error(`publish failed, the list keeps yesterday's: ${describeError(error)}`);
    }
  }

  // A silent nothing-happened must be visible. Listing errors only: judging
  // has its own count above.
  const everyBoardFailed = totalBoards > 0 && result.errors.length >= totalBoards;
  return result.companies === 0 || everyBoardFailed || publishFailed ? 1 : 0;
}

// The one place that catches: a run whose first store read times out
// otherwise dies as an unhandled rejection, a stack trace where the log
// needs a sentence. Guarded so tests can import `resolveSources` and
// `selectSources` without running the whole daily entry point.
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Refusing: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
