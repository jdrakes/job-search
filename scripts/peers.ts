// Peer expansion's two ends in the store. `seeds` prints what the peer
// skill searches from: the criteria's role words, every company James has
// applied to that has not yet been searched, and every name already known so
// the skill skips it. `boards` reads the careers page of each peer the
// researcher found no board for and prints the board it links to, touching
// no store. `record` writes what the skill found: each candidate as a new
// row with `origin: "peers"`, and `peers_searched_at` on each seed it
// searched.
//
// It connects as the run does, not as the list's role, and writes only a
// candidate's input columns (with `id` and `added_at`, set here to what the
// column defaults would give) plus a company's `peers_searched_at`: never an
// outcome, a company, or boards. A searched name must be a current seed, so
// it names a company row that exists and has not been searched; the run is
// the only writer of companies, and a row deleted since is reported, not
// written.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { loadCriteria } from "../src/criteria.ts";
import { boardUrl, parseBoardUrl } from "../src/discovery/boards.ts";
import { boardNamesCompany } from "../src/discovery/probe.ts";
import { describeError } from "../src/errors.ts";
import { getText, type HttpOptions } from "../src/net/http.ts";
import type { Board, Candidate, Company, Posting } from "../src/schema.ts";
import { openStore } from "../src/store/open.ts";
import type { Store } from "../src/store/store.ts";

export interface Seed {
  readonly name: string;
  readonly roles: readonly string[];
}

export interface SeedsOutput {
  readonly criteria: {
    readonly level_words: readonly string[];
    readonly role_words: readonly string[];
    readonly comp_floor: number;
    readonly assumed_bonus_pct: number | null;
  };
  readonly seeds: readonly Seed[];
  readonly known: readonly string[];
}

export interface PeerCandidate {
  readonly name: string;
  readonly url: string | null;
  readonly evidence: string;
}

export interface PeerRecord {
  readonly searched: readonly string[];
  readonly candidates: readonly PeerCandidate[];
}

export type PostingSeedFields = Pick<Posting, "company" | "title" | "status">;
type CompanySeedFields = Pick<Company, "name" | "peers_searched_at">;

// A posting James acted on: every status but `closed`, which says the
// posting went away, not that he applied.
function applied(posting: PostingSeedFields): boolean {
  return posting.status !== null && posting.status !== "closed";
}

// A seed is a company row, because the marker lives on the row: a posting
// whose company has no row could never be marked searched, so it would be
// offered again every time.
export function seedsOf(
  postings: readonly PostingSeedFields[],
  companies: readonly CompanySeedFields[],
): Seed[] {
  const unsearched = new Set(
    companies
      .filter((company) => company.peers_searched_at === null)
      .map((company) => company.name),
  );
  const roles = new Map<string, string[]>();
  for (const posting of postings) {
    if (!applied(posting) || !unsearched.has(posting.company)) continue;
    const titles = roles.get(posting.company) ?? [];
    if (posting.title !== null && !titles.includes(posting.title)) titles.push(posting.title);
    roles.set(posting.company, titles);
  }
  return [...roles.keys()].sort().map((name) => ({ name, roles: roles.get(name) ?? [] }));
}

async function readSeedRows(
  store: Store,
): Promise<{ postings: PostingSeedFields[]; companies: CompanySeedFields[] }> {
  const postings = await store.select<PostingSeedFields>("postings", undefined, [
    "company",
    "title",
    "status",
  ]);
  const companies = await store.select<CompanySeedFields>("companies", undefined, [
    "name",
    "peers_searched_at",
  ]);
  return { postings, companies };
}

export async function readSeeds(
  store: Store,
): Promise<{ ok: true; value: SeedsOutput } | { ok: false; reason: string }> {
  const criteria = await loadCriteria(store);
  if (!criteria.ok) return criteria;
  const { postings, companies } = await readSeedRows(store);
  const candidates = await store.select<Pick<Candidate, "name">>("candidates", undefined, ["name"]);
  const names = [
    ...companies.map((company) => company.name),
    ...candidates.map((candidate) => candidate.name).filter((name) => name !== null),
  ];
  const { level_words, role_words, comp_floor, assumed_bonus_pct } = criteria.value;
  return {
    ok: true,
    value: {
      criteria: { level_words, role_words, comp_floor, assumed_bonus_pct },
      seeds: seedsOf(postings, companies),
      known: [...new Set(names)].sort(),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// A web address: `mailto:`, `javascript:` and the like parse as URLs too.
function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Why one candidate entry is unusable, or null when it is usable.
function candidateProblem(entry: unknown): string | null {
  if (!isObject(entry)) return "must be an object";
  if (!isFilled(entry.name)) return "needs a name";
  if (!isFilled(entry.evidence)) return "needs evidence";
  const url = entry.url;
  if (url === undefined || url === null) return null;
  if (typeof url !== "string" || !isWebUrl(url)) return `cannot read url ${JSON.stringify(url)}`;
  return null;
}

// Parsed once, here: an invalid file is refused whole, naming its first bad
// entry, so a record either writes everything or nothing. A readable URL
// that names no board the readers can read (a company's own careers
// domain, say) is dropped, not refused: the candidate is still worth its
// name, which the run probes, and a URL it cannot use would only resolve
// `bad_url`. Each drop is named in `dropped`.
export function parseRecord(
  text: string,
): { ok: true; value: PeerRecord; dropped: readonly string[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isObject(parsed)) return { ok: false, reason: "record must be a JSON object" };
  const { searched, candidates } = parsed;
  if (!Array.isArray(searched)) return { ok: false, reason: "searched must be an array" };
  if (!Array.isArray(candidates)) return { ok: false, reason: "candidates must be an array" };

  const badSeed = searched.findIndex((name) => !isFilled(name));
  if (badSeed !== -1) {
    return { ok: false, reason: `searched[${badSeed}] must be a company name` };
  }
  for (const [index, entry] of candidates.entries()) {
    const problem = candidateProblem(entry);
    if (problem !== null) {
      const label = isObject(entry) && isFilled(entry.name) ? ` (${entry.name})` : "";
      return { ok: false, reason: `candidates[${index}]${label} ${problem}` };
    }
  }

  const dropped: string[] = [];
  const kept = (candidates as Record<string, unknown>[]).map((entry, index) => {
    const url = (entry.url as string | null | undefined) ?? null;
    if (url !== null && parseBoardUrl(url) === null) {
      dropped.push(`candidates[${index}] (${entry.name as string}) url names no board: ${url}`);
      return { name: entry.name as string, url: null, evidence: entry.evidence as string };
    }
    return { name: entry.name as string, url, evidence: entry.evidence as string };
  });

  return { ok: true, value: { searched: searched as string[], candidates: kept }, dropped };
}

export interface RecordResult {
  readonly added: number;
  readonly marked: number;
  // One line per seed whose company row was deleted after the seed check.
  readonly unknownSeeds: readonly string[];
}

// Only a candidate's input columns, plus `id` and `added_at`: `outcome`,
// `outcome_at` and `company` are discover's. A searched name that is not a
// current seed (one `seeds` would print now) refuses the whole record before
// anything is written, naming every such name: marking it would hide a
// company the skill never searched from, or record one run twice.
export async function applyRecord(
  store: Store,
  record: PeerRecord,
  now: string,
): Promise<{ ok: true; value: RecordResult } | { ok: false; reason: string }> {
  const { postings, companies } = await readSeedRows(store);
  const seeds = new Set(seedsOf(postings, companies).map((seed) => seed.name));
  const strangers = record.searched.filter((name) => !seeds.has(name));
  if (strangers.length > 0) {
    const named = strangers.map((name) => JSON.stringify(name)).join(", ");
    return { ok: false, reason: `searched names that are not current seeds: ${named}` };
  }

  const rows = record.candidates.map((candidate) => ({
    id: randomUUID(),
    name: candidate.name,
    url: candidate.url,
    origin: "peers",
    evidence: candidate.evidence,
    added_at: now,
  }));
  if (rows.length > 0) await store.upsert("candidates", rows);

  let marked = 0;
  const unknownSeeds: string[] = [];
  for (const name of record.searched) {
    const result = await store.update("companies", name, { peers_searched_at: now });
    if (result.ok) marked += 1;
    else unknownSeeds.push(result.reason);
  }
  return { ok: true, value: { added: rows.length, marked, unknownSeeds } };
}

// A peer the researcher found no board for, and the careers page it opened.
export interface BoardQuery {
  readonly name: string;
  readonly careers: string;
}

export function parseBoardQueries(
  text: string,
): { ok: true; value: BoardQuery[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "must be a JSON array" };
  const queries: BoardQuery[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!isObject(entry) || !isFilled(entry.name)) {
      return { ok: false, reason: `[${index}] needs a name` };
    }
    if (!isFilled(entry.careers) || !isWebUrl(entry.careers)) {
      return { ok: false, reason: `[${index}] (${entry.name}) needs a careers url` };
    }
    queries.push({ name: entry.name, careers: entry.careers });
  }
  return { ok: true, value: queries };
}

// Every board the readers can read that a page names, in page order, once
// each: the page's own address, every link, embed and form target, and any
// absolute URL written in its text (a script's JSON escapes its slashes).
export function boardsLinkedFrom(html: string, pageUrl: string): Board[] {
  const addresses = [pageUrl];
  for (const match of html.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      addresses.push(new URL((match[1] ?? "").replaceAll("&amp;", "&"), pageUrl).href);
    } catch {
      // Not a URL; nothing to read.
    }
  }
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>)]+/g)) {
    addresses.push(match[0].replaceAll("\\/", "/"));
  }
  const boards = new Map<string, Board>();
  for (const address of addresses) {
    const board = parseBoardUrl(address);
    if (board !== null) boards.set(`${board.platform}:${board.id}`, board);
  }
  return [...boards.values()];
}

// The board a peer's own careers page links to, as a URL `record` accepts,
// or null when it links to none that is the peer's. The name probe the run
// falls back on guesses slugs from the name, so it misses a board like
// `jobs.ashbyhq.com/bidgely-inc`; the company's own link does not.
export async function findBoard(
  query: BoardQuery,
  options?: HttpOptions,
): Promise<{ ok: true; value: string | null } | { ok: false; reason: string }> {
  try {
    const html = await getText(query.careers, options);
    for (const board of boardsLinkedFrom(html, query.careers)) {
      if ((await boardNamesCompany(board, query.name, options)) !== false) {
        return { ok: true, value: boardUrl(board) };
      }
    }
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

const USAGE =
  "peers: usage: peers.ts seeds | peers.ts record <file.json> | peers.ts boards <file.json>";

async function main(): Promise<void> {
  const [command, path] = process.argv.slice(2);
  if (command === "seeds") {
    const result = await readSeeds(openStore());
    if (!result.ok) {
      console.error(`peers: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result.value, null, 2));
    return;
  }
  if (command === "boards" && path !== undefined) {
    const parsed = parseBoardQueries(await readFile(path, "utf8"));
    if (!parsed.ok) {
      console.error(`peers: ${path}: ${parsed.reason}`);
      process.exitCode = 1;
      return;
    }
    const found = [];
    for (const query of parsed.value) {
      const result = await findBoard(query);
      found.push(
        result.ok
          ? { name: query.name, url: result.value, reason: null }
          : { name: query.name, url: null, reason: result.reason },
      );
    }
    console.log(JSON.stringify(found, null, 2));
    return;
  }
  if (command === "record" && path !== undefined) {
    const parsed = parseRecord(await readFile(path, "utf8"));
    if (!parsed.ok) {
      console.error(`peers: ${path}: ${parsed.reason}; nothing written`);
      process.exitCode = 1;
      return;
    }
    for (const line of parsed.dropped)
      console.error(`peers: url dropped, resolved by name: ${line}`);
    const applied = await applyRecord(openStore(), parsed.value, new Date().toISOString());
    if (!applied.ok) {
      console.error(`peers: ${path}: ${applied.reason}; nothing written`);
      process.exitCode = 1;
      return;
    }
    const result = applied.value;
    for (const line of result.unknownSeeds) console.error(`peers: not marked: ${line}`);
    console.log(`peers: added ${result.added} candidate(s), marked ${result.marked} seed(s)`);
    if (result.unknownSeeds.length > 0) process.exitCode = 1;
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`peers: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
