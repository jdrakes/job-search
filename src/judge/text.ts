// The five criteria judged off a posting's body; `judge.ts` runs them only
// on what `listing.ts` kept.
import type { Criteria, Posting, Workplace } from "../schema.ts";
import { foreignPlace, unitedStatesPlace } from "./countries.ts";
import type { Reason } from "./listing.ts";
import { findWholeWord, wholeWordPattern } from "./whole-word.ts";

function matchesAny(
  text: string,
  terms: readonly string[],
): { readonly term: string; readonly index: number } | null {
  for (const term of terms) {
    const index = findWholeWord(text, term);
    if (index !== null) return { term, index };
  }
  return null;
}

// Per sentence, not the whole body: a state named in passing must not sink
// a posting the way a sentence stating the rule does. A newline is a
// boundary too: `htmlToText` turns a block tag into one, and a bulleted
// list carries no punctuation.
function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

// Scored against boards' own workplace labels, these reject on-site roles
// more often than remote; any other phrase tried rejected remote roles
// above the base rate. A day count beside "the office" states attendance
// the way these five do; bare "in the office" does not.
const OFFICE_ATTENDANCE_PHRASES = [
  "onsite",
  "on-site",
  "on site",
  "in office",
  "in-office",
] as const;

const OFFICE_DAYS_PATTERNS: readonly RegExp[] = [
  /\bdays?\b[^.]{0,60}\bin (?:the|our|an?) office\b/i,
  /\bin (?:the|our|an?) office\b[^.]{0,60}\bdays?\b/i,
];

// A clause that lists what the company gives ("in-office benefits include
// lunch stipends") is not this role's office requirement.
const PERK_SIGNALS = [
  "benefit",
  "benefits",
  "perk",
  "perks",
  "stipend",
  "stipends",
  "reimbursed",
  "reimbursement",
  "commuter",
  "catered",
  "snacks",
  "onsites",
  "offsite",
  "offsites",
  "wellness",
  "paid time off",
  "pto",
  "insurance",
] as const;

const UNCONDITIONAL_REMOTE_AFFIRMATIONS = ["work from home", "work from anywhere"] as const;

// A location line states the role's place first: "Remote (US), or Ann
// Arbor, MI (Hybrid)"; the same tagged: "Location: Remote (U.S.)".
const LOCATION_LINE_REMOTE_AFFIRMATION = /^remote\b/i;
const LOCATION_LABEL_REMOTE_AFFIRMATION = /^location:.*\bremote\b/i;

// Phrasings that predicate remoteness of the job: bare "remote" scores
// worse on both remote roles lost and on-site roles admitted.
const ROLE_REMOTE_AFFIRMATIONS: readonly RegExp[] = [
  /\b(?:fully|entirely|completely|100%)[\s-]remote(?:ly)?\b/i,
  /\bremote[\s-](?:eligible|first|friendly)\b/i,
  /\bremote (?:role|position|job|opportunity|work environment)\b/i,
  /\b(?:is|are|be)(?: an?)? remote\b/i,
  /\bopen to remote\b/i,
  /\bwork(?:s|ing)? remotely\b/i,
  /\bor remote\b/i,
  /\bbased remotely\b/i,
  /\ball[\s-]remote\b/i,
];

// The recruiter's own tag: a posting tagged remote is remote, whatever else
// its prose says.
const RECRUITER_REMOTE_TAG = /#LI[\s-]?remote\b/i;

function affirmsRemoteRole(sentence: string): boolean {
  const stripped = sentence.startsWith("- ") ? sentence.slice(2) : sentence;
  if (matchesAny(sentence, UNCONDITIONAL_REMOTE_AFFIRMATIONS) !== null) return true;
  if (RECRUITER_REMOTE_TAG.test(stripped)) return true;
  if (ROLE_REMOTE_AFFIRMATIONS.some((pattern) => pattern.test(stripped))) return true;
  // The two positional patterns read where "remote" sits, not its grammar,
  // so a perks line starting "Remote work, medical insurance, ..." would
  // slip through them.
  if (matchesAny(sentence, PERK_SIGNALS) !== null) return false;
  return (
    LOCATION_LINE_REMOTE_AFFIRMATION.test(stripped) ||
    LOCATION_LABEL_REMOTE_AFFIRMATION.test(stripped)
  );
}

// The office requirement this clause states, or null: a clause that says the
// role is remote is answering the question, and a perks clause is not a
// requirement.
function officeRequirement(sentence: string): string | null {
  if (affirmsRemoteRole(sentence)) return null;
  if (matchesAny(sentence, PERK_SIGNALS) !== null) return null;
  const phrase = matchesAny(sentence, OFFICE_ATTENDANCE_PHRASES);
  if (phrase !== null) return phrase.term;
  for (const pattern of OFFICE_DAYS_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match !== null) return match[0];
  }
  return null;
}

const LOCATION_REMOTE_NEGATIONS = /\b(?:non|not)[\s-]*remote\b/i;

function locationAffirmsRemote(location: string | null): boolean {
  if (location === null) return false;
  if (LOCATION_REMOTE_NEGATIONS.test(location)) return false;
  return findWholeWord(location, "remote") !== null;
}

// The board's workplace label decides where there is one. Otherwise the
// text affirms remote, or the location does; a stated office requirement in
// the text overrules either unless the recruiter's tag or the location
// names Remote. Scored by `npm run score:remote`; a change to these phrase
// lists records the before/after in the commit.
function judgeRemote(body: string, location: string | null, workplace: Workplace | null): Reason {
  if (workplace !== null) {
    return {
      criterion: "remote",
      verdict: workplace === "remote" ? "in" : "out",
      detail: `board states ${workplace}`,
    };
  }
  const sentences = splitSentences(body);
  if (!RECRUITER_REMOTE_TAG.test(body) && !locationAffirmsRemote(location)) {
    for (const sentence of sentences) {
      const office = officeRequirement(sentence);
      if (office !== null) {
        return {
          criterion: "remote",
          verdict: "out",
          detail: `body requires office attendance ("${office}"): "${sentence}"`,
        };
      }
    }
  }
  for (const sentence of sentences) {
    if (affirmsRemoteRole(sentence)) {
      return { criterion: "remote", verdict: "in", detail: `body affirms remote: "${sentence}"` };
    }
  }
  if (locationAffirmsRemote(location)) {
    return { criterion: "remote", verdict: "in", detail: `location affirms remote: "${location}"` };
  }
  if (body.trim() === "") {
    return { criterion: "remote", verdict: "out", detail: "body is empty, so nothing was read" };
  }
  return { criterion: "remote", verdict: "out", detail: "body says nothing about remote" };
}

// A state's name alone is not a rule (a headquarters address names one too),
// so a match only counts in a sentence that also says the state is out.
const INELIGIBILITY_SIGNALS = [
  "not eligible",
  "not open to",
  "ineligible",
  "excluded",
  "excluding",
  "unable to hire",
  "cannot hire",
  "do not hire",
  "not available to",
  "restricted from",
] as const;

function judgeExcludedStates(body: string, criteria: Criteria): Reason {
  const sentences = splitSentences(body);
  for (const sentence of sentences) {
    const state = matchesAny(sentence, criteria.excluded_states);
    if (state === null) continue;
    const signal = matchesAny(sentence, INELIGIBILITY_SIGNALS);
    if (signal !== null) {
      return {
        criterion: "excluded_states",
        verdict: "out",
        detail: `body names "${state.term}" as ineligible: "${sentence}"`,
      };
    }
  }
  return {
    criterion: "excluded_states",
    verdict: "in",
    detail: "body names no excluded state as ineligible",
  };
}

// The text half of "United States only"; the label half is `country` in
// listing.ts. A country's name alone is not a restriction ("offices in
// Dublin and Berlin"); it counts only in a sentence that binds a person to
// the place ("must reside in Germany").
const RESIDENCY_SIGNALS = [
  "based in",
  "residing in",
  "resident of",
  "residents of",
  "residence required",
  "residency required",
  "must live in",
  "must be located in",
  "must be located within",
  "eligible to work in",
  "authorized to work in",
  "authorised to work in",
  "legally authorized to work in",
  "right to work in",
  "work authorization in",
  "work authorisation in",
  "open to candidates in",
  "only hiring in",
  "can only hire in",
] as const;

// "based in" is too loose for `judgeRemote` (many postings carry an
// arrest-record notice reading "For positions based in San Francisco or Los
// Angeles") but safe here: the sentence must also name a foreign country and
// not the United States. "based in the Philippines" needs it.
function judgeCountryRestriction(body: string): Reason {
  for (const sentence of splitSentences(body)) {
    const foreign = foreignPlace(sentence);
    if (foreign === null) continue;
    const signal = matchesAny(sentence, RESIDENCY_SIGNALS);
    if (signal === null) continue;
    if (unitedStatesPlace(sentence) !== null) continue;
    return {
      criterion: "country_restriction",
      verdict: "out",
      detail: `body restricts the role to "${foreign}" ("${signal.term}"): "${sentence}"`,
    };
  }
  return {
    criterion: "country_restriction",
    verdict: "in",
    detail: "body restricts the role to no country other than the United States",
  };
}

// A sentence carrying one of these welcomes the language it names; a
// sentence carrying none of them requires it.
const WELCOME_SIGNALS = [
  "nice to have",
  "bonus",
  "plus",
  "preferred",
  "familiarity",
  "exposure",
] as const;

// "go"/"golang" match only capitalized: "go" is an ordinary English word,
// and case-insensitive it reads almost every culture blurb as a language
// requirement.
const CASE_SENSITIVE_TERMS = new Set(["go", "golang"]);

function properNoun(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

// A web address is not a mention: "visit www.thunderbird.net" read as a
// .NET requirement. Blanked to spaces of its own length, so an index into
// the result is an index into the sentence.
const WEB_ADDRESS = /(?:https?:\/\/|\bwww\.)\S+/gi;

function withoutWebAddresses(sentence: string): string {
  return sentence.replace(WEB_ADDRESS, (address) => " ".repeat(address.length));
}

function findLanguageMention(sentence: string, term: string): number | null {
  const text = withoutWebAddresses(sentence);
  return CASE_SENSITIVE_TERMS.has(term)
    ? findWholeWord(text, properNoun(term), true)
    : findWholeWord(text, term);
}

// Capitalized "Go" is still an English verb at the start of a clause or list
// item ("Learn Fast, Align, Adapt & Go!"), so a "Go" mention counts only
// where the clause is about programming at all.
const ENGLISH_WORD_TERMS = new Set(["go"]);

// Generous on purpose: a word too many costs nothing, a word too few lets a
// real Go requirement through.
const PROGRAMMING_CUES = [
  "api",
  "apis",
  "backend",
  "back-end",
  "code",
  "codebase",
  "coding",
  "developer",
  "development",
  "distributed",
  "engineer",
  "engineering",
  "expert",
  "expertise",
  "experience",
  "familiarity",
  "fluency",
  "fluent",
  "framework",
  "frameworks",
  "knowledge",
  "language",
  "languages",
  "library",
  "libraries",
  "microservices",
  "proficiency",
  "proficient",
  "programming",
  "services",
  "skill",
  "skills",
  "software",
  "stack",
  "systems",
  "write",
  "writing",
  "written",
  "years",
] as const;

// Language names, so the rule below can ask whether an alternatives list
// offers one James has: a name here that `missing_languages` does not carry
// is one he has.
const LANGUAGE_NAMES = [
  "c",
  "c#",
  "c++",
  "clojure",
  "dart",
  "elixir",
  "erlang",
  "go",
  "golang",
  "groovy",
  "haskell",
  "java",
  "javascript",
  "julia",
  "kotlin",
  "lua",
  ".net",
  "objective-c",
  "ocaml",
  "perl",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "solidity",
  "swift",
  "typescript",
  "zig",
] as const;

// A language name this clause offers that `missing_languages` does not
// carry. The `(?![+#])` guard: `\bC\b` matches the C of "C++", so without
// it "C++14/17 or later" reads as a list offering C. The boundary comes from
// `wholeWordPattern` so a punctuation-edged name (".net", "c#") is
// recognised here the same way it is as a requirement.
function acceptedLanguage(sentence: string, criteria: Criteria): string | null {
  for (const name of LANGUAGE_NAMES) {
    if (criteria.missing_languages.some((missing) => missing.toLowerCase() === name)) continue;
    if (!new RegExp(`${wholeWordPattern(name)}(?![+#])`, "i").test(sentence)) continue;
    return name;
  }
  return null;
}

// A clause that offers a choice of languages rather than naming one
// ("languages like Python or Kotlin", "Python/C/C++/Rust or similar"). A
// bare "or" is a cue on its own; what it gets wrong is glued bullet blobs,
// which `splitSentences`'s newline boundary separates.
const ALTERNATIVES_CUES = [
  "and/or",
  "any of",
  "e.g",
  "like",
  "one of",
  "one or more",
  "or",
  "or another",
  "or equivalent",
  "or other",
  "or similar",
  "such as",
] as const;

// A heading that opens a list of what the company runs on; the languages
// under it are what the team uses, not what the posting asks of a
// candidate. Every cue is multi-word: bare "stack" is in every third
// full-stack title.
const STACK_LISTING_CUES = [
  "built on",
  "built with",
  "our stack",
  "stack we use",
  "tech stack",
  "technologies used",
  "technologies we teach",
  "technologies we use",
  "technology stack",
  "tools we use",
  "what we use",
] as const;

// What ends a stack listing: the posting has gone back to asking for
// something. A heading has to govern the clauses under it because
// `splitSentences` splits "Technologies We Use" from "Java, Kotlin, Ruby".
const REQUIREMENT_SIGNALS = [
  "background in",
  "expert",
  "expertise",
  "experience",
  "must",
  "proficiency",
  "proficient",
  "qualifications",
  "require",
  "required",
  "requirements",
  "requires",
  "should have",
  "track record",
  "years",
] as const;

// A mention requires the language by default; these four shapes welcome it
// instead.
function judgeMissingLanguages(body: string, criteria: Criteria): Reason {
  let inStackListing = false;
  for (const sentence of splitSentences(body)) {
    if (matchesAny(sentence, STACK_LISTING_CUES) !== null) {
      inStackListing = true;
    } else if (matchesAny(sentence, REQUIREMENT_SIGNALS) !== null) {
      inStackListing = false;
    }
    if (inStackListing) continue;
    for (const term of criteria.missing_languages) {
      if (findLanguageMention(sentence, term) === null) continue;
      if (ENGLISH_WORD_TERMS.has(term) && matchesAny(sentence, PROGRAMMING_CUES) === null) continue;
      if (matchesAny(sentence, WELCOME_SIGNALS) !== null) continue;
      if (
        matchesAny(sentence, ALTERNATIVES_CUES) !== null &&
        acceptedLanguage(sentence, criteria) !== null
      ) {
        continue;
      }
      return {
        criterion: "missing_languages",
        verdict: "out",
        detail: `body requires "${term}": "${sentence}"`,
      };
    }
  }
  return {
    criterion: "missing_languages",
    verdict: "in",
    detail: "every missing-language mention is welcomed, or none appears",
  };
}

// Phrasings that state a bonus target rather than merely mentioning one.
// Each captures the percentage in a fixed position relative to "bonus", so
// a weighting ("individual performance (50%)") never matches.
const BONUS_TARGET_PATTERNS: readonly RegExp[] = [
  /\btarget bonus of (\d{1,3})%/i,
  /\bbonus target (\d{1,3})%/i,
  /\b(\d{1,3})% bonus target/i,
  /\bannual bonus of (?:up to )?(\d{1,3})%/i,
  /\b(\d{1,3})% (?:annual |performance |target )?bonus\b/i,
  /\bbonus\b[^.]*?\bpays (\d{1,3})% of base\b/i,
];

// Capped at 50: above that is a weighting or a sales plan, not an
// engineer's target.
function statedBonusTarget(sentence: string): number | null {
  let max: number | null = null;
  for (const pattern of BONUS_TARGET_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match === null || match[1] === undefined) continue;
    const value = Number(match[1]);
    if (max === null || value > max) max = value;
  }
  return max === null ? null : Math.min(max, 50);
}

// The largest stated target across the whole body, since a body can state
// one more than once, and the sentence it came from for the reason's quote.
function findStatedBonusTarget(
  sentences: readonly string[],
): { readonly rate: number; readonly sentence: string } | null {
  let best: { rate: number; sentence: string } | null = null;
  for (const sentence of sentences) {
    if (findWholeWord(sentence, "bonus") === null) continue;
    const target = statedBonusTarget(sentence);
    if (target === null) continue;
    if (best === null || target > best.rate) best = { rate: target, sentence };
  }
  return best;
}

// A pay bonus mentioned with no stated rate still lets the assumed rate
// settle the floor — but only when the sentence reads as pay: the word
// before it is a PAY_BONUS_QUALIFIER, a PAY_BONUS_FOLLOWER comes after it in
// the same sentence, or the sentence names pay (PAY_CONTEXT_WORDS). The
// bare singular word admits a nice-to-have heading ("Bonus Points", "AWS a
// bonus") and misses a body that says "bonuses".
const PAY_BONUS_QUALIFIERS = [
  "annual",
  "target",
  "corporate",
  "performance",
  "performance-based",
  "discretionary",
  "variable",
  "cash",
  "company",
  "quarterly",
] as const;

const PAY_BONUS_FOLLOWERS = [
  "plan",
  "program",
  "scheme",
  "eligibility",
  "eligible",
  "opportunity",
  "potential",
  "structure",
  "target",
] as const;

const PAY_CONTEXT_WORDS = ["salary", "compensation", "base", "pay", "equity"] as const;

// Not pay for the work, so says nothing about whether the base clears the
// floor — even in a sentence that otherwise reads as pay.
const NON_PAY_BONUS_QUALIFIERS = [
  "referral",
  "sign-on",
  "signing",
  "retention",
  "relocation",
  "spot",
  "holiday",
] as const;

// A mention the sentence negates names no pay bonus: "The base salary range
// does not include any bonuses" names salary and would otherwise read as
// pay. The phrase must come before the mention; "no" is read as the
// qualifier ("no bonus") rather than as a phrase, since bare "no" occurs
// anywhere.
const BONUS_NEGATION_PHRASES = ["does not include", "do not include", "not eligible for"] as const;

// The word immediately before "bonus" or "bonuses", if any. Global so a
// sentence naming both an excluded and a real bonus ("a sign-on bonus and an
// annual bonus") is read past the first, excluded, mention.
const BONUS_MENTION = /\b(?:([A-Za-z-]+)\s+)?bonus(?:es)?\b/gi;

function isListed(word: string, list: readonly string[]): boolean {
  return list.includes(word);
}

function namesPayBonus(sentence: string): boolean {
  for (const match of sentence.matchAll(BONUS_MENTION)) {
    const qualifier = (match[1] ?? "").toLowerCase();
    if (isListed(qualifier, NON_PAY_BONUS_QUALIFIERS)) continue;
    const before = sentence.slice(0, match.index);
    if (qualifier === "no" || matchesAny(before, BONUS_NEGATION_PHRASES) !== null) continue;
    if (isListed(qualifier, PAY_BONUS_QUALIFIERS)) return true;
    const after = sentence.slice(match.index + match[0].length);
    if (matchesAny(after, PAY_BONUS_FOLLOWERS) !== null) return true;
    if (matchesAny(sentence, PAY_CONTEXT_WORDS) !== null) return true;
  }
  return false;
}

// The first sentence that reads as pay, so the reason quotes that one and
// not an earlier "Bonus Skills" heading.
function findPayBonusMention(sentences: readonly string[]): string | null {
  for (const sentence of sentences) {
    if (namesPayBonus(sentence)) return sentence;
  }
  return null;
}

function bonusEffectiveVerdict(
  compHigh: number,
  rate: number,
  basis: "stated" | "assumed",
  sentence: string,
  floor: number,
): Reason {
  const effective = Math.round(compHigh * (1 + rate / 100));
  const verdict = effective >= floor ? "in" : "out";
  const reach = verdict === "in" ? "reaches" : "reaches only";
  return {
    criterion: "bonus",
    verdict,
    detail: `comp_high ${compHigh} plus the ${basis} ${rate}% bonus ${reach} ${effective}, ${
      verdict === "in" ? "at or above" : "below"
    } the floor ${floor}: "${sentence}"`,
  };
}

// The last-resort settler for a base under the floor that `judgeCompFloor`
// let through on the strength of `criteria.assumed_bonus_pct` alone. A
// stated target always wins over the assumed rate, even a lower one.
function judgeBonus(compHigh: number | null, body: string, criteria: Criteria): Reason {
  if (compHigh === null || compHigh >= criteria.comp_floor) {
    return { criterion: "bonus", verdict: "in", detail: "the floor is settled without a bonus" };
  }
  const sentences = splitSentences(body);
  const stated = findStatedBonusTarget(sentences);
  if (stated !== null) {
    return bonusEffectiveVerdict(
      compHigh,
      stated.rate,
      "stated",
      stated.sentence,
      criteria.comp_floor,
    );
  }
  if (criteria.assumed_bonus_pct !== null) {
    const mention = findPayBonusMention(sentences);
    if (mention !== null) {
      return bonusEffectiveVerdict(
        compHigh,
        criteria.assumed_bonus_pct,
        "assumed",
        mention,
        criteria.comp_floor,
      );
    }
  }
  return {
    criterion: "bonus",
    verdict: "out",
    detail: `comp_high ${compHigh} is below the floor ${criteria.comp_floor} and the text names no bonus`,
  };
}

export function judgeText(
  posting: Pick<Posting, "body" | "location" | "comp_high" | "workplace">,
  criteria: Criteria,
): { readonly kept: boolean; readonly reasons: Reason[] } {
  const body = posting.body ?? "";
  const reasons: Reason[] = [
    judgeRemote(body, posting.location, posting.workplace),
    judgeExcludedStates(body, criteria),
    judgeCountryRestriction(body),
    judgeMissingLanguages(body, criteria),
    judgeBonus(posting.comp_high, body, criteria),
  ];
  return { kept: reasons.every((reason) => reason.verdict === "in"), reasons };
}
