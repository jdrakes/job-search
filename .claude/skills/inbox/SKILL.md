---
name: inbox
description: 'Inbox check: reads James''s mail for a window, reports every application email the store disagrees with (a rejection, an interview, an application it has no row for) and every suggested role the tool missed with its cause, then writes only the corrections he chooses. Use for /inbox, /inbox <since>, "check my email for job updates", "check the statuses in my email", "what did the job alerts suggest that the tool missed", or any request to reconcile job email with the store.'
argument-hint: "[since: YYYY-MM-DD or Nd, default 7d]"
---

# inbox

Two read-only agents read the mail in parallel: `inbox-status`
(`.claude/agents/inbox-status.md`) compares application emails with the
store, and `inbox-suggestions` (`.claude/agents/inbox-suggestions.md`)
lists suggested roles the tool did not show, each with its cause. This
skill shows both, proposes corrections, and writes only the ones James
picks. Design: the inbox check bullet under Discovery in `docs/design.md`.

**Nothing is written until James has chosen.** Step 4 is a stop.

Run every command from the repository root.

## 1. The window and the store

- `since`: the argument. `YYYY-MM-DD` as given; `Nd` means N days before
  today; none means 7 days before today. Overlap with an earlier run is
  harmless: rows already right come back as MATCH. Gmail wants it as
  `YYYY/MM/DD`.
- The store's project ref is the first label of `SUPABASE_URL`:

  ```sh
  node --env-file=.env -e 'console.log(new URL(process.env.SUPABASE_URL).hostname.split(".")[0])'
  ```

  A nonzero exit stops here: show James its stderr.

Every store read and write goes through `mcp__claude_ai_Supabase__execute_sql`
with that ref. Load it, and nothing else, with ToolSearch first.

## 2. Read, in parallel

Dispatch both agents in one message so they run at the same time. Each
prompt is one JSON object and nothing else:

```json
{ "after": "<since as YYYY/MM/DD>", "project_id": "<ref>" }
```

## 3. Show James

Lead with what needs him, in this order, as tables:

1. **Status changes**: STATUS and DATE rows from `inbox-status`.
2. **Applications with no row**: NOT IN STORE rows.
3. **Can't tell which row**: AMBIGUOUS rows, each with its candidate rows.
4. **Interviews**: every interviewing row and its latest email.
5. **Missed roles that fit**: FIT and MAYBE rows from `inbox-suggestions`,
   with their causes. Say how many misses this window holds; the design's
   bar is fewer than one a month.
6. **Recruiters waiting on a reply**.
7. Anything else worth knowing, one line each. MATCH rows only as a count.

Relay quotes as the agents wrote them. When an agent says it did not read
every page, say so above its tables.

## 4. Propose, and stop

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

## 5. Write what he chose

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

## 6. Report

One table of what was written: row | before | after | result. Any
SKIPPED row is named with the reason. End with one line on how to undo:
every corrected row's note holds its old values; a hand-added row or a
candidate is removed by its key or id.
