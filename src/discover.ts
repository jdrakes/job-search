// Runs every discovery source over the registry. A name already in
// `companies` is never probed again: the probe costs requests. The state
// transition (a fresh name with a board becomes `watched`, one with none
// stays `discovered`) is written directly through `Store`: it only ever
// reaches a row this call just created, so it can never turn an alias back
// into a company.
//
// A board source names boards, not companies. Its rule: a board already
// carried is skipped, the rest are asked once, and a board whose company
// name matches one on file (in any state) joins that company, so a board
// never creates a second record for a company already there. Every write
// it makes is one log line.
import type { Reader } from "./ats/ats.ts";
import { READERS } from "./ats/readers.ts";
import { aliased, boardKey, seen } from "./companies.ts";
import { answering, watchSurvey, type NamedBoard } from "./discovery/bind.ts";
import { probe } from "./discovery/probe.ts";
import type { BoardSource, DiscoverySource } from "./discovery/source.ts";
import { describeError } from "./errors.ts";
import type { HttpOptions } from "./net/http.ts";
import type { Company, Platform } from "./schema.ts";
import type { Store } from "./store/store.ts";

export interface DiscoverResult {
  readonly seen: number;
  readonly probed: number;
  readonly watched: number;
  readonly aliases: number;
  readonly errors: readonly string[];
}

type NameEntry = Pick<Company, "name" | "state" | "alias_of">;

interface KnownCompanies {
  readonly names: Set<string>;
  readonly byBoard: Map<string, string>;
  // squashName(name) -> the company on file by that name, whatever its state.
  readonly byName: Map<string, NameEntry>;
}

// Letters and digits only, lowercased: the same rule `probe.ts`'s local
// `squash` uses, kept here too since a company name is not a board slug and
// does not belong in the probe.
function squashName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A name with no letter or digit (one written wholly in another script)
// squashes to "", and "" would match every other such name, so it is never
// indexed and never matches.
function indexName(byName: Map<string, NameEntry>, entry: NameEntry): void {
  const key = squashName(entry.name);
  if (key !== "") byName.set(key, entry);
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
  const byName = new Map<string, NameEntry>();
  for (const row of rows) {
    for (const board of row.boards) {
      byBoard.set(boardKey(board), row.name);
    }
    indexName(byName, { name: row.name, state: row.state, alias_of: row.alias_of });
  }
  return { names: new Set(rows.map((row) => row.name)), byBoard, byName };
}

export async function discover(
  store: Store,
  sources: readonly DiscoverySource[],
  options?: HttpOptions,
  readers: Partial<Record<Platform, Reader>> = READERS,
  log: (line: string) => void = console.log,
): Promise<DiscoverResult> {
  const errors: string[] = [];
  const registry = await knownCompanies(store);
  const { names: known, byBoard, byName } = registry;
  let seenCount = 0;
  let probed = 0;
  let watched = 0;
  let aliases = 0;

  for (const source of sources) {
    if ("boards" in source) {
      const result = await discoverBoards(store, source, registry, options, readers, log);
      seenCount += result.seen;
      probed += result.probed;
      watched += result.watched;
      aliases += result.aliases;
      errors.push(...result.errors);
      continue;
    }

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
        indexName(byName, { name, state: "alias", alias_of: aliasOf });
        continue;
      }

      await seen(store, name, source.name, boards);
      // Added here, not at the `probed` count, so a name whose probe threw
      // gets another chance. The board index learns this name's boards too:
      // a second spelling in the same run ("Acme Inc", then "Acme") is an
      // alias the index read before the loop cannot know.
      known.add(name);
      indexName(byName, { name, state: "watched", alias_of: null });
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

// Serial throughout: `companyName` and each write touch hosts and the store,
// and two rows must never race the same read of `companies` (see the name
// loop's comment on rate limits). `registry` is updated as rows are written,
// so a later source in the same run sees them.
async function discoverBoards(
  store: Store,
  source: BoardSource,
  registry: KnownCompanies,
  options: HttpOptions | undefined,
  readers: Partial<Record<Platform, Reader>>,
  log: (line: string) => void,
): Promise<DiscoverResult> {
  const { names: known, byBoard, byName } = registry;
  const errors: string[] = [];

  let boards;
  try {
    boards = await source.boards(options);
  } catch (err) {
    errors.push(`${source.name}: ${describeError(err)}`);
    return { seen: 0, probed: 0, watched: 0, aliases: 0, errors };
  }

  // Case-insensitive: the index's ids may be spelled differently from the
  // ones on file, and a board already carried is never asked again.
  const carried = new Set([...byBoard.keys()].map((key) => key.toLowerCase()));
  const fresh = boards.filter((board) => !carried.has(boardKey(board).toLowerCase()));

  const asked = await answering(
    fresh.map((board) => ({ name: board.id, board })),
    readers,
    options,
  );
  // Nothing is written for an unreachable board: the next run asks again.
  for (const line of asked.unreachable) errors.push(`${source.name} ${line}`);

  // A dead board whose id reads like a known company's name is not recorded:
  // writing it there would let a name guess mark a real company's board
  // gone. It is asked again next run. (`known` covers a name `byName` cannot
  // index.) One matching nothing becomes its own
  // `discovered` row carrying the board, so it is not asked again.
  for (const { row } of asked.gone) {
    if (known.has(row.board.id) || byName.has(squashName(row.board.id))) continue;
    await seen(store, row.board.id, source.name, [row.board]);
    log(`${source.name}: new ${row.board.id} ${boardKey(row.board)} (gone)`);
    known.add(row.board.id);
    byBoard.set(boardKey(row.board), row.board.id);
    indexName(byName, { name: row.board.id, state: "discovered", alias_of: null });
  }

  // Each answering board joins the company its name matches, an alias
  // resolving to the company it aliases; only a name matching nothing is a
  // new company. The index learns each target before the next row, so two
  // boards naming one new company join rather than making two rows.
  const batch: { row: NamedBoard; isNew: boolean }[] = [];
  for (const { board } of asked.rows) {
    let read: string | null;
    try {
      read = await source.companyName(board, options);
    } catch (err) {
      errors.push(`${source.name} ${boardKey(board)}: ${describeError(err)}`);
      continue;
    }
    const candidate = read ?? board.id;
    const match = byName.get(squashName(candidate));
    const target =
      match === undefined
        ? candidate
        : match.state === "alias" && match.alias_of !== null
          ? match.alias_of
          : match.name;
    batch.push({ row: { name: target, board }, isNew: !known.has(target) });
    known.add(target);
    indexName(byName, { name: target, state: "watched", alias_of: null });
  }

  const summary = await watchSurvey(
    store,
    batch.map((entry) => entry.row),
    source.name,
  );
  for (const { row, isNew } of batch) {
    log(`${source.name}: ${isNew ? "new" : "added"} ${row.name} ${boardKey(row.board)}`);
    byBoard.set(boardKey(row.board), row.name);
  }
  for (const line of summary.errors) errors.push(`${source.name} ${line}`);

  return {
    seen: boards.length,
    probed: fresh.length,
    watched: summary.watched,
    aliases: summary.aliases,
    errors,
  };
}
