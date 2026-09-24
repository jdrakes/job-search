// Runs every discovery source over the registry. A name already in
// `companies` is never probed again: the probe costs requests. The state
// transition (a fresh name with a board becomes `watched`, one with none
// stays `discovered`) is written directly through `Store`: it only ever
// reaches a row this call just created, so it can never turn an alias back
// into a company.
import { aliased, boardKey, seen } from "./companies.ts";
import { probe } from "./discovery/probe.ts";
import type { Source } from "./discovery/source.ts";
import { describeError } from "./errors.ts";
import type { HttpOptions } from "./net/http.ts";
import type { Company } from "./schema.ts";
import type { Store } from "./store/store.ts";

export interface DiscoverResult {
  readonly seen: number;
  readonly probed: number;
  readonly watched: number;
  readonly aliases: number;
  readonly errors: readonly string[];
}

interface KnownCompanies {
  readonly names: Set<string>;
  readonly byBoard: Map<string, string>;
}

// Every name the registry holds, whatever its state, plus an index from
// board identity to the company carrying it, both read once rather than one
// `select` per candidate (the sources name a few thousand a run). An alias
// must stay an alias rather than be revived by a sighting; a board already
// recorded under any company is the same board, so a second name answering
// with it is that company's alias.
async function knownCompanies(store: Store): Promise<KnownCompanies> {
  const rows = await store.select<Company>("companies");
  const byBoard = new Map<string, string>();
  for (const row of rows) {
    for (const board of row.boards) {
      byBoard.set(boardKey(board), row.name);
    }
  }
  return { names: new Set(rows.map((row) => row.name)), byBoard };
}

export async function discover(
  store: Store,
  sources: readonly Source[],
  options?: HttpOptions,
): Promise<DiscoverResult> {
  const errors: string[] = [];
  const { names: known, byBoard } = await knownCompanies(store);
  let seenCount = 0;
  let probed = 0;
  let watched = 0;
  let aliases = 0;

  for (const source of sources) {
    let names: readonly string[];
    try {
      names = await source.companies(options);
    } catch (err) {
      errors.push(`${source.name}: ${describeError(err)}`);
      continue;
    }

    // Serial, and it must stay serial. `probe` already asks all of its
    // platforms at once, which is safe because they are all different hosts
    // and net/http.ts rate-limits per host. Two names probed at once would
    // share every one of those hosts: `rateLimit` reads a host's `lastAt`,
    // sleeps, then writes it, so both would compute the same delay and fire
    // together.
    for (const name of names) {
      seenCount += 1;
      if (known.has(name)) continue;

      probed += 1;
      let boards;
      try {
        boards = await probe(name, options);
      } catch (err) {
        errors.push(`${source.name} ${name}: ${describeError(err)}`);
        continue;
      }

      // A board another company already carries means this name is that
      // company: `aliased` records it directly, rather than `seen`, which
      // would first land it `discovered`.
      let aliasOf: string | null = null;
      for (const board of boards) {
        const owner = byBoard.get(boardKey(board));
        if (owner !== undefined) {
          aliasOf = owner;
          break;
        }
      }
      if (aliasOf !== null) {
        await aliased(store, name, source.name, boards, aliasOf);
        aliases += 1;
        known.add(name);
        continue;
      }

      await seen(store, name, source.name, boards);
      // Added here, not at the `probed` count, so a name whose probe threw
      // gets another chance. The board index learns this name's boards too:
      // a second spelling in the same run ("Acme Inc", then "Acme") is an
      // alias the index read before the loop cannot know.
      known.add(name);
      for (const board of boards) {
        byBoard.set(boardKey(board), name);
      }

      if (boards.length > 0) {
        const result = await store.update("companies", name, { state: "watched" });
        if (result.ok) {
          watched += 1;
        } else {
          errors.push(`${source.name} ${name}: ${result.reason}`);
        }
      }
    }
  }

  return { seen: seenCount, probed, watched, aliases, errors };
}
