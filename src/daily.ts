// Entry point for the scheduled run, once each weekday. Each phase is wrapped in `phase` so the log carries its wall
// clock and its HTTP and store request counts.
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { boardsOf, readable } from "./companies.ts";
import { loadCriteria } from "./criteria.ts";
import { discover, type DiscoverResult, unbind, type Unbound } from "./discover.ts";
import { builtInSource } from "./discovery/builtin.ts";
import { commonCrawlSource } from "./discovery/commoncrawl.ts";
import { hnSource } from "./discovery/hn.ts";
import { remoteOkSource } from "./discovery/remoteok.ts";
import type { DiscoverySource, Source } from "./discovery/source.ts";
import { theMuseSource } from "./discovery/themuse.ts";
import { weWorkRemotelySource } from "./discovery/weworkremotely.ts";
import { describeError } from "./errors.ts";
import { ingest, judgeAll } from "./ingest.ts";
import { phase } from "./phase.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { openStore } from "./store/open.ts";
import type { Store } from "./store/store.ts";

import type { DetailRead, Reader } from "./ats/ats.ts";
import { READERS, withDetailReads } from "./ats/readers.ts";
import { OUTCOMES, type Platform } from "./schema.ts";

const SOURCES: readonly DiscoverySource[] = [
  hnSource,
  remoteOkSource,
  weWorkRemotelySource,
  builtInSource,
  theMuseSource,
  commonCrawlSource,
];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Absent `discoverySources` runs every source, matching the tree before
// settings existed. A name settings lists that no source carries is an
// operator's typo, not a source to silently skip, so it throws naming the
// valid names rather than running a shorter list than the operator asked
// for.
export function selectSources(
  sources: readonly DiscoverySource[],
  discoverySources: Settings["discoverySources"],
): readonly DiscoverySource[] {
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
// and the rest of the run proceeds; judging reports the missing row itself,
// so refusing here would only stop discovery and ingestion as well. An
// unknown source name and
// a module path that will not resolve stay loud: neither is recoverable by
// running again.
export async function resolveSources(
  sources: readonly DiscoverySource[],
  settings: Settings,
  store: Store,
  log: (line: string) => void = console.log,
): Promise<readonly DiscoverySource[]> {
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

function isDetailRead(value: unknown): value is DetailRead {
  if (typeof value !== "object" || value === null) return false;
  const read = value as Record<string, unknown>;
  return (
    typeof read["platform"] === "string" &&
    read["platform"] in READERS &&
    typeof read["board"] === "string" &&
    typeof read["body"] === "function"
  );
}

// `extraDetailPath` names a module whose default export is an array of
// `DetailRead`s: a board the operator reads a second time, from a page this
// project does not ship a reader for. Absent, the readers are the shipped
// ones. A path that will not import, or an export of the wrong shape, throws
// naming the path: a read the operator configured and the run silently
// skipped would judge that board's postings without the facts it exists for.
export async function resolveReaders(
  settings: Settings,
  readers: Record<Platform, Reader> = READERS,
): Promise<Record<Platform, Reader>> {
  const path = settings.extraDetailPath;
  if (path === undefined) return readers;
  const resolvedPath = resolve(REPO_ROOT, path);
  let module: { default?: unknown };
  try {
    module = (await import(resolvedPath)) as { default?: unknown };
  } catch (error) {
    throw new Error(
      `settings: extraDetailPath "${path}" (resolved to ${resolvedPath}) ` +
        `could not be imported: ${describeError(error)}`,
    );
  }
  const reads = module.default;
  if (!Array.isArray(reads) || !reads.every(isDetailRead)) {
    throw new Error(
      `settings: extraDetailPath "${path}" must have a default export that is an array of ` +
        "detail reads, each naming a shipped platform, a board and a body function",
    );
  }
  return withDetailReads(readers, reads);
}

// Every outcome is named, zeros included, in the schema's order, so two
// mornings' lines line up.
export function discoverLine(result: DiscoverResult): string {
  const outcomes = OUTCOMES.map((outcome) => `${result.resolved[outcome]} ${outcome}`);
  return (
    `discover: ${result.suggested} suggested, ${outcomes.join(", ")}, ` +
    `${result.pending} pending, ${result.errors.length} errors`
  );
}

// The count line, then each company left with no board (what the list
// phase's old `returned:` line named), then each refused removal.
export function unbindLines(result: Unbound): string[] {
  return [
    `unbind: ${result.removed} boards removed, ${result.suggested} suggested, ` +
      `${result.errors.length} errors`,
    ...result.boardless.map((name) => `  no board left: ${name}`),
    ...result.errors.map((error) => `  ${error}`),
  ];
}

async function main(): Promise<number> {
  const store = openStore();
  const settings = loadSettings();

  // An extra source is searched for the criteria's level words, so the row is
  // read here. `ingest` reads it again for judging; two reads of one row beat
  // threading it through.
  const sources = await resolveSources(SOURCES, settings, store);
  const readers = await resolveReaders(settings);

  // Before ingestion: a company discovery watches this morning is read this
  // morning. Wrapped, so discovery failing costs no watched company its
  // read.
  try {
    const discovered = await phase(
      "discover",
      () => discover(store, sources, undefined, readers, console.log),
      console.log,
    );
    console.log(discoverLine(discovered));
    for (const error of discovered.errors) {
      console.log(`  ${error}`);
    }
  } catch (error) {
    console.error(`discover failed, ingesting anyway: ${describeError(error)}`);
  }

  // Read separately from `ingest`'s own call to `readable`: the only way to
  // tell "every board failed" from "some boards listed zero postings".
  const companies = await readable(store);
  const totalBoards = companies.reduce((sum, company) => sum + boardsOf(company).length, 0);

  const result = await phase("list", () => ingest(store, readers), console.log);

  console.log(
    `ingest: ${result.companies} companies, ${result.listed} listed, ${result.recorded} recorded, ` +
      `${result.errors.length} errors, ${result.gone.length} gone`,
  );
  for (const error of result.errors) {
    console.log(`  ${error}`);
  }

  // Before judging, so the Gone and Unwatched criteria see the boards as
  // they now stand. A company that lost a board is suggested again by name
  // before any board is removed, so it is probed fresh the next morning like
  // any other candidate (`resolveName`, discover.ts) instead of staying
  // unwatched for good. Every failure is returned, never thrown, so it costs
  // the morning its unbinding, not its judging: a refused suggestion removes
  // nothing, and a refused removal leaves that one company's boards bound.
  // A board left bound answers gone again tomorrow and is handed back again.
  const unbound = await phase("unbind", () => unbind(store, result.gone), console.log);
  if (unbound.ok) {
    for (const line of unbindLines(unbound.value)) console.log(line);
  } else {
    console.error(`unbind failed, every board left bound, judging anyway: ${unbound.reason}`);
  }

  // Every HTTP request this phase makes is a body fetch.
  const judging = await phase("judge", () => judgeAll(store, readers), console.log);
  console.log(`judge: ${judging.judged} judged, ${judging.errors.length} errors`);
  for (const error of judging.errors) {
    console.log(`  ${error}`);
  }

  // A silent nothing-happened must be visible. Listing errors only: judging
  // has its own count above.
  const everyBoardFailed = totalBoards > 0 && result.errors.length >= totalBoards;
  return result.companies === 0 || everyBoardFailed ? 1 : 0;
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
