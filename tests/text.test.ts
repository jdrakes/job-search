import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeText } from "../src/judge/text.ts";
import type { Reason } from "../src/judge/listing.ts";
import type { Criteria, Posting } from "../src/schema.ts";

function criteria(overrides: Partial<Criteria> = {}): Criteria {
  return {
    id: 1,
    level_words: ["staff", "senior staff", "principal", "distinguished", "architect", "lead"],
    role_words: ["backend", "full stack", "platform"],
    excluded_title_words: [],
    team_name_words: [],
    excluded_states: ["Wyoming"],
    missing_languages: ["cobol", "fortran", "delphi", ".zorp"],
    comp_floor: 120000,
    max_age_days: null,
    excluded_locations: [],
    product_words: [],
    assumed_bonus_pct: null,
    updated_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

function posting(overrides: Partial<Posting> = {}): Posting {
  return {
    key: "acme::1",
    company: "Acme",
    platform: "greenhouse",
    board: "board",
    title: null,
    url: null,
    location: null,
    comp_low: null,
    comp_high: null,
    posted_at: null,
    first_seen: "2020-01-01T00:00:00.000Z",
    last_seen: "2020-01-01T00:00:00.000Z",
    live: null,
    body: null,
    kept: null,
    reasons: [],
    evidence: {},
    judged_with: null,
    status: null,
    applied_at: null,
    status_at: null,
    note: null,
    body_hash: null,
    workplace: null,
    ...overrides,
  };
}

function reasonFor(reasons: readonly Reason[], criterion: string): Reason {
  const found = reasons.find((reason) => reason.criterion === criterion);
  assert.ok(found, `no reason for criterion "${criterion}"`);
  return found;
}

test("remote: in when the body says the role is remote with no contradiction", () => {
  const { reasons } = judgeText(
    posting({ body: "This is a fully remote position open to candidates anywhere in the US." }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "in");
  // A null workplace falls through to the body's own sentence.
  assert.equal(
    remote.detail,
    'body affirms remote: "This is a fully remote position open to candidates anywhere in the US."',
  );
});

test("remote: the board's field decides over a body that would read the other way", () => {
  // The board's own workplace word decides before a sentence is read, in
  // both directions.
  const officeBody = "This role requires that you must be in the office 3 days a week.";
  const remoteOverOffice = reasonFor(
    judgeText(posting({ workplace: "remote", body: officeBody }), criteria()).reasons,
    "remote",
  );
  assert.equal(remoteOverOffice.verdict, "in");
  assert.equal(remoteOverOffice.detail, "board states remote");

  const remoteBody = "This is a fully remote role.";
  const onsiteOverRemote = reasonFor(
    judgeText(posting({ workplace: "onsite", body: remoteBody }), criteria()).reasons,
    "remote",
  );
  assert.equal(onsiteOverRemote.verdict, "out");
  assert.equal(onsiteOverRemote.detail, "board states onsite");

  const hybridOverRemote = reasonFor(
    judgeText(posting({ workplace: "hybrid", body: remoteBody }), criteria()).reasons,
    "remote",
  );
  assert.equal(hybridOverRemote.verdict, "out");
  assert.equal(hybridOverRemote.detail, "board states hybrid");
});

test("remote: a bullet is a clause, so a list is not judged as one", () => {
  // htmlToText turns a block tag into a newline, so this is how a bulleted
  // list reaches the criteria. Glued into one clause, every criterion saw
  // one bullet's word as the rule for the role, and "Fully remote" would
  // exempt the whole list. "on-site" because "hybrid" is not in
  // OFFICE_ATTENDANCE_PHRASES; the pin is the split, not the word.
  const body =
    "What you get\nFully remote within the US\nUnlimited PTO\n" +
    "Desks in Denver for on-site teammates who want one";
  const remote = reasonFor(judgeText(posting({ body }), criteria()).reasons, "remote");
  assert.equal(
    remote.detail,
    'body requires office attendance ("on-site"): ' +
      '"Desks in Denver for on-site teammates who want one"',
  );
});

test("remote: a body silent on remote is out", () => {
  const { reasons } = judgeText(
    posting({ body: "We are looking for a software engineer to join our growing team." }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: a location naming remote affirms a silent body", () => {
  const { reasons } = judgeText(
    posting({
      body: "We are looking for a software engineer to join our growing team.",
      location: "Remote - USA",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "in");
  assert.match(remote.detail, /location affirms remote/);
});

test("remote: an empty body is rescued by a location naming remote", () => {
  const { reasons } = judgeText(posting({ body: "", location: "Remote (USA)" }), criteria());
  assert.equal(reasonFor(reasons, "remote").verdict, "in");
});

test("remote: a location naming both an office and remote is kept", () => {
  const { reasons } = judgeText(
    posting({
      body: "",
      location: "San Francisco, CA, New York, NY, or Remote within Canada or United States",
    }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "remote").verdict, "in");
});

test("remote: a location naming Remote outranks an office phrase in the body", () => {
  // The same body with a city label is out, below.
  const body = "This role is three days per week in office.";
  const labelled = reasonFor(
    judgeText(posting({ body, location: "Remote (USA)" }), criteria()).reasons,
    "remote",
  );
  assert.equal(labelled.verdict, "in");
  assert.equal(labelled.detail, 'location affirms remote: "Remote (USA)"');

  const city = reasonFor(
    judgeText(posting({ body, location: "Denver, CO" }), criteria()).reasons,
    "remote",
  );
  assert.equal(city.verdict, "out");
  assert.equal(
    city.detail,
    'body requires office attendance ("in office"): "This role is three days per week in office."',
  );
});

test("remote: the board's hybrid field is not rescued by a remote location", () => {
  const { reasons } = judgeText(
    posting({
      workplace: "hybrid",
      body: "3 days at the office, 2 days remote each week.",
      location: "Remote",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.equal(remote.detail, "board states hybrid");
});

test("remote: a benefits sentence with a day count does not block a location rescue", () => {
  // isSplitWeekSchedule is DAY_COUNT && WORKPLACE_WORDS with no mention of
  // remote required; ungated, it blocked the location rescue.
  const { reasons } = judgeText(
    posting({
      body: "Benefits include 25 days of paid leave and a stocked office kitchen.",
      location: "Remote - USA",
    }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "remote").verdict, "in");
});

test("remote: a location naming a non-remote place is not an affirmation", () => {
  const { reasons } = judgeText(
    posting({
      body: "We are looking for a software engineer to join our growing team.",
      location: "Non-Remote, New York",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

// A bare-word match would read "remote" anywhere as an affirmation. None
// of the three sentences below says the role is remote, and each location
// says nothing either, so the row falls to "out".

test("remote: 'remote desktop sessions' in a product blurb is not an affirmation", () => {
  const { reasons } = judgeText(
    posting({
      body: "Our desktop client reaches millions of people each month as their gateway to cloud workstations, virtual machines, and remote desktop sessions.",
      location: "United States, Texas, Austin",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: 'partly remote' in a requirement sentence is not an affirmation", () => {
  const { reasons } = judgeText(
    posting({
      body: "Your background includes running partly remote teams spread over several time zones",
      location: "Austin, Denver",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: 'a Remote employee or one who works out of the office' is not an affirmation", () => {
  const { reasons } = judgeText(
    posting({
      body: "However you join us, as a Remote employee or one who works out of the Denver office, your first weeks here are about meeting the people around you.",
      location: "Denver, CO, USA",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: '#LI-Remote' alone affirms", () => {
  assert.equal(remoteVerdict("#LI-Remote").verdict, "in");
});

test("remote: 'remote-friendly' affirms", () => {
  assert.equal(remoteVerdict("This is a remote-friendly team.").verdict, "in");
});

test("remote: a benefits sentence that opens with 'Remote work' is not an affirmation", () => {
  // "insurance" is the PERK_SIGNALS term for this sentence.
  const remote = remoteVerdict(
    "Remote work, medical insurance, unlimited leave, a retirement match, and help with childcare are some of what we offer.",
  );
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: '- Remote (US)' affirms once the bullet is stripped", () => {
  const remote = remoteVerdict("- Remote (US)");
  assert.equal(remote.verdict, "in");
});

test("remote: 'work from home' affirms even in a bare benefits line", () => {
  // An unconditional affirmation is read before anything else, so a line
  // with no sentence shape to it still affirms.
  assert.equal(remoteVerdict("Work from home equipment allowance").verdict, "in");
});

test("remote: 'work from the Office' sits one word from the affirmation phrase and states nothing", () => {
  // "work from home" is an unconditional affirmation. This sentence is a
  // near miss on it, ending in "Office" instead of "home", and must read as
  // silence rather than being swept in as an affirmation.
  const remote = remoteVerdict("Whether you're a Remote employee or work from the Office");
  assert.equal(remote.verdict, "out");
  assert.equal(remote.detail, "body says nothing about remote");
});

test("remote: a perks bullet list closed by the recruiter's tag stays in", () => {
  const body =
    "- Pay that tracks the market, reviewed twice a year.\n" +
    "- Remote work from any US state.\n" +
    "- A small team that ships on Fridays and means it.\n" +
    "- Budget for the conference you actually want to attend.\n" +
    "- A path to leading work of your own inside a year.\n" +
    "#LI-REMOTE";
  assert.equal(remoteVerdict(body).verdict, "in");
});

// A stated office requirement overrules the affirmation and the location,
// unless the recruiter's remote tag is anywhere in the body or the
// location names Remote.

test("remote: the recruiter's tag anywhere in the body outranks an office phrase", () => {
  // A section header is itself an office phrase, and the tag sits many
  // lines below it. The same body without its tag is out on that header.
  const header =
    "In-Office Expectations :\n" +
    "Teams gather for a planning week once a quarter, so you can live anywhere " +
    "in the country and still do this job.";
  const tagged = remoteVerdict(`${header}\n#LI-REMOTE`);
  assert.equal(tagged.verdict, "in");
  assert.equal(tagged.detail, 'body affirms remote: "#LI-REMOTE"');

  const untagged = remoteVerdict(header);
  assert.equal(untagged.verdict, "out");
  assert.equal(
    untagged.detail,
    'body requires office attendance ("in-office"): "In-Office Expectations :"',
  );
});

test("remote: a perks clause with an office word does not refuse", () => {
  // On its own the sentence is silence; after an affirmation it is nothing.
  const perks =
    "In-office extras run to a stocked pantry, a monthly lunch stipend, and a " +
    "roof terrace nobody uses in August.";
  const alone = remoteVerdict(perks);
  assert.equal(alone.verdict, "out");
  assert.equal(alone.detail, "body says nothing about remote");
  assert.equal(remoteVerdict(`This is a fully remote role.\n${perks}`).verdict, "in");
});

test("remote: each of the five office phrases refuses an untagged, city-labelled body", () => {
  // Written out by hand so a change to OFFICE_ATTENDANCE_PHRASES in either
  // direction breaks this.
  const phrases = ["onsite", "on-site", "on site", "in office", "in-office"];
  for (const phrase of phrases) {
    const body = `Engineers work ${phrase} five days a week.`;
    const remote = reasonFor(
      judgeText(posting({ body, location: "New York, NY" }), criteria()).reasons,
      "remote",
    );
    assert.equal(remote.verdict, "out", phrase);
    assert.equal(remote.detail, `body requires office attendance ("${phrase}"): "${body}"`);
  }
  // And a sixth, not on the list: a day count beside "the office" states
  // attendance the same way the five phrases do.
  const dayCount = reasonFor(
    judgeText(
      posting({ body: "Engineers work in the office five days a week.", location: "New York, NY" }),
      criteria(),
    ).reasons,
    "remote",
  );
  assert.equal(dayCount.verdict, "out");
  assert.equal(
    dayCount.detail,
    'body requires office attendance ("in the office five days"): ' +
      '"Engineers work in the office five days a week."',
  );
  // Bare "in the office" with no day count nearby is still silence.
  const silent = reasonFor(
    judgeText(
      posting({
        body: "Engineers gather in the office for quarterly planning.",
        location: "New York, NY",
      }),
      criteria(),
    ).reasons,
    "remote",
  );
  assert.equal(silent.detail, "body says nothing about remote");
});

// A "where you will work" paragraph, in the four clauses the criterion has
// to tell apart: an office-based opening that states no attendance, a
// hybrid sentence carrying a perk word, the day count that is the
// requirement, and a perk sentence that affirms remote anyway. The perk
// sentence is shared with the test below that reads it on its own.
const REMOTE_WEEKS_PERK = "As a perk, everyone takes three fully remote weeks each summer!";

const HYBRID_PARAGRAPH =
  "Your home base is our Portland office. We run a hybrid week, pairing the pull of a " +
  "shared room with the benefits of working from home when you need the quiet. Engineers " +
  "are asked for two anchored days in the office each week, Tuesdays and Thursdays. " +
  REMOTE_WEEKS_PERK;

test("remote: a 'two anchored days' sentence refuses a city-labelled body", () => {
  const remote = reasonFor(
    judgeText(
      posting({ body: HYBRID_PARAGRAPH, location: "Portland, Oregon, United States" }),
      criteria(),
    ).reasons,
    "remote",
  );
  assert.equal(remote.verdict, "out");
  assert.equal(
    remote.detail,
    'body requires office attendance ("days in the office"): ' +
      '"Engineers are asked for two anchored days in the office each week, ' +
      'Tuesdays and Thursdays."',
  );
});

test("remote: the recruiter's tag rescues that paragraph over the office requirement", () => {
  const remote = reasonFor(
    judgeText(
      posting({
        body: `${HYBRID_PARAGRAPH}\n#LI-Remote`,
        location: "Portland, Oregon, United States",
      }),
      criteria(),
    ).reasons,
    "remote",
  );
  // The tag skips the office read; the affirmation read then returns the
  // first affirming sentence in body order, the perk sentence.
  assert.equal(remote.verdict, "in");
  assert.equal(remote.detail, `body affirms remote: "${REMOTE_WEEKS_PERK}"`);
});

test("remote: the board's remote field rescues that paragraph over the office requirement", () => {
  const remote = reasonFor(
    judgeText(
      posting({
        body: HYBRID_PARAGRAPH,
        location: "Portland, Oregon, United States",
        workplace: "remote",
      }),
      criteria(),
    ).reasons,
    "remote",
  );
  assert.equal(remote.verdict, "in");
  assert.equal(remote.detail, "board states remote");
});

test("remote: a day count separated from 'in the office' by a phrase still refuses", () => {
  const body =
    "Wardnet runs a hybrid model for nearly every role, and the people in them spend two " +
    "or more days a week in the office.";
  const remote = reasonFor(
    judgeText(posting({ body, location: "New York, NY Office" }), criteria()).reasons,
    "remote",
  );
  assert.equal(remote.verdict, "out");
  assert.equal(
    remote.detail,
    `body requires office attendance ("days a week in the office"): "${body}"`,
  );
});

test("remote: that paragraph's perk sentence alone still affirms", () => {
  // A perk sentence still affirms when nothing states a requirement; the
  // alternative was measured and rejected in the commit that added
  // OFFICE_DAYS_PATTERNS.
  const remote = remoteVerdict(REMOTE_WEEKS_PERK);
  assert.equal(remote.verdict, "in");
  assert.equal(remote.detail, `body affirms remote: "${REMOTE_WEEKS_PERK}"`);
});

test("excluded states: out when the body names an excluded state as ineligible", () => {
  const { reasons } = judgeText(
    posting({ body: "This position is not eligible for candidates residing in Wyoming." }),
    criteria(),
  );
  const excluded = reasonFor(reasons, "excluded_states");
  assert.equal(excluded.verdict, "out");
  assert.match(excluded.detail, /Wyoming/);
});

test("excluded states: in when the state is named but not as ineligible", () => {
  const { reasons } = judgeText(
    posting({ body: "Our headquarters is located in Wyoming; this role is fully remote." }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "excluded_states").verdict, "in");
});

test("excluded states: an empty excluded_states list matches nothing", () => {
  const { reasons } = judgeText(
    posting({ body: "This position is not eligible for candidates residing in Wyoming." }),
    criteria({ excluded_states: [] }),
  );
  assert.equal(reasonFor(reasons, "excluded_states").verdict, "in");
});

test("country restriction: out on 'open to candidates residing in the EU'", () => {
  const { reasons } = judgeText(
    posting({ body: "This role is open to candidates residing in the EU." }),
    criteria(),
  );
  const country = reasonFor(reasons, "country_restriction");
  assert.equal(country.verdict, "out");
  assert.match(country.detail, /EU/);
});

test("country restriction: out on 'based in the Philippines'", () => {
  const { reasons } = judgeText(
    posting({ body: "The team you would join is based in the Philippines." }),
    criteria(),
  );
  const country = reasonFor(reasons, "country_restriction");
  assert.equal(country.verdict, "out");
  assert.match(country.detail, /Philippines/);
});

test("country restriction: out on 'European Residence required'", () => {
  const { reasons } = judgeText(posting({ body: "European Residence required." }), criteria());
  const country = reasonFor(reasons, "country_restriction");
  assert.equal(country.verdict, "out");
  assert.match(country.detail, /European/);
});

test("country restriction: a country named without a residency signal is not a restriction", () => {
  const { reasons } = judgeText(
    posting({
      body: "We have offices in Ireland, Germany and Japan, and customers in 40 countries.",
    }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country_restriction").verdict, "in");
});

test("country restriction: a sentence naming the US as well as another country stays in", () => {
  const { reasons } = judgeText(
    posting({ body: "You must be based in the United States or Canada to apply." }),
    criteria(),
  );
  assert.equal(reasonFor(reasons, "country_restriction").verdict, "in");
});

test("country restriction: a body naming no country at all is in", () => {
  const { reasons } = judgeText(
    posting({ body: "You must be based in the Bay Area or Denver." }),
    criteria(),
  );
  const country = reasonFor(reasons, "country_restriction");
  assert.equal(country.verdict, "in");
  assert.equal(
    country.detail,
    "body restricts the role to no country other than the United States",
  );
});

// Bare "based in" cannot refuse this arrest-record notice here: the
// sentence names two California cities and no country.
test("country restriction: the arrest-record notice naming US cities is not a country restriction", () => {
  const body =
    "For roles based in San Francisco or Los Angeles, Northwind will consider applicants " +
    "with arrest or conviction records wherever the law says it must.";
  assert.equal(
    reasonFor(judgeText(posting({ body }), criteria()).reasons, "country_restriction").verdict,
    "in",
  );
});

test("missing languages: 'Delphi is a nice to have' welcomes the language", () => {
  const { reasons } = judgeText(posting({ body: "Delphi is a nice to have." }), criteria());
  assert.equal(reasonFor(reasons, "missing_languages").verdict, "in");
});

test("missing languages: '5+ years of Delphi' requires the language", () => {
  const { reasons } = judgeText(posting({ body: "5+ years of Delphi required." }), criteria());
  const missing = reasonFor(reasons, "missing_languages");
  assert.equal(missing.verdict, "out");
  assert.match(missing.detail, /Delphi/);
});

// "go"/"golang" match case-sensitively. `src/judge/text.ts` hardcodes those
// two names in `CASE_SENSITIVE_TERMS` and `ENGLISH_WORD_TERMS`, so the tests
// below are the only ones that name a real language, and they supply it
// themselves rather than the shared criteria helper carrying it.
const GO_MISSING: Partial<Criteria> = { missing_languages: ["go", "golang"] };

test("missing languages: an ordinary use of the word 'go' does not read as the language", () => {
  const { reasons } = judgeText(
    posting({ body: "We move fast and things go wrong sometimes." }),
    criteria(GO_MISSING),
  );
  assert.equal(reasonFor(reasons, "missing_languages").verdict, "in");
});

test("missing languages: '5+ years of Go' requires the language", () => {
  const { reasons } = judgeText(
    posting({ body: "5+ years of Go experience required." }),
    criteria(GO_MISSING),
  );
  const missing = reasonFor(reasons, "missing_languages");
  assert.equal(missing.verdict, "out");
  assert.match(missing.detail, /Go/);
});

// Each class is tested in both directions. The sentences are written for
// these tests and follow the shapes real adverts use.

function missingLanguagesVerdict(body: string, overrides: Partial<Criteria> = {}): string {
  return reasonFor(judgeText(posting({ body }), criteria(overrides)).reasons, "missing_languages")
    .verdict;
}

test("missing languages: 'languages like Python or Ruby' offers a language he has", () => {
  assert.equal(
    missingLanguagesVerdict("Experience with one or more languages like Python or Ruby."),
    "in",
  );
});

test("missing languages: 'such as COBOL, Delphi, or Python' offers a language he has", () => {
  assert.equal(
    missingLanguagesVerdict("Proficiency in a language such as COBOL, Delphi, or Python."),
    "in",
  );
});

test("missing languages: 'one or more languages like Delphi, COBOL, Ruby, Python, etc.' is in", () => {
  assert.equal(
    missingLanguagesVerdict(
      "You are fluent in one or more languages like Delphi, COBOL, Ruby, Python, etc.",
    ),
    "in",
  );
});

test("missing languages: 'Python/C/Fortran/Delphi or similar translate well' is in", () => {
  assert.equal(
    missingLanguagesVerdict("We use COBOL, but Python/C/Fortran/Delphi or similar translate well."),
    "in",
  );
});

test("missing languages: an alternatives list offering only languages he lacks still requires one", () => {
  assert.equal(
    missingLanguagesVerdict("Experience with a compiled language such as COBOL, Delphi, or .Zorp."),
    "out",
  );
});

// `\bC\b` matched the C of "C++" and read a C++ requirement as a list
// offering C. Only a name ending in "+" reproduces this, so the test names
// the language itself rather than the shared criteria helper carrying it.
const CPLUSPLUS_MISSING: Partial<Criteria> = { missing_languages: ["c++"] };
const CSHARP_MISSING: Partial<Criteria> = { missing_languages: ["c#"] };

test("missing languages: the C of 'C++14/17 or later' is not a language he has", () => {
  assert.equal(
    missingLanguagesVerdict("Deep experience with C++14/17 or later.", CPLUSPLUS_MISSING),
    "out",
  );
});

// A `missing_languages` term that starts or ends in punctuation was made
// near-unmatchable by `\b…\b`: ".zorp" (a made-up name standing in for a
// punctuation-edged language) fired only inside a longer dotted name, "c#"
// never, "c++" only when a word character followed it.

test("missing languages: 'experience with .Zorp' requires the language", () => {
  const reason = reasonFor(
    judgeText(posting({ body: "Five years of experience with .Zorp." }), criteria()).reasons,
    "missing_languages",
  );
  assert.equal(reason.verdict, "out");
  assert.equal(reason.detail, 'body requires ".zorp": "Five years of experience with .Zorp."');
});

// The judgement call: a role built on ASP.Zorp is a role built on .Zorp.
test("missing languages: 'ASP.Zorp Core' requires .Zorp", () => {
  assert.equal(missingLanguagesVerdict("Deep experience building ASP.Zorp Core services."), "out");
});

// A web address is not a language: "www.zorpco.zorp" in a closing "visit
// us at" line read as a .Zorp requirement.
test("missing languages: a web address ending in the language's name is not a mention", () => {
  assert.equal(
    missingLanguagesVerdict(
      "To learn more, visit www.zorpco.zorp and https://docs.example.zorp/start.",
    ),
    "in",
  );
});

test("missing languages: a mention beside a web address still requires the language", () => {
  assert.equal(
    missingLanguagesVerdict("Five years of .Zorp required; apply at www.example.com."),
    "out",
  );
});

test("missing languages: ZorpSuite is not .Zorp", () => {
  assert.equal(missingLanguagesVerdict("Experience administering ZorpSuite for finance."), "in");
});

test("missing languages: '5+ years of C#' requires the language", () => {
  const reason = reasonFor(
    judgeText(posting({ body: "5+ years of C# in production." }), criteria(CSHARP_MISSING)).reasons,
    "missing_languages",
  );
  assert.equal(reason.verdict, "out");
  assert.equal(reason.detail, 'body requires "c#": "5+ years of C# in production."');
});

test("missing languages: 'a C#/.Zorp shop' requires the language", () => {
  assert.equal(
    missingLanguagesVerdict("We are a C#/.Zorp shop and you will own the API.", CSHARP_MISSING),
    "out",
  );
});

test("missing languages: 'C# is a plus' is still welcomed, not required", () => {
  assert.equal(missingLanguagesVerdict("Experience with C# is a plus.", CSHARP_MISSING), "in");
});

test("missing languages: C++ at the end of a clause requires the language", () => {
  const reason = reasonFor(
    judgeText(posting({ body: "Five years of production C++." }), criteria(CPLUSPLUS_MISSING))
      .reasons,
    "missing_languages",
  );
  assert.equal(reason.verdict, "out");
  assert.equal(reason.detail, 'body requires "c++": "Five years of production C++."');
});

test("missing languages: 'Learn Fast, Align, Adapt & Go!' is not the language", () => {
  assert.equal(missingLanguagesVerdict("Learn Fast, Align, Adapt & Go!", GO_MISSING), "in");
});

test("missing languages: 'Go wherever the highest-leverage work is' is not the language", () => {
  assert.equal(
    missingLanguagesVerdict("Go wherever the highest-leverage work is.", GO_MISSING),
    "in",
  );
});

test("missing languages: 'Deep proficiency in Go' is the language", () => {
  assert.equal(missingLanguagesVerdict("Deep proficiency in Go.", GO_MISSING), "out");
});

// A block tag is a clause boundary, so the heading has to carry its
// exemption forward to the list it governs.
test("missing languages: languages under a 'Technologies We Use' heading are a stack listing", () => {
  assert.equal(
    missingLanguagesVerdict("Technologies We Use and Teach\nDelphi, Elixir, Ruby, COBOL"),
    "in",
  );
});

test("missing languages: 'Mobile: iOS (Swift), Android (Dart)' under a stack heading is in", () => {
  assert.equal(
    missingLanguagesVerdict("Our tech stack(s)\nMobile: iOS (Swift), Android (Dart)"),
    "in",
  );
});

test("missing languages: a stack listing ends at the clause that asks for something", () => {
  const body =
    "Our tech stack(s)\nMobile: iOS (Swift), Android (Dart)\n5+ years of production Delphi.";
  const reason = reasonFor(judgeText(posting({ body }), criteria()).reasons, "missing_languages");
  assert.equal(reason.verdict, "out");
  assert.equal(reason.detail, 'body requires "delphi": "5+ years of production Delphi."');
});

test("missing languages: 'Strong production experience with Golang' requires the language", () => {
  assert.equal(
    missingLanguagesVerdict("Strong production experience with Golang.", GO_MISSING),
    "out",
  );
});

// A percent sign directly before the name is still a mention of it.
test("missing languages: 'our search tier is 99.8% Delphi!' requires the language", () => {
  assert.equal(missingLanguagesVerdict("Our search tier is 99.8% Delphi!"), "out");
});

test("missing languages: a closed cue plus an accepted language welcomes it", () => {
  assert.equal(
    missingLanguagesVerdict(
      "Strong ability in at least one language (Delphi, Python, Cobol, etc.)",
    ),
    "in",
  );
});

test("missing languages: 'or another object-oriented language' is an open alternative", () => {
  assert.equal(
    missingLanguagesVerdict("Delphi, Cobol, or another object-oriented language."),
    "in",
  );
});

test("missing languages: 'or a similar language' is an open alternative", () => {
  assert.equal(missingLanguagesVerdict("Delphi or a similar language."), "in");
});

test("missing languages: 'helpful' welcomes the language", () => {
  assert.equal(
    missingLanguagesVerdict("Delphi experience is helpful, but fundamentals matter more."),
    "in",
  );
});

test("missing languages: 'willingness to' welcomes the language", () => {
  assert.equal(
    missingLanguagesVerdict("Proficient in Delphi, or willingness to ramp up quickly in it."),
    "in",
  );
});

test("missing languages: a stack sentence with no heading is skipped", () => {
  assert.equal(missingLanguagesVerdict("We also use Delphi and Cobol for native modules."), "in");
});

test("missing languages: a curly apostrophe still folds to a welcome signal", () => {
  assert.equal(missingLanguagesVerdict("You don’t need Delphi experience to start."), "in");
});

test("missing languages: 'or any other JVM language' is a family, not an open door", () => {
  assert.equal(missingLanguagesVerdict("Cobol, Delphi, or any other JVM language."), "out");
});

// "type-safe" is a hyphenated compound; `findWholeWord` bounds it on its
// letters at each edge, with no special-casing needed.
test("missing languages: 'or another type-safe language' is a family, not an open door", () => {
  assert.equal(missingLanguagesVerdict("Delphi or another type-safe language."), "out");
});

// "low-level" is a hyphenated compound too, same boundary behaviour.
test("missing languages: 'or other low-level languages' is a family, not an open door", () => {
  assert.equal(missingLanguagesVerdict("Delphi or other low-level languages."), "out");
});

test("missing languages: 'either' is not an alternatives cue", () => {
  assert.equal(missingLanguagesVerdict("Experience with either Delphi or Cobol."), "out");
});

test("missing languages: a stack sentence that also states a requirement is not skipped", () => {
  assert.equal(
    missingLanguagesVerdict("We currently use Delphi, and you must have 5+ years of it."),
    "out",
  );
});

test("missing languages: 'Go-To-Market' is not the language", () => {
  assert.equal(
    missingLanguagesVerdict("Our Go-To-Market team partners with engineering.", GO_MISSING),
    "in",
  );
});

test("missing languages: 'Go-based' still requires the language", () => {
  assert.equal(
    missingLanguagesVerdict("Build Go-based services; 5+ years of Go required.", GO_MISSING),
    "out",
  );
});

// The listing criterion only opens the door for a below-floor base on an
// assumed rate; this criterion settles it from the text, and a stated rate
// always wins over the assumed one.

function bonusVerdict(
  compHigh: number | null,
  body: string,
  criteriaOverrides: Partial<Criteria> = {},
): Reason {
  return reasonFor(
    judgeText(posting({ comp_high: compHigh, body }), criteria(criteriaOverrides)).reasons,
    "bonus",
  );
}

test("bonus: in with no comp band, without reading the body", () => {
  const reason = bonusVerdict(null, "The text names no bonus at all.");
  assert.equal(reason.verdict, "in");
  assert.equal(reason.detail, "the floor is settled without a bonus");
});

test("bonus: in when comp_high is already at or above the floor, without reading the body", () => {
  // A body that would read "out" if it were ever consulted.
  const reason = bonusVerdict(120000, "A referral bonus is available for successful hires.");
  assert.equal(reason.verdict, "in");
  assert.equal(reason.detail, "the floor is settled without a bonus");
});

// "corporate" qualifies "bonus" but states no percentage, so the assumed
// rate settles it.
test("bonus: an unqualified rate falls back to the assumed percentage", () => {
  const reason = bonusVerdict(
    115000,
    "Employees participate in a corporate bonus plan based on company performance.",
    { comp_floor: 120000, assumed_bonus_pct: 12 },
  );
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    'comp_high 115000 plus the assumed 12% bonus reaches 128800, at or above the floor 120000: "Employees participate in a corporate bonus plan based on company performance."',
  );
});

test("bonus: a pay-bonus mention with no assumed rate on file reads out", () => {
  const reason = bonusVerdict(
    115000,
    "Employees participate in a corporate bonus plan based on company performance.",
    { comp_floor: 120000, assumed_bonus_pct: null },
  );
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 115000 is below the floor 120000 and the text names no bonus",
  );
});

// A stated rate, so the assumed one (left unset) is never consulted.
test("bonus: a stated 'pays N% of base' rate reaches the floor", () => {
  const reason = bonusVerdict(
    105000,
    "Umbra runs a discretionary cash bonus that pays 15% of base salary each year.",
  );
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    'comp_high 105000 plus the stated 15% bonus reaches 120750, at or above the floor 120000: "Umbra runs a discretionary cash bonus that pays 15% of base salary each year."',
  );
});

// The 50% weighting sits after "performance", the reverse of every
// BONUS_TARGET_PATTERNS order, so it never becomes a candidate.
test("bonus: the stated target wins over a performance weighting percentage beside it", () => {
  const reason = bonusVerdict(
    100000,
    "Compensation includes an annual target bonus of 10%. " +
      "Bonus payout is weighted by individual performance (50%) and company results (50%).",
  );
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    'comp_high 100000 plus the stated 10% bonus reaches only 110000, below the floor 120000: "Compensation includes an annual target bonus of 10%."',
  );
});

// A referral bonus is not pay for the work (NON_PAY_BONUS_QUALIFIERS).
test("bonus: a referral bonus alone names no pay bonus", () => {
  const reason = bonusVerdict(110000, "A referral bonus is available for successful hires.", {
    assumed_bonus_pct: 12,
  });
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 110000 is below the floor 120000 and the text names no bonus",
  );
});

// The stated 8% reaches only $240,300; the assumed rate is 20%, well clear
// of the floor, so this reads "out" only if the stated rate is the one
// consulted.
test("bonus: a stated rate below the floor is not overridden by a higher assumed one", () => {
  const reason = bonusVerdict(222500, "Total compensation includes an 8% bonus and equity.", {
    comp_floor: 260000,
    assumed_bonus_pct: 20,
  });
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    'comp_high 222500 plus the stated 8% bonus reaches only 240300, below the floor 260000: "Total compensation includes an 8% bonus and equity."',
  );
});

// The shapes under-floor bodies write a bonus in: the bare word admits a
// nice-to-have heading and, singular only, refuses every body that says
// "bonuses". Floor $120,000, 12% assumed rate.

// "Bonus Points" is a heading over nice-to-have skills: no pay qualifier,
// follower or pay word. 12% would have reached $123,200 and admitted the row.
test("bonus: a nice-to-have heading alone names no pay bonus", () => {
  const reason = bonusVerdict(110000, "Bonus Points\nExperience with game development.", {
    comp_floor: 120000,
    assumed_bonus_pct: 12,
  });
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 110000 is below the floor 120000 and the text names no bonus",
  );
});

// "AWS a bonus" is a nice-to-have inside a requirement bullet.
test("bonus: 'AWS a bonus' in a requirement bullet names no pay bonus", () => {
  const reason = bonusVerdict(
    110000,
    "- Experience with designing distributed systems at scale, AWS a bonus.",
    { comp_floor: 120000, assumed_bonus_pct: 12 },
  );
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 110000 is below the floor 120000 and the text names no bonus",
  );
});

// "Bonus Skills" comes first and the pay sentence later; the reason has to
// quote the pay sentence.
test("bonus: the reason quotes the first pay sentence, not an earlier heading", () => {
  const paySentence =
    "The range shown on this posting covers the least and the most we pay a new hire at this level, and depending on the role it can include target bonuses or sales incentives.";
  const reason = bonusVerdict(115000, `Bonus Skills\nStrong SQL.\n${paySentence}`, {
    comp_floor: 120000,
    assumed_bonus_pct: 12,
  });
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    `comp_high 115000 plus the assumed 12% bonus reaches 128800, at or above the floor 120000: "${paySentence}"`,
  );
});

// The plural "bonuses" with "discretionary" before it.
test("bonus: 'potential discretionary bonuses' is a pay bonus in the plural", () => {
  const sentence =
    "Alongside base pay you may be granted company stock, cash awards that vest over several years, potential discretionary bonuses, and a staff share plan priced at a discount.";
  const reason = bonusVerdict(115000, sentence, { comp_floor: 120000, assumed_bonus_pct: 12 });
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    `comp_high 115000 plus the assumed 12% bonus reaches 128800, at or above the floor 120000: "${sentence}"`,
  );
});

// The hyphenated qualifier "performance-based" is captured whole by
// BONUS_MENTION.
test("bonus: 'performance-based bonuses' is a pay bonus", () => {
  const sentence =
    "The role may also earn performance-based bonuses, decided by the company alone and set out in a written plan.";
  const reason = bonusVerdict(115000, sentence, { comp_floor: 120000, assumed_bonus_pct: 12 });
  assert.equal(reason.verdict, "in");
  assert.equal(
    reason.detail,
    `comp_high 115000 plus the assumed 12% bonus reaches 128800, at or above the floor 120000: "${sentence}"`,
  );
});

// The sentence names salary, so on the pay words alone it would read in;
// a negated mention ("does not include") names no pay bonus.
test("bonus: a negated mention ('does not include any bonuses') names no pay bonus", () => {
  const reason = bonusVerdict(
    110000,
    "The base salary range does not include any bonuses, equity, or benefits.",
    { comp_floor: 120000, assumed_bonus_pct: 12 },
  );
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 110000 is below the floor 120000 and the text names no bonus",
  );
});

// Made up, since no row in the corpus writes "no bonus" outright: the
// negation is the word right before the mention.
test("bonus: 'no bonus' names no pay bonus", () => {
  const reason = bonusVerdict(
    110000,
    "There is no bonus; the base salary is the whole cash offer.",
    {
      comp_floor: 120000,
      assumed_bonus_pct: 12,
    },
  );
  assert.equal(reason.verdict, "out");
  assert.equal(
    reason.detail,
    "comp_high 110000 is below the floor 120000 and the text names no bonus",
  );
});

test("judgeText: kept true when all five text criteria pass", () => {
  const result = judgeText(
    posting({
      body: "This is a fully remote position open to candidates anywhere in the US. Delphi experience is a nice to have.",
    }),
    criteria(),
  );
  assert.equal(result.kept, true);
});

test("judgeText: kept false when any text criterion fails", () => {
  const result = judgeText(
    posting({ body: "This is a hybrid role requiring 3 days per week in our office." }),
    criteria(),
  );
  assert.equal(result.kept, false);
});

function remoteVerdict(body: string): Reason {
  return reasonFor(judgeText(posting({ body }), criteria()).reasons, "remote");
}

test("remote: a clause that says the role is remote cannot be the clause that refuses it", () => {
  // Board-remote rows whose one sentence carries "on-site" or "in-office"
  // beside the affirmation and no perk word: only officeRequirement's
  // affirmation exemption keeps them in.
  assert.equal(
    remoteVerdict(
      "This job is 100% remote unless you live within an hour of our Denver hub, in which case it is fully on-site.",
    ).verdict,
    "in",
  );
  assert.equal(
    remoteVerdict(
      "The role is open to fully remote candidates and equally to anyone who can be in-office three days a week in Austin or Denver.",
    ).verdict,
    "in",
  );
});

test("remote: the word beside an office phrase is not the role's affirmation", () => {
  // Bare "remote" beside an office phrase is not one of
  // ROLE_REMOTE_AFFIRMATIONS' phrasings, so the exemption does not fire.
  assert.equal(
    remoteVerdict(
      "We sort every job into one of three working patterns (remote, flexible, or fixed in office), and the pattern follows the nature of the work itself.",
    ).verdict,
    "out",
  );
  assert.equal(remoteVerdict("Denver, CO: 3 days in-office, 2 days remote.").verdict, "out");
  assert.equal(remoteVerdict("Hybrid - 3 days onsite / 2 remote.").verdict, "out");
  assert.equal(remoteVerdict("On-site Mon-Thu, Remote on Fridays.").verdict, "out");
});

test("remote: the board's field overrules a split-week body's own affirmation", () => {
  // This body would flip to "in" on the text path alone, but the board's
  // workplace field decides first and the body is never read.
  const { reasons } = judgeText(
    posting({
      workplace: "hybrid",
      body: "You're looking for a remote-first role - this one is 4 days/week in our NYC office.",
    }),
    criteria(),
  );
  const remote = reasonFor(reasons, "remote");
  assert.equal(remote.verdict, "out");
  assert.equal(remote.detail, "board states hybrid");
});

test("remote: a perks clause is not an office requirement", () => {
  // The office word in each is what the company gives, not what it asks.
  const perks = [
    "In-office benefits include lunch stipends and catered meals.",
    "We offer unlimited PTO, sabbaticals, and non-office days for hybrid employees.",
    "Quarterly team onsites and in-office happy hours keep us connected.",
    "Commuter benefits cover the days you commute to one of our offices.",
  ];
  for (const perk of perks) {
    assert.equal(
      remoteVerdict(`This is a fully remote role.\n${perk}`).verdict,
      "in",
      `perks clause refused the posting: ${perk}`,
    );
  }
});

test("remote: 'remotely' affirms remote where 'remote' would", () => {
  const remote = remoteVerdict("You will work remotely from anywhere in the United States.");
  assert.equal(remote.verdict, "in");
  assert.match(remote.detail, /remotely/);
});

test("remote: an empty body is named as empty, not as silence", () => {
  const remote = remoteVerdict("");
  assert.equal(remote.verdict, "out");
  assert.equal(remote.detail, "body is empty, so nothing was read");
});

test("remote: 'remote work options' is not an affirmation of the role", () => {
  // "remote work options" predicates nothing of the role: silence, not a
  // refusal.
  const remote = remoteVerdict(
    "Relocation help, visa sponsorship and remote work options are not on offer for this opening.",
  );
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /says nothing/);
});

test("remote: 'remote-first, but not remote-only' affirms", () => {
  // "remote-first" is one of ROLE_REMOTE_AFFIRMATIONS' phrasings, and
  // nothing in the sentence is an office phrase.
  const remote = remoteVerdict("Globex is a remote-first, but not remote-only company.");
  assert.equal(remote.verdict, "in");
  assert.match(remote.detail, /body affirms remote/);
});

test("remote: 'an option to work fully remotely' affirms", () => {
  // The fully/entirely pattern's `remote\b` would stop before "ly", and
  // the "work remotely" pattern needs the adverb adjacent.
  const remote = remoteVerdict(
    "Hours here are yours to arrange, and you have the option to work fully remotely from any state.",
  );
  assert.equal(remote.verdict, "in");
  assert.match(remote.detail, /body affirms remote/);
  assert.match(remote.detail, /work fully remotely/);
});

test("remote: 'or remotely in the United States' affirms", () => {
  const remote = remoteVerdict(
    "This role can be held from one of our US hubs or remotely in the United States.",
  );
  assert.equal(remote.verdict, "in");
});

test("remote: 'Remote - Eligible' with a space and dash affirms", () => {
  const remote = remoteVerdict("Staff Engineer, Platform (Remote - Eligible)");
  assert.equal(remote.verdict, "in");
});

test("remote: 'partial or full remote work' affirms", () => {
  const remote = remoteVerdict("You'll have the flexibility for partial or full remote work.");
  assert.equal(remote.verdict, "in");
});

test("remote: a 'Posting Type' line of 'Hybrid/Remote' affirms", () => {
  const remote = remoteVerdict("Posting Type\nHybrid/Remote");
  assert.equal(remote.verdict, "in");
});

test("remote: a conditional or off-topic office sentence is not a requirement", () => {
  const notOffice = [
    "If this position is listed as onsite, work happens at an office.",
    "Roles that are based in an office are onsite Tuesday through Thursday.",
    "For remote roles, you may be asked to attend an on-site interview.",
    "We don’t prescribe specific in-office days.",
    "Travel occasionally to support onsite implementations.",
    "Work styles (flexible, remote, or required in office) are categories we assign to employees.",
  ];
  for (const body of notOffice) {
    const remote = remoteVerdict(body);
    assert.doesNotMatch(remote.detail, /^body requires office attendance/, body);
  }
});

test("remote: a real office requirement still stays out", () => {
  const stillOut = [
    "This role requires working in-office three days a week.",
    "You must be onsite in our Denver office five days a week, with up to 20% travel.",
    "This is not a remote or hybrid role; you will work on-site.",
    "Must be based within commuting distance and able to work on-site two days per week.",
  ];
  for (const body of stillOut) {
    const remote = remoteVerdict(body);
    assert.equal(remote.verdict, "out", body);
    assert.match(remote.detail, /^body requires office attendance/, body);
  }
});

test("remote: an off-topic phrase beside a requirement does not cancel it", () => {
  // Breaks if an off-topic phrase ("on-site interviews") nulls the whole
  // sentence instead of only its own span.
  const remote = remoteVerdict(
    "This role is based in Denver and requires in-person work five days a week, plus availability for on-site interviews.",
  );
  assert.equal(remote.verdict, "out");
  assert.match(remote.detail, /^body requires office attendance/);
});

test("remote: an if or unless clause covers only itself, not the sentence's requirement", () => {
  // Breaks if any "if" or "unless" anywhere in the sentence nulls it, rather
  // than only an office phrase inside the conditional clause.
  const stillOut = [
    "This role requires in-office attendance five days a week, even if you live nearby.",
    "Unless otherwise noted, you must work on-site in our Austin office three days a week.",
    "Expect three days a week in-office, with an option to come in more often if desired.",
    "If you're interviewing for this role, your recruiter will explain the in-office expectations.",
  ];
  for (const body of stillOut) {
    const remote = remoteVerdict(body);
    assert.equal(remote.verdict, "out", body);
    assert.match(remote.detail, /^body requires office attendance/, body);
  }
});
