# job-search design

This is the design record of the author's own instance, carried into the
public repository as it was written. That is why it speaks about one operator
by name and in the third person. Read "James" as "the operator" and it holds
for any instance; where the shipped code and this page have parted company,
this page has been corrected and the commit says so.

A funnel: wide discovery at the top, ingestion from every company it finds,
a deterministic processor that filters and transforms, and a short list
James acts on. No model anywhere. Breadth is discovery's and ingestion's
job; narrowing is the processor's alone. A change of design edits this page
first; the work to build it is tracked elsewhere.

## Discovery

- Finds companies hiring, as many as it can. Any page or feed that names
  companies is a source; sources are added whenever one is found and never
  removed for yielding little. Today's are HN "Who is hiring", RemoteOK and
  WeWorkRemotely. Which of them a run reads is the operator's, in
  `settings/config.json`; a source of the operator's own is pointed at by
  `extraSourcePath` rather than added here, and is handed the level words the
  criteria name.
- A name is probed against every applicant tracking system the tool reads;
  a company whose board answers under its name is watched from then on. A
  name with no answering board stays visible as discovered; its board, where
  one exists, is found by the ATS survey (a by-hand pass over each such
  company's own careers page, imported with `watch:survey`), since a name
  alone reaches only the systems whose board id is a slug.
- A watched board that stops answering (gone, not merely empty) returns
  its company to discovered after two runs, so the next survey finds it
  again and it comes back if the company moved to another system. Two runs,
  not one: a single failed read is a bad morning, not a closed board. This
  is not a judgement of the company and not a drop; the name stays visible,
  as any discovered name does.
- Discovery never judges a company. Dropping one is James's, in the list: a
  dropped company is not read and is not re-added when its name is seen
  again, and its postings still waiting on him leave the queue at the next
  run (the Unwatched criterion).
- A name whose probe answers with a board another company already carries
  is recorded as that company's alias and watched no further, so one req
  is one row whatever names point at it.
- A platform is added, as an ATS reader or a discovery source, only on
  technical grounds, never on whether its companies look like a match:
  that narrowing is the processor's job, not discovery's. Required, all
  four: public and reachable without login, a key or a paid plan; returns
  at least a title, and ideally location, workplace and comp, per posting;
  a way to bind a company to its board, either a predictable per-company
  slug for the automated probe or a fixed board id addable by hand through
  the ATS survey; and a stable structure, a plain HTTP/JSON API, not a
  page that only renders through JavaScript, so it does not need a new
  dependency to read and does not break on every redesign.

## Ingestion

- Every watched company is read from its own applicant tracking system
  (Greenhouse, Ashby, Lever, Workday, Eightfold, SmartRecruiters, Amazon,
  Workable, Rippling) every weekday. Every posting seen is recorded, with
  where it came from and when it was first and last seen. Nothing is
  dropped and nothing is filtered here.
- Where the tracking system states a posting's workplace, that is recorded
  with the posting as the board's own word (remote, hybrid or on-site)
  wherever the system states it: on the listing (Ashby, Lever,
  SmartRecruiters), on the posting's detail (Workday, where the tenant
  fills it), or on a second per-posting read the system offers (Microsoft's
  position details). A system that states none, or a posting the system
  leaves blank, records none.
- A posting's full text is fetched in the same run, for every posting that
  clears the listing-level criteria, so the text-level criteria can be
  judged that morning.

## Processor

- Filters and transforms every posting by code, from the criteria James
  set and nothing else. A posting is in or out, with the reasons and the
  text that decided it, so James can see why a posting is where it is.
- The criteria, all of them:
  - Level: the title words that admit a role (Staff, Senior Staff,
    Principal, Distinguished, Architect, Lead) or any number of one or two
    digits or Roman numeral used as a level, or the word Senior (or Sr.) alone. Whether a
    numbered or Senior level is senior enough is settled by the comp floor,
    not by the word; one with no pay posted is out, since there is nothing
    to settle it against. A title that names engineering work (engineer,
    developer) but no level at all is settled the same way: in when pay is
    posted at or above the floor, out otherwise.
  - Role: title words that signal the work (backend, full-stack,
    platform, infrastructure, distributed, api, services, payments,
    software engineer). A role word counts only in a title that also
    names engineering work (engineer, developer, architect, member of
    technical staff); alone it names a team or an industry.
  - Excluded title words: the disciplines and specialisms he was never in,
    with the team-name exception (a word like "customer" after the role
    part of an engineering title does not exclude).
  - Remote required: where the board states the posting's workplace, that
    decides (remote is in; hybrid and on-site are out) whatever the text
    says. Where it states none, the posting's text affirms it, or says
    nothing and its location does; a stated office requirement in the text
    overrules either, unless the text also carries the recruiter's own
    remote tag or the location names Remote. A posting tagged or labelled
    remote is remote, whatever else its prose says. Excluded states, until
    the restriction lifts.
  - United States only: a posting whose location names another country, or
    whose text restricts it to one, is out. A posting that names no country
    is in, unless its location names a place on the excluded-locations
    list: the foreign cities a board writes where a country would be.
  - Age: a posting whose board date is older than the max age is out. A
    posting with no board date is in.
  - Gone: a posting whose board was read after the posting was last seen,
    and did not list it, is out. Each board carries when it was last read:
    listed and recorded, both; a read that fails at either step is not a
    read and says nothing about any posting, however many runs it spans. So
    a de-listed posting is out at the next run, and a board that did not
    answer costs its postings nothing. A posting listed again is back in.
  - Unwatched: a posting whose board nothing reads any more is out at the
    next run. Its company was dropped, or returned to discovered, or the
    board was removed from a company still watched elsewhere. The reason
    names which. Not Gone: nothing will list it again, so no read will
    ever decide it. A posting he acted on stays in the record, as every
    acted-on posting does.
  - Duplicate: postings from one board that share their posting date, band
    and location, and whose titles differ only by level words, are one req.
    The latest seen that the level criterion admits is judged; the rest
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
  order it by posting date instead, newest first, to reach new postings
  fast, or group it by company, where a company sorts by its best posting
  and its heading says how many of its roles are still waiting on him and
  how many he has already applied to: two counts of the rows under that
  heading, not a total of them, since a role he closed is in neither. He
  applies to about one role per company however many it offers, so grouped
  the queue is the shape of the decision he is actually making; by score it
  is the shape of the single best role. The list remembers which of the
  three he chose.
- James edits the criteria in the list; everything is re-judged against the
  current criteria at the next run. A posting whose band changes on a
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
  remembered between visits: the order is how he reads the queue and lasts,
  a filter is for the minute he is in.
- Grouped by company, a company shows every posting it has: the ones
  waiting on James and the ones he has acted on, each with its status and
  the outcomes that status allows. He applies to about one role per company,
  so the roles he has already taken are what the remaining ones are judged
  against, and the company is the decision. The waiting ones come first,
  highest score first; the acted-on ones follow as that company's history.
  The queue's count stays the number waiting on him, so it means the same in
  every order. A company with nothing left waiting does not appear. There
  is no decision to make there, and its history is the Record's.
- A card says how long ago the posting went up, because how fresh a
  posting is decides whether applying to it is worth anything, and the
  score alone does not say: the same 70 can be a stale posting that pays
  well or a new one that pays less. The age is the board's own posting
  date. A posting whose board never gave one says nothing rather than
  passing off the day the search first saw it as the day it went up.
- Each posting carries a score out of 100, read from three facts: the top
  of its comp band against the comp floor (the same number the floor
  admits it on), how recently it was posted, and whether its title names
  product work, from a list James edits. A posting that names no pay
  scores below one that names pay above the floor. The score is the
  queue's order and is shown on the card.
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
  first, then the rest in the queue's order. What the processor kept out
  and James never touched is not shown.
- Companies: what discovery found and what is watched, each with how many
  of its postings are in the queue, most first; James can drop one.
- Criteria: editable.
- Nothing is computed from the statuses.

## Data

Three things are stored: postings, companies, criteria.

A company carries two facts in two columns, because two hands write them:
what the processor observed (discovered; watched once a board answers; or
an alias, a name whose board another company already carries) and whether
James dropped it, with his reason. Neither writer touches the other's
column. A dropped company keeps whatever the processor last saw; clearing
the drop restores nothing else. This is the shape postings already have
(status is James's, the verdict is the processor's) and it is what lets the
sentence below hold without a guess about who wrote last.

They live in two places, split by who authors them. The store of record is a
Postgres on the machine the run runs on: every posting ever seen, with its
full text, and everything the processor derives. The list reads a hosted
copy holding only what it shows (the queue, the record, the companies, the
criteria), which is under a megabyte where the whole is hundreds.

What James decides is authored in the list and flows down: a posting's
status and its note, a company's drop and its reason, an edit to the
criteria. What the processor derives is authored locally and flows up. The
morning run reconciles them in that order: decisions down before it
judges, the slice up after. Publishing never writes a column James authors,
so neither a failed reconciliation nor a decision made while a run is in
flight is overwritten: on 2026-09-18 a drop written during a run was lost
because the drop and the processor's state shared one column, and publish
put the processor's copy back.

The split is a consequence of the hosted store being free and capped, not a
property of the design. Publishing everything instead of the slice is the
only change if the cap stops mattering.

The store of record lives on one machine, so every run leaves a copy of it
elsewhere: the rows without their text, versioned, off the machine. What
cannot be recovered is the row: its verdict, its reasons, its evidence and
its dates; a posting's text is re-fetched by the next run for anything still
listed. A copy nothing has read back is not a copy, so each one is parsed
before it is kept.

## Operation

One job, every weekday morning: take James's decisions down, discover,
ingest, judge, publish what the list reads, copy the record off the machine.
It fails loudly rather than quietly doing nothing.

The copy comes last because it is the only phase the day's work does not
depend on. A phase that fails after the record is written costs the run its
exit code and nothing else.
