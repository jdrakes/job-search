---
name: job-email
description: 'Job email check: reads James''s mail for a window, reports every application email the store disagrees with (a rejection, an interview, an application it has no row for) and every suggested role the tool missed with its cause, then writes only the corrections he chooses. Use for /job-email, /job-email <since>, "check my email for job updates", "check the statuses in my email", "what did the job alerts suggest that the tool missed", or any request to reconcile job email with the store.'
argument-hint: "[since: YYYY-MM-DD or Nd, default 7d]"
---

# job-email

This skill lists the window's mail itself, then read-only agents read the
threads it hands them, in parallel: `job-email-status`
(`.claude/agents/job-email-status.md`) compares application emails with the
store, and `job-email-suggestions` (`.claude/agents/job-email-suggestions.md`)
lists suggested roles the tool did not show, each with its cause. The skill
checks every handed thread was opened, shows both, proposes corrections,
and writes only the ones James picks. Design: the job email check bullet under Discovery in `docs/design.md`.

**Nothing is written until James has chosen.** Step 5 is a stop.

Run every command from the repository root.

## 1. The window and the store

- `since`: the argument. `YYYY-MM-DD` as given; `Nd` means N days before
  today; none means 7 days before today. Overlap with an earlier run is
  harmless: rows already right come back as MATCH. Gmail wants it as
  `YYYY/MM/DD`, and reads a date as UTC midnight, so the window starts at
  7pm Central the evening before; that overlap is harmless too.
- The store's project ref is the first label of `SUPABASE_URL`:

  ```sh
  node --env-file=.env -e 'console.log(new URL(process.env.SUPABASE_URL).hostname.split(".")[0])'
  ```

  A nonzero exit stops here: show James its stderr.

Every store read and write goes through the Supabase `execute_sql` tool
with that ref, and the mail is listed with Gmail's `search_threads`. Load
those two, and nothing else, with ToolSearch first. Where connectors carry
readable names they are `mcp__claude_ai_Supabase__execute_sql` and
`mcp__claude_ai_Gmail__search_threads`; where they carry their IDs,
`mcp__fb8238cb-b279-482d-8cff-5e7e3467ad50__execute_sql` and
`mcp__e4ea54a3-b518-4bbb-9b28-ff32cd6421f8__search_threads`. The agents'
`tools:` lines list both schemes, so a session with either launches them;
a connector re-added under a new ID needs its new name added there.

## 2. List the mail

Gmail's search returns at most 50 threads, in no date order, and only
sometimes a next page (none on 2026-11-03, one on 2026-11-04), so a search
that hits the cap can drop threads at random. The window is listed one
UTC day at a time:

1. For each day D from `since` through today: `after:D before:D+1`,
   `pageSize` 50, `view` `THREAD_VIEW_MINIMAL`. While a reply carries a
   `nextPageToken`, ask again with it.
2. A search is cut off when its last page came with no `nextPageToken`
   and it returned 50 threads in all. Run a cut-off search again as two,
   one with `category:updates` added and one with `-category:updates`, each
   paged the same way. A half still cut off is incomplete: keep its day for
   step 4.
3. Dedupe by thread id; a thread that spans days comes back on each.
4. Sort each thread by sender and subject into two lists. One that could
   be either goes in both; one that is neither (personal mail,
   newsletters, receipts, sign-in codes) in neither.
   - **Suggestions**: job alerts and digests (LinkedIn jobs and job
     alerts, Indeed jobalert and match, Glassdoor, Wellfound, BuiltIn,
     Dice, ZipRecruiter, Workable digests, getclera.com, talenthop.com,
     Ladders, Raydar, Jobgether, any other alert), and recruiter outreach
     naming a role (LinkedIn hit-reply and inmail-hit-reply, a person
     whose subject names a role).
   - **Status**: ATS senders (ashbyhq.com, greenhouse-mail.io,
     greenhouse.io, lever.co, myworkday.com, icims.com but not its
     nurture marketing, rippling.com, gem.com, smartrecruiters.com,
     workable.com, workablemail.com, jobvite.com, bamboohr.com,
     clinchtalent.com), LinkedIn Easy Apply and Indeed Apply
     confirmations, company no-reply, careers, talent and recruiting
     addresses, a scheduling tool's interview booking, and a person
     replying about a role James applied to.
5. Cut the suggestions list into batches of at most 10 threads, in date
   order. A digest costs an agent about 6K tokens; ten keep it well clear
   of its context.

Keep the counts for step 4: days searched, threads listed, threads in each
list, batches.

## 3. Read, in parallel

Dispatch, in one message so they run at the same time, one
`job-email-status` agent with the whole status list and one
`job-email-suggestions` agent per batch. Each prompt is one JSON object
and nothing else:

```json
{ "after": "<since as YYYY/MM/DD>", "project_id": "<ref>", "threads": ["<id>", "..."] }
```

When every agent has returned:

1. **Coverage.** Each agent lists the thread ids it opened. Any id it was
   given and did not open goes once more, alone with the others it
   missed, to a fresh agent of the same kind. An id still unopened is
   named in step 4 with its sender and subject.
2. **Merge the suggestions.** One row per role across batches, matched on
   company and title ignoring case and punctuation. Keep the earliest
   date and every source and date. Where two batches gave one role a
   different cause or fit, show both and mark the row. Count roles,
   fit-checked and missed from the merged rows; never add up the agents'
   counts.

## 4. Show James

Above the tables, one line each: days searched, threads listed, threads
in each list, agents run; any day still cut off; any thread no agent
opened.

Lead with what needs him, in this order, as tables:

1. **Status changes**: STATUS and DATE rows from `job-email-status`.
2. **Applications with no row**: NOT IN STORE rows.
3. **Can't tell which row**: AMBIGUOUS rows, each with its candidate rows.
4. **Interviews**: every interviewing row and its latest email.
5. **Missed roles that fit**: FIT and MAYBE rows from `job-email-suggestions`,
   with their causes. Say how many misses this window holds; the design's
   bar is fewer than one a month.

   Before showing them, run
   `node --env-file=.env scripts/explain-miss.ts "<company>" "<title>"` for
   every FIT or MAYBE miss whose cause is "board read without the posting",
   and replace the agent's cause with the script's. Say how many causes
   changed.

6. **Recruiters waiting on a reply**.
7. Anything else worth knowing, one line each. MATCH rows only as a count.

Relay quotes as the agents wrote them.

## 5. Propose, and stop

Number every proposed write:

| # | Write | Row or name | From | To | Evidence |

What can be proposed:

- **A status or date** on an existing row (STATUS, DATE).
- **A hand-added row** for an application the tool never read.
- **A candidate** for a missed company whose cause is _company unknown_.
- Nothing for an AMBIGUOUS row until James names the row.
- Nothing for a recruiter screen, an aggregator's own call, or a listing
  whose employer is not named.
- Never a board change or a criteria change. Those need their own
  check: before pointing a company at another board, confirm no other
  company already carries it (`companies.boards`), and confirm the board
  is the same employer, not a name collision.

Then ask: **"Which do I write? Numbers, `all`, `none`, or a row for each
ambiguous one."** Wait for the answer.

## 6. Write what he chose

Each write is guarded on the values the agent saw, so a row James changed
since is skipped, not overwritten. Today's date is `<today>` below.

**Status or date on an existing row.** One statement for all of them:

```sql
with changes(key, exp_status, exp_applied, exp_status_at,
             new_status, new_applied, new_status_at, why) as (values
  ('<key>', '<old status or null>', <old applied_at or null>::date, <old status_at or null>::date,
   '<new status>', <new applied_at or null>::date, '<new status_at>'::date, '<evidence, short>')
), done as (
  update postings p
  set status = c.new_status, applied_at = c.new_applied, status_at = c.new_status_at,
      note = concat_ws(E'\n', p.note,
        'Corrected <today> from Gmail: ' || c.why || '. Was '
        || coalesce(c.exp_status, 'null') || ' / applied ' || coalesce(c.exp_applied::text, 'null')
        || ' / status_at ' || coalesce(c.exp_status_at::text, 'null') || '.')
  from changes c
  where p.key = c.key
    and p.status is not distinct from c.exp_status
    and p.applied_at is not distinct from c.exp_applied
    and p.status_at is not distinct from c.exp_status_at
  returning p.key
)
select c.key, case when d.key is null then 'SKIPPED (row changed)' else 'updated' end as result
from changes c left join done d using (key);
```

Quote null without quotes (`null::date`, `null`), and a status of null as
`null`, not `'null'`.

**Hand-added row.** The key is `<Company>::<the employer's requisition id,
else a short slug of the title>`, with no platform, board or URL, like the
rows already added this way:

```sql
insert into postings (key, company, title, first_seen, kept, status, applied_at, status_at, note)
values ('<Company>::<id or slug>', '<Company>', '<title>', '<applied date> 12:00+00', false,
        '<status>', '<applied date>', '<status date>',
        'Hand-added <today> from Gmail: <confirmation date and sender>; <outcome email, if any>.')
on conflict (key) do nothing
returning key, status, applied_at, status_at;
```

A key that already exists returns nothing: tell James, and do not retry
with another key.

**Candidate.** First check the name is not already a company or a
candidate (`companies.name ilike`, `candidates.name ilike`); if it is, say
so and skip it. Otherwise, as the list's Add form does:

```sql
insert into candidates (name, url, evidence, origin)
values ('<name>', null, '<source, date, role and pay as the alert gave them>', 'james')
returning id, name, outcome;
```

## 7. Report

One table of what was written: row | before | after | result. Any
SKIPPED row is named with the reason. End with one line on how to undo:
every corrected row's note holds its old values; a hand-added row or a
candidate is removed by its key or id.
