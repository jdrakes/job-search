// Discovery in two steps. Sources suggest: every name or board a source
// offers becomes a candidate row, and no source writes `companies`. Then
// the run resolves: each candidate with no outcome yet is resolved once to
// one outcome, and this module is the only writer of `companies` a
// candidate reaches. A candidate's input columns (name, url, origin,
// evidence, added_at) are written once, when it is suggested; resolving
// writes only outcome, outcome_at and company.
//
// Every index is read once, from `companies` and `candidates`, rather than
// one `select` per candidate (the sources name a few thousand a run), and
// updated after each write so a later candidate in the same run sees it.
import { randomUUID } from "node:crypto";

import type { Reader } from "./ats/ats.ts";
import { READERS } from "./ats/readers.ts";
import { boardKey } from "./companies.ts";
import { answering } from "./discovery/bind.ts";
import { boardName, boardUrl, parseBoardUrl } from "./discovery/boards.ts";
import { probe, type ProbeResult } from "./discovery/probe.ts";
import type { BoardSource, DiscoverySource, Source } from "./discovery/source.ts";
import { describeError } from "./errors.ts";
import type { HttpOptions } from "./net/http.ts";
import {
  OUTCOMES,
  type Board,
  type Candidate,
  type Company,
  type Outcome,
  type Platform,
} from "./schema.ts";
import type { Store } from "./store/store.ts";

export interface DiscoverResult {
  readonly suggested: number;
  readonly resolved: Readonly<Record<Outcome, number>>;
  readonly pending: number;
  readonly errors: readonly string[];
}

interface Resolution {
  readonly outcome: Outcome;
  readonly company: string | null;
}

interface CompanyEntry {
  readonly name: string;
  readonly dropped: boolean;
}

interface Registry {
  // nameKey -> the company by that name.
  readonly companies: Map<string, CompanyEntry>;
  // Lowercased boardKey -> the company carrying it. Lowercased because an
  // index can spell an id differently from the one on file.
  readonly carriers: Map<string, string>;
  // nameKey of every candidate with an outcome.
  readonly resolvedNames: Set<string>;
  // origin -> nameKey of every name that origin has suggested.
  readonly suggestedBy: Map<string, Set<string>>;
  // Every URL a candidate carries.
  readonly urls: Set<string>;
}

// Letters and digits only, lowercased: the same rule `probe.ts`'s local
// `squash` uses, kept here too since a company name is not a board slug and
// does not belong in the probe.
function squashName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A name with no letter or digit (one written wholly in another script)
// squashes to "", and "" would match every other such name, so it is keyed
// by itself instead. Such a name holds no letter or digit, so it can never
// equal a squashed key.
function nameKey(name: string): string {
  const squashed = squashName(name);
  return squashed === "" ? name : squashed;
}

function carrierKey(board: Board): string {
  return boardKey(board).toLowerCase();
}

async function readRegistry(
  store: Store,
): Promise<{ registry: Registry; unresolved: Candidate[] }> {
  const companyRows = await store.select<Company>("companies");
  const candidateRows = await store.select<Candidate>("candidates");
  const registry: Registry = {
    companies: new Map(),
    carriers: new Map(),
    resolvedNames: new Set(),
    suggestedBy: new Map(),
    urls: new Set(),
  };

  for (const row of companyRows) {
    registry.companies.set(nameKey(row.name), { name: row.name, dropped: row.dropped_at !== null });
    for (const board of row.boards) registry.carriers.set(carrierKey(board), row.name);
  }

  const unresolved: Candidate[] = [];
  for (const row of candidateRows) {
    if (row.url !== null) registry.urls.add(row.url);
    if (row.name !== null) noteSuggested(registry, row.origin, row.name);
    if (row.outcome === null) unresolved.push(row);
    else if (row.name !== null) registry.resolvedNames.add(nameKey(row.name));
  }
  return { registry, unresolved };
}

function noteSuggested(registry: Registry, origin: string, name: string): void {
  const names = registry.suggestedBy.get(origin);
  if (names === undefined) registry.suggestedBy.set(origin, new Set([nameKey(name)]));
  else names.add(nameKey(name));
}

// The outcome a name alone settles, with no request: a dropped company's
// name, then (for a candidate with no URL) a name already known.
function droppedMatch(registry: Registry, name: string | null): Resolution | null {
  if (name === null) return null;
  const match = registry.companies.get(nameKey(name));
  return match?.dropped === true ? { outcome: "dropped", company: match.name } : null;
}

function knownMatch(registry: Registry, name: string): Resolution | null {
  const match = registry.companies.get(nameKey(name));
  if (match !== undefined) return { outcome: "known", company: match.name };
  if (registry.resolvedNames.has(nameKey(name))) return { outcome: "known", company: null };
  return null;
}

function emptyCounts(): Record<Outcome, number> {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
}

export async function discover(
  store: Store,
  sources: readonly DiscoverySource[],
  options?: HttpOptions,
  readers: Partial<Record<Platform, Reader>> = READERS,
  log: (line: string) => void = console.log,
): Promise<DiscoverResult> {
  const errors: string[] = [];
  const resolved = emptyCounts();
  const { registry, unresolved } = await readRegistry(store);

  // Step 1: sources suggest.
  let suggested = 0;
  for (const source of sources) {
    const rows =
      "boards" in source
        ? await suggestBoards(source, registry, options, log, errors)
        : await suggestNames(source, registry, options, errors);
    if (rows.length === 0) continue;
    await store.upsert("candidates", rows);
    suggested += rows.length;
    for (const row of rows) {
      if (row.outcome === null) unresolved.push(row);
      else resolved[row.outcome] += 1;
    }
  }

  // Step 2: resolve, oldest first. Serial, and it must stay serial. `probe`
  // already asks all of its platforms at once, which is safe because they
  // are all different hosts and net/http.ts rate-limits per host. Two names
  // probed at once would share every one of those hosts: `rateLimit` reads a
  // host's `lastAt`, sleeps, then writes it, so both would compute the same
  // delay and fire together. The same holds for two board reads.
  const queue = [...unresolved].sort((left, right) =>
    left.added_at < right.added_at ? -1 : left.added_at > right.added_at ? 1 : 0,
  );
  let pending = 0;
  for (const candidate of queue) {
    const resolution = await resolve(store, candidate, registry, options, readers, log);
    if (resolution === null) {
      pending += 1;
      continue;
    }
    if (candidate.name !== null) registry.resolvedNames.add(nameKey(candidate.name));
    const result = await store.update("candidates", candidate.id, {
      outcome: resolution.outcome,
      outcome_at: new Date().toISOString(),
      company: resolution.company,
    });
    if (result.ok) resolved[resolution.outcome] += 1;
    else errors.push(`${candidate.origin} ${candidate.id}: ${result.reason}`);
  }

  return { suggested, resolved, pending, errors };
}

function candidateRow(
  origin: string,
  name: string | null,
  url: string | null,
  resolution: Resolution | null,
): Candidate {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name,
    url,
    origin,
    evidence: null,
    added_at: now,
    outcome: resolution?.outcome ?? null,
    outcome_at: resolution === null ? null : now,
    company: resolution?.company ?? null,
  };
}

// A name this origin already suggested is no row. A name already known
// gets a row resolved at once, so every origin that named a company stays
// countable; any other name gets an unresolved row.
async function suggestNames(
  source: Source,
  registry: Registry,
  options: HttpOptions | undefined,
  errors: string[],
): Promise<Candidate[]> {
  let names: readonly string[];
  try {
    names = await source.companies(options);
  } catch (err) {
    errors.push(`${source.name}: ${describeError(err)}`);
    return [];
  }

  const rows: Candidate[] = [];
  for (const name of names) {
    if (registry.suggestedBy.get(source.name)?.has(nameKey(name)) === true) continue;
    noteSuggested(registry, source.name, name);
    const resolution = droppedMatch(registry, name) ?? knownMatch(registry, name);
    if (resolution !== null) registry.resolvedNames.add(nameKey(name));
    rows.push(candidateRow(source.name, name, null, resolution));
  }
  return rows;
}

// A board a company carries, or whose URL a candidate already has, is no
// row; any other is an unresolved row carrying the board's URL and no name.
async function suggestBoards(
  source: BoardSource,
  registry: Registry,
  options: HttpOptions | undefined,
  log: (line: string) => void,
  errors: string[],
): Promise<Candidate[]> {
  let boards: readonly Board[];
  try {
    boards = await source.boards(options, log);
  } catch (err) {
    errors.push(`${source.name}: ${describeError(err)}`);
    return [];
  }

  const rows: Candidate[] = [];
  for (const board of boards) {
    if (registry.carriers.has(carrierKey(board))) continue;
    const url = boardUrl(board);
    if (registry.urls.has(url)) continue;
    registry.urls.add(url);
    rows.push(candidateRow(source.name, null, url, null));
  }
  return rows;
}

// One candidate's outcome, writing `companies` when the outcome makes or
// grows a company. Null leaves it unresolved, for the next run: the line
// saying why is logged.
async function resolve(
  store: Store,
  candidate: Candidate,
  registry: Registry,
  options: HttpOptions | undefined,
  readers: Partial<Record<Platform, Reader>>,
  log: (line: string) => void,
): Promise<Resolution | null> {
  const dropped = droppedMatch(registry, candidate.name);
  if (dropped !== null) return dropped;
  if (candidate.url !== null) {
    return resolveUrl(store, candidate, candidate.url, registry, options, readers, log);
  }
  if (candidate.name === null) {
    throw new Error(`candidate ${candidate.id} has neither a name nor a url`);
  }
  return resolveName(store, candidate, candidate.name, registry, options, log);
}

async function resolveUrl(
  store: Store,
  candidate: Candidate,
  url: string,
  registry: Registry,
  options: HttpOptions | undefined,
  readers: Partial<Record<Platform, Reader>>,
  log: (line: string) => void,
): Promise<Resolution | null> {
  const board = parseBoardUrl(url);
  if (board === null) return { outcome: "bad_url", company: null };

  // A board already carried is that company's. A candidate with no name of
  // its own says nothing against that; one whose name is another
  // company's is its alias.
  const carrier = registry.carriers.get(carrierKey(board));
  if (carrier !== undefined) {
    const same = candidate.name === null || nameKey(candidate.name) === nameKey(carrier);
    return { outcome: same ? "known" : "alias", company: carrier };
  }

  const asked = await answering([{ name: candidate.name ?? board.id, board }], readers, options);
  if (asked.gone.length > 0) return { outcome: "gone", company: null };
  for (const line of asked.unreachable) log(`${candidate.origin} ${line}`);
  if (asked.rows.length === 0) return null;

  let name: string;
  try {
    name = candidate.name ?? (await boardName(board, options)) ?? board.id;
  } catch (err) {
    log(`${candidate.origin} ${boardKey(board)}: ${describeError(err)}`);
    return null;
  }

  const match = registry.companies.get(nameKey(name));
  if (match?.dropped === true) return { outcome: "dropped", company: match.name };
  if (match !== undefined) {
    await addBoard(store, match.name, board);
    registry.carriers.set(carrierKey(board), match.name);
    log(`${candidate.origin}: added ${match.name} ${boardKey(board)}`);
    return { outcome: "added", company: match.name };
  }
  await writeCompany(store, name, [board], registry);
  log(`${candidate.origin}: new ${name} ${boardKey(board)}`);
  return { outcome: "watched", company: name };
}

async function resolveName(
  store: Store,
  candidate: Candidate,
  name: string,
  registry: Registry,
  options: HttpOptions | undefined,
  log: (line: string) => void,
): Promise<Resolution | null> {
  const known = knownMatch(registry, name);
  if (known !== null) return known;

  let found: ProbeResult;
  try {
    found = await probe(name, options);
  } catch (err) {
    log(`${candidate.origin} ${name}: ${describeError(err)}`);
    return null;
  }
  const { boards, refused } = found;

  for (const board of boards) {
    const carrier = registry.carriers.get(carrierKey(board));
    if (carrier !== undefined) return { outcome: "alias", company: carrier };
  }
  if (boards.length === 0) {
    if (refused.length === 0) return { outcome: "no_board", company: null };
    // A board answered under this name's slug but named someone else, or
    // nobody; the line says which, so a refusal that was wrong can be seen.
    for (const refusal of refused) {
      const reported = refusal.reported === null ? "nobody" : `"${refusal.reported}"`;
      log(
        `${candidate.origin} ${name}: wrong_company ${boardKey(refusal.board)} names ${reported}`,
      );
    }
    return { outcome: "wrong_company", company: null };
  }

  await writeCompany(store, name, boards, registry);
  log(`${candidate.origin}: new ${name} ${boards.map(boardKey).join(" ")}`);
  return { outcome: "watched", company: name };
}

async function writeCompany(
  store: Store,
  name: string,
  boards: readonly Board[],
  registry: Registry,
): Promise<void> {
  const row: Company = { name, boards, reason: null, dropped_at: null };
  await store.upsert("companies", [row]);
  registry.companies.set(nameKey(name), { name, dropped: false });
  for (const board of boards) registry.carriers.set(carrierKey(board), name);
}

// The row is read back rather than taken from the index: a board's gone
// mark written since the run began would be lost under a stale copy.
// Existing boards are kept and a board already there is not added twice.
async function addBoard(store: Store, name: string, board: Board): Promise<void> {
  const [current] = await store.select<Company>("companies", { name });
  if (current === undefined) return;
  if (current.boards.some((existing) => boardKey(existing) === boardKey(board))) return;
  await store.upsert("companies", [{ ...current, boards: [...current.boards, board] }]);
}
