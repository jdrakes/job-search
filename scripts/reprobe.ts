// Clears the backlog of boardless discovered names against platforms the
// probe has gained since those names were first seen.
//
// `src/discover.ts` skips any name already in the store, so a company
// discovered before a platform existed can never reach that platform's
// reader. Probing every known name every morning would cost the daily
// hours for a few percent yield, so the backlog is cleared by hand, here,
// and only against the platforms added since: asking a vendor a question
// already answered, once per name, is what earned the tool a Workable
// block on 2026-09-22 (~6,400 needless requests over 3,189 names, 77
// boards unread that evening, a daily run killed).
//
// That is why the platform list is a required argument with no default.
// There is deliberately no way to invoke this that probes everything.
//
//   npm run reprobe -- rippling,breezy
//
// It writes the archive store only, the same one `discover` writes; the
// daily's publish phase carries the rows to the hosted store.
import process from "node:process";

import { aliased, boardKey, seen } from "../src/companies.ts";
import { probe, SLUG_PLATFORMS, type SlugPlatform } from "../src/discovery/probe.ts";
import { describeError } from "../src/errors.ts";
import { HttpError, type HttpOptions } from "../src/net/http.ts";
import { PLATFORMS, type Company, type ReprobeRun } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

const PLATFORM_SET: ReadonlySet<string> = new Set(PLATFORMS);
const SLUG_SET: ReadonlySet<string> = new Set(SLUG_PLATFORMS);

function isSlugPlatform(name: string): name is SlugPlatform {
  return SLUG_SET.has(name);
}

const USAGE = "usage: npm run reprobe -- <platform>[,<platform>...]";
const PROBEABLE = `slug-probeable platforms: ${SLUG_PLATFORMS.join(", ")}`;

export type ParsedPlatforms =
  | { readonly ok: true; readonly platforms: readonly SlugPlatform[] }
  | { readonly ok: false; readonly message: string };

// Every refusal names the problem and lists what can be asked. A platform
// outside SLUG_PLATFORMS is refused rather than quietly dropped: Workday,
// Eightfold, Amazon, iCIMS, Personio and BambooHR spell a board with
// something no rule derives from a company's name, so a run naming one of
// them would probe nothing and report it as a clean pass.
export function parsePlatforms(argument: string | undefined): ParsedPlatforms {
  const names = (argument ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    return { ok: false, message: `no platform named. ${USAGE}. ${PROBEABLE}` };
  }

  const platforms: SlugPlatform[] = [];
  for (const name of names) {
    if (!PLATFORM_SET.has(name)) {
      return { ok: false, message: `"${name}" is not a platform. ${PROBEABLE}` };
    }
    if (!isSlugPlatform(name)) {
      return {
        ok: false,
        message:
          `"${name}" cannot be probed: its board id is not derivable from a company name, ` +
          `so it is reached by the survey (scripts/watch-survey.ts), not by slug-guessing. ${PROBEABLE}`,
      };
    }
    if (!platforms.includes(name)) platforms.push(name);
  }
  return { ok: true, platforms };
}

// The backlog: `discovered` names, which is every name probed and found no
// board for. A company James dropped stays dropped - the drop is his
// decision, and a pass that probed it would write it back as `watched` and
// undo him - so `dropped_at IS NULL` is part of the selection, not a filter
// applied later.
export async function backlog(store: Store): Promise<string[]> {
  const rows = await store.select<Company>("companies", { state: "discovered", dropped_at: null });
  return rows.map((row) => row.name);
}

// The platform list as one comparable string: sorted, so a pass naming
// "breezy,rippling" and one naming "rippling,breezy" are the same pass.
export function platformsKey(platforms: readonly SlugPlatform[]): string {
  return [...platforms].sort().join(",");
}

// Every prior pass over exactly these platforms, oldest first. `started`
// is the primary key and an ISO timestamp, so the store's own key order is
// chronological and nothing here has to sort.
export async function priorRuns(
  store: Store,
  platforms: readonly SlugPlatform[],
): Promise<ReprobeRun[]> {
  return store.select<ReprobeRun>("reprobe_runs", { platforms: platformsKey(platforms) });
}

// Where a pass over these platforms should start. A run that a vendor
// refused left `refused_at` on the name it stopped at, and that name was
// never answered, so the next pass starts there rather than at the top: a
// refusal at name 40 of 3,132 otherwise means every later attempt re-walks
// the same 40 and stops again, which is what made the Workable backlog
// unreachable on 2026-09-23.
//
// The latest run wins whatever it says. A finished run leaves null and the
// next pass starts from the top, which is right: it is a fresh sweep, and
// the caller has already been told the platforms were cleared.
export function resumeFrom(runs: readonly ReprobeRun[]): string | null {
  return runs.at(-1)?.refused_at ?? null;
}

export interface ReprobeSummary {
  readonly probed: number;
  readonly watched: number;
  readonly aliases: number;
  readonly errors: readonly string[];
  // The name the pass stopped on, when a vendor refused to answer. A pass
  // that ran to the end of its names reports null. It is not an error
  // count: it says the remaining names were never asked, so nothing may
  // read this pass as having cleared them.
  readonly refusedAt: string | null;
}

// Board identity to the company carrying it, read once: the pass walks
// thousands of names and a board already recorded under any company is the
// same board.
async function boardOwners(store: Store): Promise<Map<string, string>> {
  const rows = await store.select<Company>("companies");
  const owners = new Map<string, string>();
  for (const row of rows) {
    for (const board of row.boards) owners.set(boardKey(board), row.name);
  }
  return owners;
}

// Printed every this many names: the pass runs for hours and a silent
// terminal is indistinguishable from a hung one.
const PROGRESS_EVERY = 25;

// Serial, and it must stay serial, for the reason discover.ts's own loop
// states: `probe` asks its platforms at once because they are different
// hosts and net/http.ts rate-limits per host, but two names probed at once
// would share every one of those hosts.
export async function reprobe(
  store: Store,
  names: readonly string[],
  platforms: readonly SlugPlatform[],
  options?: HttpOptions,
): Promise<ReprobeSummary> {
  const owners = await boardOwners(store);
  const errors: string[] = [];
  let probed = 0;
  let watched = 0;
  let aliases = 0;

  for (const name of names) {
    probed += 1;
    if (probed % PROGRESS_EVERY === 0) {
      console.log(`  ${probed}/${names.length}: ${watched} watched, ${aliases} aliased`);
    }

    let boards;
    try {
      boards = await probe(name, options, platforms);
    } catch (error) {
      // A refusal ends the pass. Every name after this one would be asked
      // of the same host that just declined, and `probe` would keep
      // throwing; grinding through thousands of them buys nothing and
      // deepens the block. Stopping also keeps the summary honest: the
      // names after this one were never asked, and a pass that reported
      // them as clean would be the exact defect this replaces.
      if (error instanceof HttpError && error.status === 429) {
        return { probed, watched, aliases, errors, refusedAt: name };
      }
      errors.push(`${name}: ${describeError(error)}`);
      continue;
    }

    // A board another company already carries means this name is that
    // company, recorded directly as an alias rather than through `seen`.
    // Unlike discover.ts, where the name is new, every name here is already
    // on file: a board the name itself carries names no owner but itself,
    // and taking it would record the company as its own alias.
    let aliasOf: string | null = null;
    for (const board of boards) {
      const owner = owners.get(boardKey(board));
      if (owner !== undefined && owner !== name) {
        aliasOf = owner;
        break;
      }
    }
    if (aliasOf !== null) {
      await aliased(store, name, "reprobe", boards, aliasOf);
      aliases += 1;
      continue;
    }

    await seen(store, name, "reprobe", boards);
    for (const board of boards) owners.set(boardKey(board), name);

    if (boards.length > 0) {
      const result = await store.update("companies", name, { state: "watched" });
      if (result.ok) {
        watched += 1;
      } else {
        errors.push(`${name}: ${result.reason}`);
      }
    }
  }

  return { probed, watched, aliases, errors, refusedAt: null };
}

async function main(): Promise<void> {
  const parsed = parsePlatforms(process.argv[2]);
  if (!parsed.ok) {
    console.error(`reprobe: ${parsed.message}`);
    process.exitCode = 1;
    return;
  }

  const store = openStore();

  // What this pass already knows before it spends anything. On 2026-09-23
  // a pass re-asked six platforms the backlog had been cleared against the
  // day before, ~14,000 vendor requests, because its only record was a
  // terminal log in a session that had ended.
  const runs = await priorRuns(store, parsed.platforms);
  for (const run of runs) {
    const ended =
      run.finished === null
        ? "never finished (killed)"
        : run.refused_at === null
          ? "finished"
          : `refused at "${run.refused_at}"`;
    console.log(
      `prior pass ${run.started}: ${run.probed}/${run.names} names, ` +
        `${run.watched} watched, ${run.aliases} aliased, ${run.errors} errors, ${ended}`,
    );
  }
  if (runs.some((run) => run.finished !== null && run.refused_at === null)) {
    console.log(
      `NOTE: ${platformsKey(parsed.platforms)} has been swept to the end before. ` +
        `Re-running finds only what has changed since.`,
    );
  }

  const all = await backlog(store);
  const from = resumeFrom(runs);
  const start = from === null ? 0 : all.indexOf(from);
  // A resume point that is no longer in the backlog means the name was
  // bound or dropped since; starting from the top is the safe reading, and
  // the line above it says so rather than silently skipping names.
  const names = start > 0 ? all.slice(start) : all;
  if (from !== null) {
    console.log(
      start > 0
        ? `resuming at "${from}", ${names.length} of ${all.length} names left`
        : `"${from}" is no longer in the backlog; starting from the top`,
    );
  }

  console.log(`reprobe: ${names.length} discovered names against ${parsed.platforms.join(", ")}`);

  const started = new Date().toISOString();
  await store.upsert("reprobe_runs", [
    {
      started,
      platforms: platformsKey(parsed.platforms),
      names: names.length,
      probed: 0,
      watched: 0,
      aliases: 0,
      errors: 0,
      refused_at: null,
      finished: null,
    } satisfies ReprobeRun,
  ]);

  const summary = await reprobe(store, names, parsed.platforms);

  // Written whatever the outcome, and `finished` is what separates a pass
  // that ended from one that was killed: a killed pass leaves the row it
  // wrote above, with finished null, so it can never be read as a sweep.
  await store.update("reprobe_runs", started, {
    probed: summary.probed,
    watched: summary.watched,
    aliases: summary.aliases,
    errors: summary.errors.length,
    refused_at: summary.refusedAt,
    finished: new Date().toISOString(),
  });

  console.log(`probed: ${summary.probed}`);
  console.log(`watched: ${summary.watched}`);
  console.log(`aliases: ${summary.aliases}`);
  console.log(`errors: ${summary.errors.length}`);
  for (const error of summary.errors) console.log(`  ${error}`);

  // Loud, and a non-zero exit: a refused pass looks exactly like a clean
  // one in its counts, and the whole point of this change is that nobody
  // reads it as having cleared the names it never asked about.
  if (summary.refusedAt !== null) {
    const remaining = names.length - summary.probed;
    console.error(
      `\nSTOPPED: a vendor answered 429 at "${summary.refusedAt}". ` +
        `${remaining} of ${names.length} names were never asked, so this pass ` +
        `has NOT cleared ${parsed.platforms.join(", ")}. Re-run it once the ` +
        `rate limit lifts.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`reprobe: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
