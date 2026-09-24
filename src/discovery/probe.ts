// Turns a company name into candidate board slugs and tries them against
// the twelve platforms whose id is a company-chosen slug. Workday,
// Eightfold and Amazon are never probed: their board id needs a host, site
// and tenant no rule derives from a name (`wd5/Cisco_Careers/cisco`). iCIMS
// is never probed either: its real id is a `jibeapply.com` host that isn't
// derivable from a name (Ruling 6, plan), reached only through the survey.
// Personio is never probed either: a guess at a nonexistent subdomain
// answers HTTP 429 rather than 404 on the very first request from a cold
// process (measured live 2026-09-22), so no answer tells us whether the
// company has a board or the vendor is just refusing us. Its boards are
// added by hand through the survey, which is also the only way a `.de`
// board could ever arrive (Ruling 6); personio.ts, the reader, is unchanged.
// BambooHR is never probed either: no second signal exists to check a slug
// against - its listing payload states no company name and
// `{slug}.bamboohr.com/careers` is client-rendered with no <title> (checked
// live 2026-09-22 on three slugs) - and the vendor sells to small
// businesses, so a well-known name's slug is usually a different, smaller
// company: `dupont.bamboohr.com` is a Lebanon, Tennessee car dealership and
// `capgemini.bamboohr.com` lists four openings, both bound by a re-probe
// that day. Its boards come through the survey; bamboohr.ts, the reader, is
// unchanged.
// Greenhouse, SmartRecruiters and Workable state the hiring company's name
// on a posting, so a board counts only when that name matches, or a slug
// collision would mix another company's postings under this one; Ashby and
// Lever state none, so a slug answering is the whole of the evidence.
// Rippling states no company name on its listing either, and a slug that
// does not exist is a 404 the `catch` below handles like any other host's;
// a real board with nothing open answers `[]` (slug `paper`, live
// 2026-09-22), so a slug that lists at least one posting is the evidence.
import { getJson, getText, HttpError, type HttpOptions } from "../net/http.ts";
import { asArray, asRecord, asText } from "../ats/ats.ts";
import type { Board } from "../schema.ts";

export const SLUG_PLATFORMS = [
  "greenhouse",
  "ashby",
  "lever",
  "smartrecruiters",
  "workable",
  "rippling",
  "jobvite",
  "avature",
  "breezy",
  "jazzhr",
  "recruitee",
  "hrmdirect",
] as const;

export type SlugPlatform = (typeof SLUG_PLATFORMS)[number];

// The platforms whose public listing answers server-rendered HTML rather
// than JSON - fetched with `getText`, the raw string handed into `ACCEPTS`
// as `data: unknown` per the note above `ACCEPTS`'s own type. `getJson`
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

function greenhouseAccepts(data: unknown, name: string): boolean {
  const jobs = asArray(asRecord(data)["jobs"]);
  const first = jobs[0];
  const reported = first === undefined ? null : asText(asRecord(first)["company_name"]);
  // Nothing to refute the name check with, so the slug answering suffices.
  return reported === null || namesMatch(reported, name);
}

function ashbyAccepts(): boolean {
  // Ashby states no company name anywhere in a posting.
  return true;
}

function leverAccepts(): boolean {
  // Lever states no company name anywhere in a posting.
  return true;
}

// SmartRecruiters answers 200 with `content: []` for a slug that does not
// exist, not a 404, so an empty `content` carries no evidence and is
// refused; a real board is found the moment it lists one posting.
function smartrecruitersAccepts(data: unknown, name: string): boolean {
  const entries = asArray(asRecord(data)["content"]);
  const first = entries[0];
  if (first === undefined) return false;
  const reported = asText(asRecord(asRecord(first)["company"])["name"]);
  return reported !== null && namesMatch(reported, name);
}

// Workable states the account's name at the top of its listing, but any
// registered account answers 200 with its name and `jobs: []`, and slugs
// like `meta`, `walmart` and `oracle` are registered by someone who is not
// that company: one discovery run accepted 36 Workable boards of which 35
// were empty. So, as on SmartRecruiters, an empty answer carries no
// evidence; a board counts once it lists a posting under a matching name.
function workableAccepts(data: unknown, name: string): boolean {
  const account = asRecord(data);
  if (asArray(account["jobs"]).length === 0) return false;
  const reported = asText(account["name"]);
  return reported !== null && namesMatch(reported, name);
}

// Rippling states no company name on its listing, and a real board with
// nothing open answers `[]`, the same as no board at all would tell us; a
// slug that lists at least one posting is the whole of the evidence
// (Ruling 2). A slug that does not exist is a 404, handled in `probe`'s
// `catch` before this runs.
function ripplingAccepts(data: unknown): boolean {
  return asArray(data).length > 0;
}

// `ACCEPTS` must type its functions `(data: unknown, name: string) => boolean`
// for every platform, `strict: true` (tsconfig.json) makes a function typed
// to take `html: string` unassignable into that slot (contravariance), and
// `unknown | string` collapses to plain `unknown` rather than fixing it. So
// every HTML-based accept function below declares `data: unknown` too and
// narrows internally with `typeof data === "string" ? data : ""`, the same
// way the JSON-based ones above already narrow with `asRecord`/`asArray`.

const TITLE_TAG = /<title>([\s\S]*?)<\/title>/;

// Jobvite's listing page states the account's name in its <title>
// ("{Name} Careers", confirmed live on one tenant); a page
// with at least one job row (the `jv-job-list-name` cell class, confirmed
// in jobvite.ts's own listing parser) and a matching name is the board.
function jobviteAccepts(data: unknown, name: string): boolean {
  const html = typeof data === "string" ? data : "";
  if (!html.includes('class="jv-job-list-name"')) return false;
  const title = (TITLE_TAG.exec(html)?.[1] ?? "").trim();
  if (!title.endsWith(" Careers")) return false;
  const reported = title.slice(0, -" Careers".length).trim();
  return reported !== "" && namesMatch(reported, name);
}

// Avature is a skinned portal; the two tenants checked live disagree on
// their listing <title> format, so a name check would refuse a real board
// as often as it confirms one. A page with at least one
// JobDetail link is the evidence, like Ashby's and Lever's boards.
function avatureAccepts(data: unknown): boolean {
  const html = typeof data === "string" ? data : "";
  return /\/JobDetail\//.test(html);
}

// Breezy states the account's name on every listing entry, in a top-level
// `company.name` field (confirmed live: the board checked states
// `"company":{"name":"<account name>", ...}` on every entry).
function breezyAccepts(data: unknown, name: string): boolean {
  const entries = asArray(data);
  const first = entries[0];
  if (first === undefined) return false;
  const reported = asText(asRecord(asRecord(first)["company"])["name"]);
  return reported !== null && namesMatch(reported, name);
}

// JazzHR's listing states the account's name in its <title>
// ("{Name} - Career Page", confirmed live - the same suffix jazzhr.ts's
// own detail-title parser strips).
function jazzhrAccepts(data: unknown, name: string): boolean {
  const html = typeof data === "string" ? data : "";
  const title = (TITLE_TAG.exec(html)?.[1] ?? "").trim();
  if (!title.endsWith(" - Career Page")) return false;
  const reported = title.slice(0, -" - Career Page".length).trim();
  return reported !== "" && namesMatch(reported, name);
}

// Recruitee states the account's name on every offer, in a top-level
// `company_name` field (confirmed live: the board checked states
// `"company_name":"<account name> GmbH"` on every offer).
function recruiteeAccepts(data: unknown, name: string): boolean {
  const offers = asArray(asRecord(data)["offers"]);
  const first = offers[0];
  if (first === undefined) return false;
  const reported = asText(asRecord(first)["company_name"]);
  return reported !== null && namesMatch(reported, name);
}

// HRMDirect's listing states the account's name in its <title>
// ("Careers At {Name}", confirmed live on one tenant).
function hrmdirectAccepts(data: unknown, name: string): boolean {
  const html = typeof data === "string" ? data : "";
  const title = (TITLE_TAG.exec(html)?.[1] ?? "").trim();
  const prefix = "Careers At ";
  if (!title.startsWith(prefix)) return false;
  const reported = title.slice(prefix.length).trim();
  return reported !== "" && namesMatch(reported, name);
}

const ACCEPTS: Record<(typeof SLUG_PLATFORMS)[number], (data: unknown, name: string) => boolean> = {
  greenhouse: greenhouseAccepts,
  ashby: ashbyAccepts,
  lever: leverAccepts,
  smartrecruiters: smartrecruitersAccepts,
  workable: workableAccepts,
  rippling: ripplingAccepts,
  jobvite: jobviteAccepts,
  avature: avatureAccepts,
  breezy: breezyAccepts,
  jazzhr: jazzhrAccepts,
  recruitee: recruiteeAccepts,
  hrmdirect: hrmdirectAccepts,
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
    case "rippling":
      return `https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`;
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

// One platform's candidates, in order, stopping at the first slug that both
// answers and passes `ACCEPTS`; a slug that answers but fails the name check
// is not a board, and a later candidate may still be the real slug. Serial,
// so that however many platforms run at once, this platform's own host still
// receives one request at a time from a given name.
async function probePlatform(
  platform: (typeof SLUG_PLATFORMS)[number],
  slugs: readonly string[],
  name: string,
  options: HttpOptions,
): Promise<Board | null> {
  for (const slug of slugs) {
    let data: unknown;
    try {
      data = TEXT_PLATFORMS.has(platform)
        ? await getText(urlFor(platform, slug), options)
        : await getJson<unknown>(urlFor(platform, slug), options);
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
      // handling and needs no change. scripts/reprobe.ts stops the pass.
      //
      // 429 only, deliberately. A 5xx is also not an answer, but no probe
      // has been measured failing that way, and a case is not handled here
      // until it is seen.
      if (error instanceof HttpError && error.status === 429) throw error;
      continue;
    }
    if (ACCEPTS[platform](data, name)) return { platform, id: slug };
  }
  return null;
}

// The twelve platforms are twelve different hosts and http.ts's
// `rateLimit` is per-host, so asking them one after another stacked twelve
// unrelated politeness waits end to end: measured live 2026-09-22, one name
// cost 8.5s on average, 11s when no board was found and every candidate was
// tried everywhere. Asked together, a name costs the slowest single
// platform's own candidate chain rather than the sum of all twelve - about
// 2s.
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
// two names probed at once share all twelve hosts.
//
// `platforms` narrows which of them are asked, for a caller that already
// knows the answer for the rest: scripts/reprobe.ts walks names the store
// has held since before a platform existed, and asking a vendor a question
// already answered, once per name, is what earned the tool a Workable block
// on 2026-09-22. It defaults to all twelve, so discover.ts's call is
// unchanged.
export async function probe(
  name: string,
  options?: HttpOptions,
  platforms: readonly SlugPlatform[] = SLUG_PLATFORMS,
): Promise<Board[]> {
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

  return found.filter((board) => board !== null);
}
