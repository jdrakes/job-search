// Turns a company name into candidate board slugs and tries them against
// the eleven platforms whose id is a company-chosen slug. Workday,
// Eightfold and Amazon are never probed: their board id needs a host, site
// and tenant no rule derives from a name (`wd5/Cisco_Careers/cisco`). iCIMS
// is never probed either: its real id is a `jibeapply.com` host that isn't
// derivable from a name (Ruling 6, plan). Those four arrive as a pasted
// board URL (`parseBoardUrl` in boards.ts).
// Personio is never probed either: a guess at a nonexistent subdomain
// answers HTTP 429 rather than 404 on the very first request from a cold
// process (measured live 2026-09-22), so no answer tells us whether the
// company has a board or the vendor is just refusing us. Its boards,
// `.de` ones included, arrive as a pasted board URL (Ruling 6);
// personio.ts, the reader, is unchanged.
// BambooHR is never probed either: no second signal exists to check a slug
// against - its listing payload states no company name and
// `{slug}.bamboohr.com/careers` is client-rendered with no <title> (checked
// live 2026-09-22 on three slugs) - and the vendor sells to small
// businesses, so a well-known name's slug is usually a different, smaller
// company: `dupont.bamboohr.com` is a Lebanon, Tennessee car dealership and
// `capgemini.bamboohr.com` lists four openings, both bound by a re-probe
// that day. Its boards arrive as a pasted board URL; bamboohr.ts, the
// reader, is unchanged.
// Rippling is never probed either: its listing states no company name, and
// its public board page, `ats.rippling.com/{slug}/jobs`, answered a plain
// GET with a 307 back to itself until the client gave up at 50 redirects
// (checked live 2026-09-27 on slug `paper`), so nothing a request can read
// names the board's owner. A slug that answers says only that some account
// holds it. Its boards arrive as a pasted board URL; rippling.ts, the
// reader, is unchanged.
// A slug answering is never the whole of the evidence: a board counts only
// when the name it reports matches the one asked about, or a slug
// collision would file another company's postings under this one. Most
// listings state that name. Where one does not (Ashby, Lever, and a
// Greenhouse board with nothing open) the board's own page is read for it
// (`readBoardName` in boards.ts), one extra request per answering slug. A
// board that answers but names another company, or whose page loads and
// names nobody, is refused and returned as such, so discover.ts can tell
// "wrong company" from "no board". A page that does not answer throws
// instead (`pageReported` says why).
import { getJson, getText, HttpError, type HttpOptions } from "../net/http.ts";
import { asArray, asRecord, asText } from "../ats/ats.ts";
import type { Board } from "../schema.ts";
import { avatureSiteName, readBoardName } from "./boards.ts";

export const SLUG_PLATFORMS = [
  "greenhouse",
  "ashby",
  "lever",
  "smartrecruiters",
  "workable",
  "jobvite",
  "avature",
  "breezy",
  "jazzhr",
  "recruitee",
  "hrmdirect",
] as const;

export type SlugPlatform = (typeof SLUG_PLATFORMS)[number];

// The platforms whose public listing answers server-rendered HTML rather
// than JSON - fetched with `getText`, the raw string handed into `REPORTED`
// as `data: unknown` per the note above `REPORTED`'s own type. `getJson`
// would call the response's own `.json()` and throw a parse error on any of
// these, silently dropping the platform through `probe`'s `catch`.
const TEXT_PLATFORMS = new Set<(typeof SLUG_PLATFORMS)[number]>([
  "jobvite",
  "avature",
  "jazzhr",
  "hrmdirect",
]);

// Dropped from the end of a name, alongside a leading "the", for the
// second round of candidates: "The Voleon Group" reduces to "voleon".
const TRAILING_WORDS = ["inc", "llc", "labs", "technologies", "software", "group"];

function normalizedWords(name: string): string[] {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
}

// Both removals apply in the same pass: "The Voleon Group" needs both.
function stripNoise(words: readonly string[]): string[] {
  let out = words[0]?.toLowerCase() === "the" ? words.slice(1) : [...words];
  const last = out[out.length - 1];
  if (last !== undefined && TRAILING_WORDS.includes(last.toLowerCase())) out = out.slice(0, -1);
  return out;
}

// Most likely first: the name as written (spaces removed, then hyphenated),
// then the same two joins with the noise stripped.
function joinedSlugs(words: readonly string[]): string[] {
  const slugs: string[] = [];
  for (const variant of [words, stripNoise(words)]) {
    if (variant.length === 0) continue;
    for (const joiner of ["", "-"]) {
      const slug = variant.join(joiner);
      if (!slugs.includes(slug)) slugs.push(slug);
    }
  }
  return slugs;
}

export function slugsFor(name: string): string[] {
  return joinedSlugs(normalizedWords(name).map((word) => word.toLowerCase()));
}

// Lever is case-sensitive, so it alone also tries the name's own casing.
export function casedSlugsFor(name: string): string[] {
  return joinedSlugs(normalizedWords(name)).filter((slug) => slug !== slug.toLowerCase());
}

// Letters and digits only, so punctuation, spacing or casing cannot produce
// a false refusal.
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// True when the queried words appear as a contiguous, case-insensitive run
// in the reported words. A single-word query only matches at the start
// ("Backblaze" in "Backblaze External Website"); a multi-word query may
// start anywhere.
function containsWords(reportedWords: readonly string[], queriedWords: readonly string[]): boolean {
  if (queriedWords.length === 0 || queriedWords.length > reportedWords.length) return false;
  for (let start = 0; start + queriedWords.length <= reportedWords.length; start++) {
    if (start > 0 && queriedWords.length < 2) continue;
    const runMatches = queriedWords.every(
      (word, offset) => reportedWords[start + offset].toLowerCase() === word.toLowerCase(),
    );
    if (runMatches) return true;
  }
  return false;
}

export function namesMatch(reported: string, queried: string): boolean {
  if (squash(reported) === squash(queried)) return true;
  return containsWords(normalizedWords(reported), normalizedWords(queried));
}

// What one answering slug says. `null`: the answer is no evidence a board
// exists at all (SmartRecruiters' `content: []` answers for any slug).
// Otherwise the name the board reports for its owner, itself null when the
// board names nobody.
type Reported = { readonly name: string | null } | null;

// The first posting's `company_name`, else the board's own `name` (read
// separately, since a board with nothing open has no posting to read).
async function greenhouseReported(
  data: unknown,
  board: Board,
  options: HttpOptions,
): Promise<Reported> {
  const first = asArray(asRecord(data)["jobs"])[0];
  const posted = first === undefined ? null : asText(asRecord(first)["company_name"]);
  return { name: posted ?? (await readBoardName(board, options)) };
}

// Ashby and Lever state no company name anywhere in their listing; the
// board page's <title> does.
//
// Here, and for Greenhouse above, a name page that fails to load (any HTTP
// status, or a network error) throws out of `probe`, rather than refusing
// the board as naming nobody: a refusal files the candidate as
// wrong_company for good, and a probe runs with no retries, so a one-off
// 503, or a 403 from the vendor's bot protection, would file a real company
// wrongly. discover.ts's per-name catch leaves the candidate pending, and it
// is probed again next run. That includes a 404 on a slug whose listing
// just answered.
async function pageReported(_data: unknown, board: Board, options: HttpOptions): Promise<Reported> {
  return { name: await readBoardName(board, options) };
}

// SmartRecruiters answers 200 with `content: []` for a slug that does not
// exist, not a 404, so an empty `content` carries no evidence; a real board
// is found the moment it lists one posting.
function smartrecruitersReported(data: unknown): Reported {
  const first = asArray(asRecord(data)["content"])[0];
  if (first === undefined) return null;
  return { name: asText(asRecord(asRecord(first)["company"])["name"]) };
}

// Workable states the account's name at the top of its listing, but any
// registered account answers 200 with its name and `jobs: []`, and slugs
// like `meta`, `walmart` and `oracle` are registered by someone who is not
// that company: one discovery run accepted 36 Workable boards of which 35
// were empty. So, as on SmartRecruiters, an empty answer carries no
// evidence; a board counts once it lists a posting under a matching name.
function workableReported(data: unknown): Reported {
  const account = asRecord(data);
  if (asArray(account["jobs"]).length === 0) return null;
  return { name: asText(account["name"]) };
}

// Every function in `REPORTED` must take `(data: unknown, ...)`:
// `strict: true` (tsconfig.json) makes a function typed to take
// `html: string` unassignable into that slot (contravariance), and
// `unknown | string` collapses to plain `unknown` rather than fixing it. So
// every HTML-based function below declares `data: unknown` too and narrows
// internally with `typeof data === "string" ? data : ""`, the same way the
// JSON-based ones above already narrow with `asRecord`/`asArray`.

const TITLE_TAG = /<title>([\s\S]*?)<\/title>/;

// The name a <title> gives between a fixed prefix and suffix, or null when
// the title is not of that shape or leaves nothing between them.
function titleName(html: string, prefix: string, suffix: string): string | null {
  const title = (TITLE_TAG.exec(html)?.[1] ?? "").trim();
  if (!title.startsWith(prefix) || !title.endsWith(suffix)) return null;
  const name = title.slice(prefix.length, title.length - suffix.length).trim();
  return name === "" ? null : name;
}

// Jobvite's listing page states the account's name in its <title>
// ("{Name} Careers", confirmed live on one tenant); a page with at least
// one job row (the `jv-job-list-name` cell class, confirmed in jobvite.ts's
// own listing parser) is a board.
function jobviteReported(data: unknown): Reported {
  const html = typeof data === "string" ? data : "";
  if (!html.includes('class="jv-job-list-name"')) return null;
  return { name: titleName(html, "", " Careers") };
}

// Avature is a skinned portal whose <title> format differs between
// tenants, so the name is read from its `og:site_name` (`avatureSiteName`
// in boards.ts, where the live check is recorded). A page with at least one
// JobDetail link is a board.
function avatureReported(data: unknown): Reported {
  const html = typeof data === "string" ? data : "";
  if (!/\/JobDetail\//.test(html)) return null;
  return { name: avatureSiteName(html) };
}

// Breezy states the account's name on every listing entry, in a top-level
// `company.name` field (confirmed live: the board checked states
// `"company":{"name":"<account name>", ...}` on every entry).
function breezyReported(data: unknown): Reported {
  const first = asArray(data)[0];
  if (first === undefined) return null;
  return { name: asText(asRecord(asRecord(first)["company"])["name"]) };
}

// JazzHR's listing states the account's name in its <title>
// ("{Name} - Career Page", confirmed live - the same suffix jazzhr.ts's
// own detail-title parser strips). A page without that title is no
// evidence of a board.
function jazzhrReported(data: unknown): Reported {
  const name = titleName(typeof data === "string" ? data : "", "", " - Career Page");
  return name === null ? null : { name };
}

// Recruitee states the account's name on every offer, in a top-level
// `company_name` field (confirmed live: the board checked states
// `"company_name":"<account name> GmbH"` on every offer).
function recruiteeReported(data: unknown): Reported {
  const first = asArray(asRecord(data)["offers"])[0];
  if (first === undefined) return null;
  return { name: asText(asRecord(first)["company_name"]) };
}

// HRMDirect's listing states the account's name in its <title>
// ("Careers At {Name}", confirmed live on one tenant). A page without that
// title is no evidence of a board.
function hrmdirectReported(data: unknown): Reported {
  const name = titleName(typeof data === "string" ? data : "", "Careers At ", "");
  return name === null ? null : { name };
}

const REPORTED: Record<
  SlugPlatform,
  (data: unknown, board: Board, options: HttpOptions) => Reported | Promise<Reported>
> = {
  greenhouse: greenhouseReported,
  ashby: pageReported,
  lever: pageReported,
  smartrecruiters: smartrecruitersReported,
  workable: workableReported,
  jobvite: jobviteReported,
  avature: avatureReported,
  breezy: breezyReported,
  jazzhr: jazzhrReported,
  recruitee: recruiteeReported,
  hrmdirect: hrmdirectReported,
};

function urlFor(platform: (typeof SLUG_PLATFORMS)[number], slug: string): string {
  switch (platform) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${slug}/postings`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
    case "jobvite":
      return `https://jobs.jobvite.com/${slug}/jobs`;
    case "avature":
      return `https://${slug}.avature.net/careers/SearchJobs`;
    case "breezy":
      return `https://${slug}.breezy.hr/json`;
    case "jazzhr":
      return `https://${slug}.applytojob.com/apply/`;
    case "recruitee":
      return `https://${slug}.recruitee.com/api/offers`;
    case "hrmdirect":
      return `https://${slug}.hrmdirect.com/employment/job-openings.php?search=true`;
  }
}

// A probe is a guess at whether a company has a board here at all, and the
// loop below already reads any failure as "no evidence", moving straight to
// the next candidate - so http.ts's ladder (2s, 4s, 8s, 16s) buys nothing
// and costs the whole discover phase. Measured live 2026-09-22, one wrong
// slug: breezy 0.1s, recruitee 0.2s, hrmdirect 0.3s, jazzhr 0.9s - but
// avature 30.1s, a DNS failure the ladder retries in full. At up
// to four candidates per platform that one alone cost ~120s per company
// name against under 8s for all the rest together. (Personio measured 33.3s
// on an HTTP 429 the same day; it is no longer probed at all, for the reason
// at the top of this file.) The ladder is for reading a board already known
// to exist; the list phase keeps it.
const NO_RETRIES = { retries: 0 } as const;

// A board that answered but reported another company's name, or none
// (`reported` null).
export interface Refusal {
  readonly board: Board;
  readonly reported: string | null;
}

// `boards` answered and named the company; `refused` answered and named
// someone else or nobody.
export interface ProbeResult {
  readonly boards: Board[];
  readonly refused: Refusal[];
}

interface PlatformResult {
  readonly board: Board | null;
  readonly refused: Refusal[];
}

// One platform's candidates, in order, stopping at the first slug that both
// answers and reports a matching name; a slug that answers under another
// name, or none, is refused, and a later candidate may still be the real
// slug. Serial, so that however many platforms run at once, this platform's
// own host still receives one request at a time from a given name.
async function probePlatform(
  platform: SlugPlatform,
  slugs: readonly string[],
  name: string,
  options: HttpOptions,
): Promise<PlatformResult> {
  const refused: Refusal[] = [];
  for (const slug of slugs) {
    const board: Board = { platform, id: slug };
    const reported = await askSlug(platform, board, options);
    if (reported === null) continue;
    if (reported.name !== null && namesMatch(reported.name, name)) return { board, refused };
    refused.push({ board, reported: reported.name });
  }
  return { board: null, refused };
}

// Whether a board a company's own careers page links to is that company's.
// A slug platform's board must answer and report the company's name, as a
// probed one must: a page can link a vendor's CDN host that parses as a
// board (`assets-cdn.breezy.hr`). The other platforms state no name to
// check, so the company's own link is the evidence: null. A 429 throws, as
// in `probe`.
export async function boardNamesCompany(
  board: Board,
  name: string,
  options?: HttpOptions,
): Promise<boolean | null> {
  const platform = SLUG_PLATFORMS.find((slugPlatform) => slugPlatform === board.platform);
  if (platform === undefined) return null;
  const reported = await askSlug(platform, board, { ...options, ...NO_RETRIES });
  return reported !== null && reported.name !== null && namesMatch(reported.name, name);
}

// What one slug's listing says, or null when it does not answer as a board.
async function askSlug(
  platform: SlugPlatform,
  board: Board,
  options: HttpOptions,
): Promise<Reported> {
  let data: unknown;
  try {
    data = TEXT_PLATFORMS.has(platform)
      ? await getText(urlFor(platform, board.id), options)
      : await getJson<unknown>(urlFor(platform, board.id), options);
  } catch (error) {
    // A 429 is the one failure that is not an answer. Every other one -
    // a 404, a DNS miss for an unregistered subdomain, a redirect to the
    // vendor's marketing page - means this slug is not a board here, and
    // the next candidate is worth trying. "Too many requests" means the
    // vendor declined to say, and treating that as "no board" records
    // absence of evidence as evidence of absence.
    //
    // It has happened twice, both on apply.workable.com. The completed
    // backlog pass of 2026-09-22 is the pass that earned the block, so
    // its own Workable answers were being refused while it wrote them
    // down as misses: it reports 0 Workable boards over 3,189 names with
    // `errors: 0`, and that zero is missing data, not a measurement. On
    // 2026-09-23 a second pass walked 125 names the same way before a
    // hand check of a known-good slug (`seeq`) came back 429.
    //
    // Throwing, rather than returning some "unknown" a caller may ignore:
    // discover.ts's per-name catch already skips the name without adding
    // it to `known`, so it is probed again tomorrow, which is the right
    // handling and needs no change. The backlog pass this guarded against
    // stopped the same way.
    //
    // 429 only, deliberately. A 5xx is also not an answer, but no probe
    // has been measured failing that way, and a case is not handled here
    // until it is seen.
    if (error instanceof HttpError && error.status === 429) throw error;
    return null;
  }
  return REPORTED[platform](data, board, options);
}

// The platforms are different hosts and http.ts's `rateLimit` is
// per-host, so asking them one after another stacked unrelated politeness
// waits end to end: measured live 2026-09-22 across the twelve probed then,
// one name cost 8.5s on average, 11s when no board was found and every
// candidate was tried everywhere. Asked together, a name costs the slowest
// single platform's own candidate chain rather than the sum of all of them -
// about 2s.
//
// `Promise.all` and not a settle-ordered collect: the result must stay in
// SLUG_PLATFORMS order, because discover.ts reads the *first* returned board
// another company already carries to decide this name is that company's
// alias. Ordered by completion, which board wins that race would vary run to
// run, and so would the alias.
//
// Do not carry this up into discover.ts's loop over names, which stays
// serial. `rateLimit` reads a host's `lastAt`, sleeps, then writes it, so two
// callers on the same host both compute the same delay and then fire
// together. Within one name that cannot happen - one platform, one host - but
// two names probed at once share every host.
//
// `platforms` narrows which of them are asked, for a caller that already
// knows the answer for the rest: the deleted backlog pass walked names the
// store has held since before a platform existed, and asking a vendor a
// question already answered, once per name, is what earned the tool a
// Workable block on 2026-09-22. It defaults to every platform in
// SLUG_PLATFORMS, so discover.ts's call names none.
export async function probe(
  name: string,
  options?: HttpOptions,
  platforms: readonly SlugPlatform[] = SLUG_PLATFORMS,
): Promise<ProbeResult> {
  const lowercase = slugsFor(name);
  const cased = casedSlugsFor(name);

  const probeOptions: HttpOptions = { ...options, ...NO_RETRIES };

  const found = await Promise.all(
    platforms.map((platform) =>
      probePlatform(
        platform,
        platform === "lever" ? [...lowercase, ...cased] : lowercase,
        name,
        probeOptions,
      ),
    ),
  );

  return {
    boards: found.map((result) => result.board).filter((board) => board !== null),
    refused: found.flatMap((result) => result.refused),
  };
}
