// Peer expansion's two ends in the store. `seeds` prints what the peer
// skill searches from: the criteria's role words, every company James has
// applied to that has not yet been searched, and every name already known so
// the skill skips it. `record` writes what the skill found: each candidate
// as a new row with `origin: "peers"`, and `peers_searched_at` on each seed
// it searched.
//
// The same hand as James's Add box, not a way around the run: it writes a
// candidate's input columns and a company's `peers_searched_at`, nothing
// else. It never creates a company (the run is the only writer of
// companies), so a searched name with no company row is reported, not
// written.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { loadCriteria } from "../src/criteria.ts";
import { describeError } from "../src/errors.ts";
import type { Candidate, Company, Posting } from "../src/schema.ts";
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

export async function readSeeds(
  store: Store,
): Promise<{ ok: true; value: SeedsOutput } | { ok: false; reason: string }> {
  const criteria = await loadCriteria(store);
  if (!criteria.ok) return criteria;
  const postings = await store.select<PostingSeedFields>("postings", undefined, [
    "company",
    "title",
    "status",
  ]);
  const companies = await store.select<CompanySeedFields>("companies", undefined, [
    "name",
    "peers_searched_at",
  ]);
  const candidates = await store.select<Pick<Candidate, "name">>("candidates", undefined, ["name"]);
  const names = [
    ...companies.map((company) => company.name),
    ...candidates.map((candidate) => candidate.name).filter((name) => name !== null),
  ];
  const { level_words, role_words, comp_floor } = criteria.value;
  return {
    ok: true,
    value: {
      criteria: { level_words, role_words, comp_floor },
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

function parses(text: string): boolean {
  try {
    new URL(text);
    return true;
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
  if (typeof url !== "string" || !parses(url)) return `cannot read url ${JSON.stringify(url)}`;
  return null;
}

// Parsed once, here: an invalid file is refused whole, naming its first bad
// entry, so a record either writes everything or nothing.
export function parseRecord(
  text: string,
): { ok: true; value: PeerRecord } | { ok: false; reason: string } {
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

  return {
    ok: true,
    value: {
      searched: searched as string[],
      candidates: (candidates as Record<string, unknown>[]).map((entry) => ({
        name: entry.name as string,
        url: (entry.url as string | null | undefined) ?? null,
        evidence: entry.evidence as string,
      })),
    },
  };
}

export interface RecordResult {
  readonly added: number;
  readonly marked: number;
  // One line per searched name the store holds no company row for.
  readonly unknownSeeds: readonly string[];
}

// Only a candidate's input columns: `outcome`, `outcome_at` and `company`
// are discover's.
export async function applyRecord(
  store: Store,
  record: PeerRecord,
  now: string,
): Promise<RecordResult> {
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
  return { added: rows.length, marked, unknownSeeds };
}

const USAGE = "peers: usage: peers.ts seeds | peers.ts record <file.json>";

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
  if (command === "record" && path !== undefined) {
    const parsed = parseRecord(await readFile(path, "utf8"));
    if (!parsed.ok) {
      console.error(`peers: ${path}: ${parsed.reason}; nothing written`);
      process.exitCode = 1;
      return;
    }
    const result = await applyRecord(openStore(), parsed.value, new Date().toISOString());
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
