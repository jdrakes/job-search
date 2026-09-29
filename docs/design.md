# job-search design

This is the design record of the author's own instance, carried into the
public repository as it was written. That is why it speaks about one operator
by name and in the third person. Read "James" as "the operator" and it holds
for any instance; where the shipped code and this page have parted company,
this page has been corrected and the commit says so.

A funnel: discovery finds the companies worth reading, ingestion reads
their boards, a deterministic processor filters and transforms, and a
short list James acts on. No model anywhere in the run; peer expansion, a
skill run by hand beside it, adds candidates the way James does in the
list. Recall is discovery's job, measured by what James finds elsewhere
that the tool missed; narrowing postings is the processor's alone. A
change of design edits this page first; the work to build it is tracked
elsewhere.

## Discovery

- Discovery's measure is recall: a relevant posting James finds on
  Indeed, LinkedIn, Greenhouse, Talent Hop or Clera should rarely be one
  the tool never showed him: fewer than one a month. Each miss has one
  cause: the company unknown,
  the company known with no board, the board read without the posting, the
  posting judged out, or the role never posted publicly. The first two are
  discovery's to fix; the others are fixed where they arise. Breadth for
  its own sake is not the aim: a board that never lists anything the
  criteria admit costs a read and shows James nothing.
- A candidate is a claim that a name may be worth reading. A company is an
  employer the tool reads. Every name enters as a candidate, whatever
  suggested it, and discovery alone turns candidates into companies. The
  two are kept apart because they answer different questions: candidates,
  where names came from, why, and what became of each; companies, what is
  read.
- Candidates come from three inputs, each recorded as the candidate's
  origin:
  - James, in the list: a company name, a posting's URL, or both. A URL
    carries its board, so a company on a system no name reaches (Workday,
    Eightfold, iCIMS) is added by pasting one of its postings. A candidate
    James adds for a posting he found elsewhere is also the record of a
    miss.
  - Peer expansion, a skill in the tool's repository, run by hand. Its
    seeds are the companies with a posting James applied to, whatever
    came of it. For each seed whose peers it has not searched, it
    researches the seed's peers for evidence (a current engineering
    posting, a link) and the board each one uses, leaving level, remote
    and pay to the run, adds each as a candidate carrying its evidence,
    which names the seed, and records on the seed when its peers were
    searched, whether or not any were found. A peer whose board it cannot
    find is not ruled out: it is offered without a board, its evidence
    saying the board was not found and that nothing else about it was
    checked. Before it is offered, its careers page is read as raw HTML
    for a link to a board the readers can read, and one that names the
    company (or, on a platform that states no name, any one) becomes its
    board; the name probe misses a board whose id is not the name
    (`bidgely-inc`), and this finds it. With none, the run resolves it by
    name. It reads and writes the
    store as the list does, nothing else.
  - The sources the operator's settings name: public job sites read each
    run for the company names they list. Common Crawl's index names boards
    rather than companies, so its candidates carry a board's URL. A source
    stays while the companies its candidates became produce, measured
    from the store by origin, and is removed when they do not.
- Each candidate is resolved once, in the run, to one outcome:
  - Its name matches a company James dropped: dropped, and nothing more.
  - It carries a URL: the board the URL names is read once. Answering, it
    becomes a company, or joins the company already named so, as another
    board.
  - It carries no URL: its name is probed on every system whose board id
    is a slug, and the first board that answers and names the company is
    taken the same way. A board that answers but names another company,
    or none, is not taken (wrong company): a slug guessed from a name
    belongs to someone else often enough that answering is not evidence.
    Nothing answering, no board.
  - The board it reaches is one a company already has: an alias, pointing
    at that company, so one req is one row whatever names point at it.
  - A name already resolved is not probed again, from any input.
  - A board that is gone or does not answer resolves nothing; a
    candidate whose board did not answer is tried again the next run.
    The outcome and the company it names are written on the candidate; the
    candidate itself is never changed or removed, so it stays the record of
    what was suggested, by whom, and why.
- A board ingestion finds gone (its system's own gone answer, not an
  error) comes back to discovery in the same run and is removed from its
  company at once, and the company's name is added as a candidate again,
  resolved the next morning like any other: a company that moved is found
  on its new board, and a gone answer given by mistake heals itself when
  the probe finds the same board.
- Discovery never judges a posting; precision is the processor's, and how
  often a board is read is ingestion's. Nothing waits on James's approval:
  a new company shows in the list with its origin and evidence, and
  dropping it there is the reversal. A dropped company is not read, a
  candidate naming it is not taken, and its postings still waiting on him
  leave the queue at the next run (the Unwatched criterion).
- A platform is added, as an ATS reader or a source, only on technical
  grounds, never on whether its companies look like a match: that
  narrowing is the processor's job, not discovery's. Required, all four:
  public and reachable without login, a key or a paid plan; returns at
  least a title, and ideally location, workplace and comp, per posting; a
  way to reach a company's board, either a predictable per-company slug
  for the probe or a board a URL names; and a stable structure, a plain
  HTTP/JSON API, not a page that only renders through JavaScript, so it
  does not need a new dependency to read and does not break on every
  redesign.

## Ingestion

- Every company's boards are read from their own applicant tracking
  systems (Greenhouse, Ashby, Lever, Workday, Eightfold, SmartRecruiters,
  Amazon, Workable, Rippling). A board bound in the last week, or with a
  stored posting its title and place admit (level, role, excluded words,
  country), is read every weekday; any other is read once a week, on
  Monday. Both follow from the candidates and the stored postings under
  the current criteria, so a criteria edit moves boards at once and
  nothing records which is which. A week loses little: a posting stays
  listed longer than that, a board that starts producing is read daily
  from then on, and fewer reads put the whole list in front of James
  sooner each morning. Ingestion writes postings only; a board that
  answers gone is handed back to discovery in the same run. A posting is
  recorded when its title and place pass (level, role, excluded words,
  country), or James has acted on it, or it is kept, with where it came
  from,
  when it was first seen and, once a board read that succeeded no longer
  lists it, when it went; listed again, it has not gone. A row is written
  only when something about it changed: new, changed, gone or back. A
  posting listed again unchanged is not written. A posting that fails
  those checks is not kept: the next read of their board lists them again, so a criteria edit that
  admits one takes effect at that read, and a stored posting a criteria
  edit rejects is removed when its board is next read, unless James acted
  on it or it is kept.
- Where the tracking system states a posting's workplace, that is recorded
  with the posting as the board's own word — remote, hybrid or on-site —
  wherever the system states it: on the listing (Ashby, Lever,
  SmartRecruiters), on the posting's detail (Workday, where the tenant
  fills it), or on a second per-posting read the system offers (Microsoft's
  position details). A system that states none, or a posting the system
  leaves blank, records none.
- A board whose listing leaves out what the posting's own page states can
  be given a detail read, named in the operator's settings, not shipped with
  the tool. That board is then read in two phases, as Workday's is: the
  listing without its text, then the page once per posting the listing
  criteria admit, for its workplace, pay and text. Stripe's is the one
  today: its Greenhouse feed gives a remote role's location as "N/A" and no
  pay, and its stripe.com listing page states both.
- A posting's full text is fetched in the same run, for every posting that
  clears the listing-level criteria, so the text-level criteria can be
  judged that morning. Its text is stored only where something reads it:
  for a posting that clears the listing-level criteria judged on the
  posting alone, and for any posting James has acted on. A board that sends
  every posting's text with its listing has the rest discarded as it
  arrives, not stored and cleared every morning. A posting that stops
  clearing them loses its stored text once, at the next run that lists it.
  A posting an edited criterion admits gets its text at the next run that
  lists it, and is judged again with it.

## Processor

- Filters and transforms every posting by code, from the criteria James
  set and nothing else. A posting is in or out, and records which criteria
  it failed. A posting the list shows, kept or acted on, also carries the
  text that decided it, so James can see why it is where it is. Judging is
  deterministic, so any other posting's reasons can be produced again on
  request, one posting at a time, as they stand on the day asked.
- The criteria, all of them:
  - Level: the title words that admit a role — Staff, Senior Staff,
    Distinguished, Architect, Lead — or any number of one or two
    digits or Roman numeral used as a level, or the word Senior (or Sr.) alone. Whether a
    numbered or Senior level is senior enough is settled by the comp floor,
    not by the word; one with no pay posted is out, since there is nothing
    to settle it against. A title that names engineering work (engineer,
    developer) but no level at all is settled the same way: in when pay is
    posted at or above the floor, out otherwise.
  - Role: title words that signal the work — backend, full-stack,
    platform, infrastructure, distributed, api, services, payments,
    software engineer. A role word counts only in a title that also
    names engineering work (engineer, developer, architect, member of
    technical staff); alone it names a team or an industry.
  - Excluded title words: the disciplines and specialisms he was never in,
    with the team-name exception (a word like "customer" after the role
    part of an engineering title does not exclude).
  - Remote required: where the board states the posting's workplace, that
    decides — remote is in; hybrid and on-site are out — whatever the text
    says. Where it states none, the posting's text affirms it, or says
    nothing and its location does; a stated office requirement in the text
    overrules either, unless the text also carries the recruiter's own
    remote tag or the location names Remote — a posting tagged or labelled
    remote is remote, whatever else its prose says. Excluded states, until
    the restriction lifts.
  - United States only: a posting whose location names another country, or
    whose text restricts it to one, is out. A posting that names no country
    is in, unless its location names a place on the excluded-locations
    list: the foreign cities a board writes where a country would be. A
    location that also names a place in the United States (a state, or a
    city a board writes without one, in a part of the location that names
    no other country) is in, whatever else it names.
  - Age: a posting whose board date is older than the max age is out, and,
    for a posting James has not acted on, that is its whole verdict; no
    other criterion is checked. A posting with no board date is in on age
    and judged on every other criterion.
  - Gone: a posting its board's read did not list is out, marked gone as of
    that read. Each board carries when it was last read, and only a read
    that succeeded counts: listed and recorded, both; a read that fails at
    either step is not a read and says nothing about any posting, however
    many runs it spans. So a de-listed posting is out at the next run, and a
    board that did not answer costs its postings nothing. A posting listed
    again loses the mark and is back in.
  - Unwatched: a posting whose board nothing reads any more is out at the
    next run: its company was dropped, or the board went gone and was
    removed from its company. The reason names which. Not Gone: nothing will list it again, so no read will
    ever decide it. A posting he acted on stays in the record, as every
    acted-on posting does.
  - Duplicate: postings from one board that share their posting date, band
    and location, and whose titles differ only by level words, are one req.
    The one first seen most recently that the level criterion admits is
    judged; the rest
    are out as its duplicates.
  - A comp floor: a band whose top is under it is out. Pay that is not
    posted is in. A bonus counts toward the top: the percentage the text
    states as the target, or an assumed percentage James sets when the
    text names an annual, target, corporate or performance bonus without
    a number. A referral, sign-on or retention bonus is not pay and does
    not count.
  - Required languages he does not have: a posting that requires one is
    out; one that merely welcomes it is in.
- The queue is ordered by each posting's score (see List), highest first;
  ties by the comp band's midpoint, unposted pay at the floor. James can
  sort it by posting date instead, newest first, to reach new postings
  fast. Separately from the sort he picks a view: one list, or grouped by
  company, where a company sorts by its first posting under the chosen sort
  and its heading says how many of its roles are still waiting on him and
  how many he has already applied to: two counts of the rows under that
  heading, not a total of them, since a role he closed is in neither. He
  applies to about one role per company however many it offers, so grouped
  the queue is the shape of the decision he is actually making; as a list it
  is the shape of the single best role. The view and the sort are two
  choices, not one, since grouping is a way of laying rows out and takes
  either sort. The list remembers both.
- James edits the criteria in the list. Each run re-judges, against the
  current criteria, every posting still in reach: posted within the max
  age, undated, kept, acted on, or never judged. A kept posting that has
  crossed the max age gets one last judgment, which puts it out. Any other
  posting past the current max age cannot come back while it stands, so it
  is not judged again; raising the max age brings the postings it re-admits
  back into reach. With no max age set, every posting is re-judged. A posting whose band changes on a
  re-list is re-judged that run: its verdict is the one its current band
  earns.
- The processor never changes a posting's status. Status is James's.
- _Open:_ the first values of each list and the floor.

## List

- James's only interface. Opens on the queue: postings the processor let
  through that James has not acted on, highest score first, each with its
  comp, how long ago it was posted, its reasons and a link to the posting.
  It opens on what it last read and refreshes behind it.
- The queue takes one text filter, matched against a posting's company and
  its title together. A hundred and more rows is more than a morning, and
  what James narrows by is either the company he is thinking about or the
  kind of role. One box answers both, and which of the two a word hit does
  not matter to him. It narrows what is waiting, so the heading's count and
  the grouped headers follow it and keep meaning the same thing. It is not
  remembered between visits: the view and sort are how he reads the queue
  and last, a filter is for the minute he is in.
- Grouped by company, a company shows every posting it has: the ones
  waiting on James and the ones he has acted on, each with its status and
  the outcomes that status allows. He applies to about one role per company,
  so the roles he has already taken are what the remaining ones are judged
  against, and the company is the decision. The waiting ones come first,
  in the chosen sort; the acted-on ones follow as that company's history.
  The queue's count stays the number waiting on him, so it means the same in
  every view and sort. A company with nothing left waiting does not appear.
  There is no decision to make there, and its history is the Record's.
- A card says how long ago the posting went up, because how fresh a
  posting is decides whether applying to it is worth anything, and the
  score alone does not say: the same 70 can be a stale posting that pays
  well or a new one that pays less. The age is the board's own posting
  date. A posting whose board never gave one says nothing rather than
  passing off the day the search first saw it as the day it went up.
- Each posting carries a score out of 100, read from two facts: the top
  of its comp band against the comp floor (the same number the floor
  admits it on), and whether its title names product work, from a list
  James edits. How recently it was posted is not one: it did not rank
  which postings James applied to, and the card and the posting-date
  order already show it. A posting that names no pay scores below one
  that names pay above the floor. The score is the queue's order and is
  shown on the card.
- A closed posting shows the reason James gave.
- What James does to a posting is the only thing that moves it off the
  queue: applied, interviewing, rejected, offer, closed. Each records its
  date; closed asks for a reason, since it disagrees with the processor.
- A card offers only the outcomes that make sense from where the posting
  already stands: from the queue, applied or closed; from applied,
  interviewing, rejected or closed; from interviewing, offer, rejected or
  closed; from offer, closed. Rejected and closed are ends. A posting at
  an end offers one quiet change instead, which opens all five, because a
  status set by mistake is still James's to correct.
- Every posting the processor let through, and every posting James has
  acted on whatever the processor now says of it, filterable by status,
  company and title; the ones James has acted on first, most recent act
  first, then the rest in the queue's order. He can sort it by score or
  newest first instead, and view it as one list or grouped by company, the
  same two choices the queue offers, remembered apart from the queue's.
  Grouped, every row sits under its company, whatever its status, and a
  company whose every role he closed says so in its heading. What the
  processor kept out and James never touched is not shown.
- Add: a company name, a posting's URL, or both, becomes a candidate at
  the next run, read the same morning if its board answers.
- Companies: every company, each with how many of its postings are in the
  queue, most first; those added in the last week come first as new, each
  with where it came from and why. James can drop one.
- Candidates: what was suggested, by whom, why, and what became of it,
  newest first.
- Criteria: editable.
- Nothing is computed from the statuses.

## Data

Four things are stored: postings, companies, candidates, criteria.

One rule governs what is written: write only on change, store only what
something reads. A column nothing reads is not kept, and a row is not
rewritten to say it has not changed.

A candidate carries two facts from two hands: what its input said (the
name, any URL, its origin, its evidence, when it was added), and what
discovery made of it (its outcome, when, and the company it names). A
company carries three, from three hands: its boards, which discovery
writes; whether James dropped it, with his reason; and when peer
expansion last searched its peers. No writer touches another's columns.
Everything else said of a company is derived: whether it is read, how
often, where it came from and its aliases, from its candidates and
postings. A dropped company keeps whatever discovery last saw; clearing
the drop restores nothing else. This is the shape postings already have
(status is James's, the verdict is the processor's), and it is what lets
the sentence below hold without a guess about who wrote last.

They live in one Postgres, the one the list reads: every posting the
title and place checks admit, and every one James acted on, the text of the postings something reads (see Ingestion),
everything the processor derives and everything James decides. For this
operator it is a hosted Supabase project, whose free tier holds the
whole record.

What James decides is written in the list, and what the processor derives
is written by the run, into the same rows. Neither overwrites the other
because they own different columns: a posting's status and its note, a
company's drop and its reason, when its peers were searched, a candidate
he or the peer skill adds, and the criteria are his, and nothing the run
writes names them. On 2026-09-18 a drop written during a run was lost
because the drop and the processor's state shared one column; keeping the
columns apart is what lets a decision made while a run is in flight
stand, with no step that reconciles two copies.

Tests never touch the store of record: they run against a separate
database on the machine that runs them.

The tool ships no copy of the store: a stranger cloning the tool would
never configure one, and a scheduled dump or a hosted provider's own
backups are the operator's choice. The one store holds everything,
James's decisions included, so it is the one thing a copy has to cover.

## Operation

One job, every weekday morning: discover, ingest, judge. Discovery comes first so a
board it takes is read that same morning: the sooner James sees a new
posting, the better his chance at it. The boards ingestion finds gone go
back to discovery within the same run. It fails loudly rather than
quietly doing nothing.
