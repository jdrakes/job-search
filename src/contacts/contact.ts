// A thread becomes a contact. The counterpart is the party who is not
// James, and identity is that address lowercased: nothing merges two
// addresses automatically, so a recruiter who changed mailbox is two rows
// James joins with `alias_of` rather than a guess made here. LinkedIn
// InMail is the one exception, because it gives every recruiter the same
// sender address; there the identity is synthesised from the display name
// so that two people stay two rows. See `identityOf`.
//
// `now` is a parameter, never `new Date()` in here: `state` is the only
// derived column that moves on its own, and reading the clock would make
// the active boundary untestable and every test dated.
//
// Everything returned is the processor's. `dropped_at`, `reason`, `note`,
// `contacted_at` and `alias_of` are James's: they are null here and are
// written by nobody but him, which is the shape a re-run must not erase.
import type { CompanyObservation, Contact, ContactState, ContactThread } from "../schema.ts";
import type { Capture, CaptureMessage, CaptureThread } from "./capture.ts";
import { findWholeWord } from "../judge/whole-word.ts";
import { hasReplyFromJames, isExcludedSender } from "./exclude.ts";

// Domains that name where somebody reads mail, or which relay carried it,
// never who they work for. Free mail is a personal mailbox: the signature
// names the agency or nothing does. `linkedin.com` is the InMail relay, and
// reading it as a company files a recruiter who did not sign off under
// "Linkedin" and then records Linkedin as a former employer the moment she
// sends a signed one.
const NON_COMPANY_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "hotmail.com",
  "linkedin.com",
] as const;

// Deliberately partial, and a hand-written list rather than a dependency:
// the two-part public suffixes a recruiter writing to James plausibly uses.
// Without it the label before the last is the suffix's own first half, and
// `brackenhall.co.uk` reads as "Co".
const TWO_PART_SUFFIXES = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "co.jp",
  "com.br",
  "com.sg",
] as const;

// The two addresses LinkedIn puts on a real recruiter's InMail, carved out
// of the job-alert exclusion in exclude.ts and worth recording as a signal.
const INMAIL_ADDRESSES = ["inmail-hit-reply@linkedin.com", "hit-reply@linkedin.com"] as const;

// Deliberately generous. Too short and James writes cold to someone he is
// mid-conversation with, which is the embarrassing failure; a stale row
// sitting in `active` for a quarter is one he can see and move.
const ACTIVE_DAYS = 90;
const DAY_MS = 86_400_000;

function addressOf(sender: string): string {
  return sender.toLowerCase().trim();
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1);
}

// An unparseable date is a capture a session wrote badly, not a crash: the
// message contributes no time and a thread with no time at all is skipped.
function timeOf(date: string): number | null {
  const milliseconds = Date.parse(date);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function isoOf(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

// Undated messages sort last so a thread's counterpart is read off the
// oldest message that carries a date.
function byDate(messages: readonly CaptureMessage[]): readonly CaptureMessage[] {
  return [...messages].sort(
    (first, second) =>
      (timeOf(first.date) ?? Number.MAX_SAFE_INTEGER) -
      (timeOf(second.date) ?? Number.MAX_SAFE_INTEGER),
  );
}

// The address a reply to this thread would go to: the oldest sender who is
// neither James nor an excluded one. Stopping at the oldest sender full
// stop loses real people, because Gmail threads a recruiter's personal
// reply onto the ATS mail it answers and the ATS address is the older of
// the two.
function counterpartOf(thread: CaptureThread, account: string): string | null {
  const mine = addressOf(account);
  for (const message of byDate(thread.messages)) {
    const sender = addressOf(message.sender);
    if (sender === "" || sender === mine) continue;
    if (isExcludedSender(sender)) continue;
    return sender;
  }
  return null;
}

// An InMail key carries this scheme and no `@`, so nothing downstream can
// read it as a mailbox and try to send to it: the address the mail came
// from reaches LinkedIn's relay, not the person, and ordinary mail to an
// InMail contact cannot be sent at all. The real address is kept on the
// row's `signals` beside the `linkedin-inmail` flag.
const INMAIL_KEY_SCHEME = "linkedin-inmail:";

function isInMail(address: string): boolean {
  return (INMAIL_ADDRESSES as readonly string[]).includes(address);
}

// Who the thread is with, as a key. Ordinarily that is the reply address
// itself. Every InMail arrives from one shared address, so there the key is
// synthesised from the sender's display name: grouping on the address files
// two recruiters as one row carrying the later one's name and the earlier
// one's agency as a former employer, and `alias_of` cannot undo it, because
// it merges and this needs splitting. Two InMail senders who display the
// same name do still merge, which is as far as a display name goes.
function identityOf(replyAddress: string, displayName: string | null): string | null {
  if (!isInMail(replyAddress)) return replyAddress;
  const slug = (displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // An InMail with no display name names nobody, and the shared address is
  // not a person. Filing it under that address would merge it with the next
  // nameless one, which is the bug this function exists to prevent, so the
  // thread yields no contact at all.
  return slug === "" ? null : `${INMAIL_KEY_SCHEME}${slug}`;
}

// The sign-offs that introduce a signature block. A reply carries the
// quoted chain below it, so the first sign-off in the body is the writer's
// own and the lines under it are theirs.
const SIGN_OFFS = [
  "best",
  "best regards",
  "kind regards",
  "warm regards",
  "regards",
  "thanks",
  "thank you",
  "many thanks",
  "cheers",
  "sincerely",
  "best wishes",
] as const;

interface Signature {
  readonly name: string | null;
  readonly company: string | null;
}

// Words that make a line the role somebody holds rather than the agency
// they hold it at. "Search", "Talent", "Partners" and "Recruitment" are all
// commoner in an agency's name than in a title and are deliberately absent:
// skipping the company line is a worse failure than keeping a title.
const TITLE_WORDS = [
  "recruiter",
  "sourcer",
  "headhunter",
  "manager",
  "director",
  "specialist",
  "coordinator",
  "consultant",
  "head of",
  "talent acquisition",
  "talent partner",
  "people operations",
] as const;

function readsAsJobTitle(line: string): boolean {
  return TITLE_WORDS.some((word) => findWholeWord(line, word) !== null);
}

// A pronoun declaration sits where the agency usually does. Matched as a
// shape rather than a list so "(she/her)" and "she / her / hers" both go.
const PRONOUNS = /^\(?\s*(she|he|they|ze|xe)\s*\/\s*\w+(\s*\/\s*\w+)?\s*\)?$/i;

// A link bar: "Website | LinkedIn | 973.809.0637". Two or more segments
// divided by pipes or bullets is a navigation strip, never a firm's name.
const LINK_BAR = /[|·•]/;

// Lines that sit under a sign-off but never name an agency. Every shape
// here was a wrong `company` on a real row before it was rejected: a
// pronoun declaration, a link bar, a horizontal rule of underscores or
// dashes, and the writer's own name repeated beneath itself.
function namesNoCompany(line: string, name: string | null): boolean {
  if (!/\p{L}/u.test(line)) return true;
  if (PRONOUNS.test(line)) return true;
  if (LINK_BAR.test(line) && line.split(/[|·•]/).filter((part) => part.trim() !== "").length > 1) {
    return true;
  }
  if (name === null) return false;
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .filter((word) => word !== "");
  const here = words(line);
  const whose = words(name);
  if (here.length === 0 || whose.length === 0) return false;
  // One of the two is built entirely from the other's words, so the line is
  // her and not the firm. It runs both ways because a sign-off gives either
  // half: "Madeline" under "Madeline Connell" is shorter than the name,
  // "Brittan Locke" under a "Brittan" sign-off is longer, and "Jon Salter"
  // under itself is neither. A firm named after its founder has a word from
  // neither side -- "Hollowby Talent Group" under "Wren Hollowby" brings
  // "talent" and "group" and "Wren" is missing -- so it survives.
  const within = (inner: readonly string[], outer: readonly string[]) =>
    inner.every((word) => outer.includes(word));
  return within(here, whose) || within(whose, here);
}

// How far under the name to look for the agency: the title line, a second
// title line under it, and the agency. Past that the block is into contact
// details or the quoted mail below.
const COMPANY_LINES_READ = 3;

// The line under the name is the agency, unless it reads as the title she
// holds, in which case the agency is the line under that: "Jane Harper /
// Senior Technical Recruiter / Harperlane Partners" is the commonest
// recruiter signature there is, and taking the line after the name stored
// the title as the company. A phone number, a mail address or a URL is a
// contact detail, and the block has passed the agency by the time one
// appears, so the search stops there rather than reading into quoted text.
function companyUnder(lines: readonly string[], start: number, name: string | null): string | null {
  for (let offset = 0; offset < COMPANY_LINES_READ; offset += 1) {
    const line = lines[start + offset];
    if (line === undefined) return null;
    if (line.includes("@") || /https?:\/\//i.test(line)) return null;
    if (/^[+\d][\d\s()+.-]*$/.test(line)) return null;
    if (readsAsJobTitle(line)) continue;
    if (namesNoCompany(line, name)) continue;
    return line;
  }
  return null;
}

function signatureOf(body: string | undefined, knownName: string | null = null): Signature {
  const lines = (body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // The LAST sign-off, not the first. "Thank you!" is a valediction people
  // write mid-message before the real one: Madeline's mail ends "Thank
  // you! / Best, / Madeline / Recruiting Operations Specialist", and taking
  // the first match read "Best," as her name and her first name as the
  // firm. The quoted chain is trimmed from the body before this, so the
  // last sign-off in what remains is the writer's own.
  const isSignOff = (line: string) =>
    (SIGN_OFFS as readonly string[]).includes(line.replace(/[,.!]+$/, "").toLowerCase());
  const signOff = lines.reduce((last, line, index) => (isSignOff(line) ? index : last), -1);
  if (signOff === -1) return { name: null, company: null };
  const name = lines[signOff + 1] ?? null;
  // The display name the mail carried is surer than a line position, so it
  // is what a candidate is compared against when there is one.
  return { name, company: companyUnder(lines, signOff + 2, knownName ?? name) };
}

// `kestrelmoor.partners` is Kestrelmoor: the label before the public suffix
// is the only part a registrable-domain list would agree with for free, and
// a full one is a dependency. `TWO_PART_SUFFIXES` covers the suffixes where
// that label is one word further left, and a signature naming the agency
// overrides all of this anyway.
// A domain label is a spelling of the firm, not its name. Where the two
// differ the operator supplies the mapping in settings, because which
// firms appear there is a fact about their correspondence, not about the
// tool. A signature naming the firm still wins over all of this.
function companyFromDomain(
  domain: string,
  domainAliases: Readonly<Record<string, string>> = {},
): string | null {
  if ((NON_COMPANY_DOMAINS as readonly string[]).includes(domain)) return null;
  const labels = domain.split(".");
  const twoPart = TWO_PART_SUFFIXES.some((suffix) => domain.endsWith(`.${suffix}`));
  const label = labels[labels.length - (twoPart ? 3 : 2)] ?? "";
  if (label === "") return null;
  const alias = domainAliases[label.toLowerCase()];
  if (alias !== undefined) return alias;
  return label
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// What one thread says about the counterpart. `sent` is per thread and not
// per contact: a contact is kept when James answered any of their threads,
// and the ones he ignored are still part of the relationship.
interface ThreadFacts {
  readonly id: string;
  readonly subject: string | null;
  // `key` is the identity rows group on; `replyAddress` is the mailbox the
  // message came from. They differ only for InMail.
  readonly key: string;
  readonly replyAddress: string;
  readonly domain: string;
  readonly firstTime: number;
  readonly lastTime: number;
  readonly sent: boolean;
  readonly name: string | null;
  // The company this thread's signature named, and nothing else. The
  // address's domain is a fallback for the row, not an observation about
  // where she works, so a thread that signed off nothing says nothing here.
  readonly signedCompany: string | null;
}

function threadFactsOf(thread: CaptureThread, account: string): ThreadFacts | null {
  const times: number[] = [];
  for (const message of thread.messages) {
    const time = timeOf(message.date);
    if (time !== null) times.push(time);
  }
  if (times.length === 0) return null;

  const replyAddress = counterpartOf(thread, account);
  if (replyAddress === null) return null;

  const theirs = byDate(thread.messages).filter(
    (message) => addressOf(message.sender) === replyAddress,
  );
  const newestFirst = [...theirs].reverse();
  const displayName = newestFirst.find((message) => (message.sender_name ?? "") !== "");
  const signatures = newestFirst.map((message) =>
    signatureOf(message.body, displayName?.sender_name ?? null),
  );

  const signedName = signatures.find((signature) => signature.name !== null);
  const signedCompany = signatures.find((signature) => signature.company !== null);

  const key = identityOf(replyAddress, displayName?.sender_name ?? null);
  if (key === null) return null;

  return {
    id: thread.id,
    subject: thread.subject ?? newestFirst[0]?.subject ?? null,
    key,
    replyAddress,
    domain: domainOf(replyAddress),
    firstTime: Math.min(...times),
    lastTime: Math.max(...times),
    // The inclusion bar lives once, in exclude.ts: a thread with no message
    // James sent is a sender, not a relationship.
    sent: hasReplyFromJames(thread, account),
    name: displayName?.sender_name ?? signedName?.name ?? null,
    signedCompany: signedCompany?.company ?? null,
  };
}

// Where she has worked, read off the signatures and nothing else, so that a
// recruiter who moved agency stays one relationship rather than losing where
// she was. A thread carrying no signature is skipped: it is missing
// information, not a change. Keying this on the domain fallback instead made
// an unsigned "any update?" after a signed introduction read as a move from
// "Fennimore Partners" to "Fennimore".
function observationsOf(facts: readonly ThreadFacts[]): readonly CompanyObservation[] {
  const observations: CompanyObservation[] = [];
  for (const fact of facts) {
    if (fact.signedCompany === null) continue;
    const current = observations[observations.length - 1];
    if (current !== undefined && current.company === fact.signedCompany) {
      observations[observations.length - 1] = { ...current, last_seen: isoOf(fact.lastTime) };
      continue;
    }
    observations.push({
      company: fact.signedCompany,
      domain: fact.domain,
      first_seen: isoOf(fact.firstTime),
      last_seen: isoOf(fact.lastTime),
    });
  }
  return observations;
}

// One agency spelled twice: `fennimore.partners` and a signature reading
// "Fennimore Partners" are the same firm under two spellings, where
// `thornbury.partners` and a signature reading "Kestrelmoor Search" are two
// firms. Punctuation is dropped so that a hyphenated signature and its
// unhyphenated domain agree.
function namesOneCompany(fromDomain: string, signed: string): boolean {
  const plain = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return plain(signed).includes(plain(fromDomain)) || plain(fromDomain).includes(plain(signed));
}

interface CompanyNow {
  readonly company: string | null;
  readonly history: readonly CompanyObservation[];
}

// Where she is now, and where she was before that. The latest signature
// stands, which is how a recruiter on free mail keeps the agency her
// signature gave rather than reading blank. It gives way only when the
// newest thread signed off nothing and the address she wrote from names a
// different firm: then the address is the current one and every signature
// under it is a former employer.
function companyNow(
  newest: ThreadFacts,
  observations: readonly CompanyObservation[],
  domainAliases?: Readonly<Record<string, string>>,
): CompanyNow {
  const fromDomain = companyFromDomain(newest.domain, domainAliases);
  const latest = observations[observations.length - 1];
  if (latest === undefined) return { company: fromDomain, history: [] };
  if (
    newest.signedCompany === null &&
    fromDomain !== null &&
    !namesOneCompany(fromDomain, latest.company ?? "")
  ) {
    return { company: fromDomain, history: observations };
  }
  return { company: latest.company, history: observations.slice(0, -1) };
}

function stateOf(
  domain: string,
  lastContact: number,
  now: Date,
  employerDomain?: string,
): ContactState {
  if (isEmployerDomain(domain, employerDomain)) return "employer";
  return now.getTime() - lastContact <= ACTIVE_DAYS * DAY_MS ? "active" : "target";
}

// Why this row was called a recruiter, so a wrong row reads back instead of
// being guessed at.
// The employer test is the counterpart's domain, not a company name: a name
// match would need a company list and would still miss a colleague writing
// from a plain address with no signature. Absent, nothing is an employer.
function isEmployerDomain(domain: string, employerDomain?: string): boolean {
  if (employerDomain === undefined) return false;
  return domain === employerDomain || domain.endsWith(`.${employerDomain}`);
}

function signalsOf(
  facts: readonly ThreadFacts[],
  newest: ThreadFacts,
  employerDomain?: string,
): string[] {
  const signals = ["replied-in-thread"];
  if (facts.length > 1) signals.push("repeat-correspondent");
  if (isInMail(newest.replyAddress)) {
    // The row's `email` is a synthesised key, so the address the mail came
    // from is recorded here instead: the flag says this contact is reachable
    // through InMail and not by ordinary mail, and the address says which
    // relay carried it.
    signals.push("linkedin-inmail", `reply-address:${newest.replyAddress}`);
  }
  if (isEmployerDomain(newest.domain, employerDomain)) {
    signals.push("employer-domain");
  }
  return signals;
}

function contactThreadOf(fact: ThreadFacts): ContactThread {
  return { id: fact.id, subject: fact.subject, date: isoOf(fact.lastTime), sent: fact.sent };
}

function contactOf(
  identity: string,
  facts: readonly ThreadFacts[],
  now: Date,
  employerDomain?: string,
  domainAliases?: Readonly<Record<string, string>>,
): Contact {
  const newest = facts[facts.length - 1];
  const company = companyNow(newest, observationsOf(facts), domainAliases);
  const firstContact = Math.min(...facts.map((fact) => fact.firstTime));
  const lastContact = Math.max(...facts.map((fact) => fact.lastTime));
  const named = [...facts].reverse().find((fact) => fact.name !== null);

  return {
    // The column is `email` because the address is the identity for
    // everyone but an InMail sender, whose key is synthetic.
    email: identity,
    name: named?.name ?? null,
    company: company.company,
    company_history: company.history,
    state: stateOf(newest.domain, lastContact, now, employerDomain),
    signals: signalsOf(facts, newest, employerDomain),
    first_contact: isoOf(firstContact),
    last_contact: isoOf(lastContact),
    thread_count: facts.length,
    threads: facts.map(contactThreadOf),
    last_subject: newest.subject,
    dropped_at: null,
    reason: null,
    note: null,
    contacted_at: null,
    alias_of: null,
  };
}

export function contactsOf(
  capture: Capture,
  now: Date,
  employerDomain?: string,
  domainAliases?: Readonly<Record<string, string>>,
): readonly Contact[] {
  const groups = new Map<string, ThreadFacts[]>();
  for (const thread of capture.threads) {
    const facts = threadFactsOf(thread, capture.account);
    if (facts === null) continue;
    const group = groups.get(facts.key);
    if (group === undefined) groups.set(facts.key, [facts]);
    else group.push(facts);
  }

  const contacts: Contact[] = [];
  for (const [identity, facts] of groups) {
    // The inclusion bar: someone James never answered is a sender, not a
    // relationship.
    if (!facts.some((fact) => fact.sent)) continue;
    const ordered = [...facts].sort(
      (first, second) => first.lastTime - second.lastTime || first.id.localeCompare(second.id),
    );
    contacts.push(contactOf(identity, ordered, now, employerDomain, domainAliases));
  }
  return contacts.sort((first, second) => first.email.localeCompare(second.email));
}
