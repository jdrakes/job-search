# job-search

A wide search net, a deterministic processor, and a short list to act on. No
model anywhere in it.

- **Discovery** finds companies hiring, as many as it can, and watches a
  company once its applicant tracking system answers under its name.
- **Ingestion** reads every watched company from its own system every
  weekday. Eighteen are supported, from Greenhouse and Lever to Workday,
  iCIMS and Avature; `src/ats/readers.ts` is the list. Every posting is
  recorded and nothing is filtered.
- **Processor** judges every posting in or out by code, from criteria you set,
  and keeps the reasons and the text that decided it.
- **List** is the queue of what got through, highest score first. What you do
  to a posting is the only thing that moves it off.

`docs/design.md` is the design record and says why each of those is shaped the
way it is. `src/daily.ts` is the one entry point a scheduled run calls. `ui/`
is the list, a Vue page with no bundler, built by `npm run build:ui`.

## What this needs, and what does not work yet

This tool needs a Supabase project. Not a database that looks like one, a
Supabase project. Read the next three paragraphs before you decide to set it
up, because they are the two walls people hit.

**A plain Postgres needs three roles created first.** Thirteen of the
migrations name the `authenticated` role, granting privileges to it and, in
eight of them, creating row-level security policies `TO authenticated`. Those
roles are Supabase's rather than Postgres's. Create them by hand and every
migration applies:

```
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
```

Nothing in `src/` or `scripts/` applies a migration, so the Supabase CLI or
`psql` is how the schema gets in either way.

**A local Supabase gets you the engine but not the list.** `supabase start`
gives you a working database, and the run will discover, ingest and judge
against it. Signing in to the page will not work. Sign-in is a one-time code
sent to an email address, posted with `create_user: false` so a mistyped
address fails rather than quietly enrolling somebody (`ui/src/auth.ts`), and
the browser then reads rows as that signed-in user over PostgREST with a
bearer token (`ui/src/api.ts`), which the policies require. The local
`supabase/config.toml` has `local_smtp` disabled and `studio` disabled, so
there is no mail to carry the code and no dashboard to create the user in.
The engine will fill the database and the page will sit on its sign-in form.

Neither of those is settled design. They are known limitations, and until one
of them is fixed the answer is a hosted Supabase project.

## Before you start

- Node 24.2 or newer. `.nvmrc` names the major version.
- The Supabase CLI. It is the only thing that applies the schema.
- A Supabase project, per the section above.

That is all. `pg` is the only runtime dependency.

## Clone to first search

1. Clone it, then `npm ci`.

2. Create a Supabase project. From its dashboard take three things: the
   project URL, the anon key, and the session pooler connection string.

3. Apply the schema.

   ```
   supabase link --project-ref <your project ref>
   supabase db push
   ```

4. `cp .env.example .env` and fill it in. `JOB_SEARCH_DB_URL` is the session
   pooler connection string. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are the
   other two. Leave `SUPABASE_DB_URL` empty for now; the section "One store or
   two" says what setting it buys you.

5. `cp -R settings.example settings`, then open `settings/config.json` and put
   your own contact point in `userAgent`. The tool will not make a single HTTP
   request until you do. `settings/README.md` says what each field does.

6. Set your criteria. Copy the worked example, edit it, and load it.

   ```
   cp criteria.example.json settings/criteria.json
   npm run criteria:load -- settings/criteria.json
   ```

   Every key in the example is required, and an unknown key is refused by
   name. The example is illustrative and is not a recommendation. `settings/`
   is gitignored, so your real criteria stay out of git.

7. Run it once by hand and read the log.

   ```
   node --env-file=.env src/daily.ts
   ```

   It prints one line per phase with that phase's wall clock and its HTTP and
   store request counts. It fails loudly rather than quietly doing nothing: a
   run that ingests no company at all, or whose every board failed, exits
   non-zero instead of reporting a clean, empty day.

8. Build the list and serve it.

   ```
   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run build:ui
   ```

   `npm run build:ui` reads those two from the environment rather than from
   `.env`, and refuses to build without both. It writes a static `ui/dist`,
   which you can serve with anything; `vercel.json` is here for the hosted
   case.

9. Add your email address as a user in the Supabase dashboard, under
   Authentication, before you try to sign in. Sign-in does not create one. Then
   open the page, ask for a code, and enter it.

Steps 2, 3 and 9 are the ones this repository cannot check for you. What a
Supabase project is called, where its dashboard puts the pooler string, and
what its email provider needs before it will send a code are Supabase's and
can move. Everything else above is a command in this tree, and `src/` is the
authority on what it does.

## The User-Agent is required

`src/net/http.ts` has no built-in User-Agent and will not invent one. With
`userAgent` unset in `settings/config.json` the first request throws, naming
the file and the field.

That is deliberate. This tool reads eighteen applicant tracking systems and
five discovery sources on a schedule. The string it sends is how a host decides
whether to serve you, and who it writes to if it would rather not, so it has
to say who is running it. Put something a person can reach you at.

```
job-search (+https://github.com/your-account)
```

An earlier version shipped the author's own repository URL as the default.
Published that way, every stranger running this tool would have identified as
him to every board and feed it reads, and any complaint would have arrived at
his repository.

## Changing criteria later

Two ways, and both write the same single row.

- `npm run criteria:load -- <file>` again. It replaces the row rather than
  merging into it, so the file is the whole of your criteria every time.
- The Criteria tab in the list. With one store the next run reads the row the
  page wrote; with two, it pulls the row down before it judges anything.

Either way, every posting is re-judged against the current criteria on the
next run. There is no backfill to run and no migration to write. A posting's
verdict is whatever today's criteria earn it.

## Running it every weekday

The run is one command and scheduling it is your machine's business. A cron
line is enough.

```
30 6 * * 1-5 cd /path/to/job-search && node --env-file=.env src/daily.ts >> run.log 2>&1
```

`scripts/daily.sh` is a wrapper for launchd on macOS. Its paths, container
name and clone layout are environment variables with defaults, so set those
before running it. What it does that a cron line does not is find node without
a login shell, refuse to start when the store is unreachable instead of
failing on the first read, and update its own clone from the remote before
each run.

## One store or two

`JOB_SEARCH_DB_URL` is the store of record and is required. `SUPABASE_DB_URL`
names a second store that the list reads, and is optional.

Left empty, the run says it has no second store to pull from and skips both
the pull and the publish. One database holds everything, and the list reads
the same rows the run wrote. That is the shape to start with.

Set, the run takes your decisions down from the second store before it judges,
and publishes the slice the list shows back up afterwards, in that order. The
author runs it that way because his store of record is a Postgres on his own
machine holding every posting it has ever seen with its full text, which is
hundreds of megabytes, while the slice the list needs is under one.

## Four things that are deliberately separate

- `scripts/write-ui-config.ts` bakes `SUPABASE_URL` and `SUPABASE_ANON_KEY`
  into the browser bundle at build time. Which project the page talks to is a
  property of one deployment rather than of this repository, so the operator
  owns that step and nothing here holds those values.
- `npm test` runs the store contract against the memory adapter always, and
  against Postgres only when `.env` names one. With `JOB_SEARCH_DB_URL` unset
  the Postgres half skips and prints why. Skipped there is correct, not
  broken.
- `JOB_SEARCH_BACKUP_REPO` names a git repository the run commits a copy of
  the record into. It receives real postings, so it must point at a private
  repository. Unset, the backup phase logs that it skipped and the run is
  otherwise unchanged.
- The per-host delays in `src/net/http.ts` are not configurable and are not
  going to be. A delay there is a fact about a host, read off its robots.txt
  or measured against it, not a preference. As a setting it would be set to
  zero by somebody, and the block that followed would land on everyone who
  reads that host with this tool.

## The data guard

`npm test` fails when a term belonging to the operator's own search appears in
any file this repository would publish. Scrubbing the tree fixes it once; this
fails the build the next time such a term arrives, whether in code, in a test,
in a fixture or in a comment.

The terms are not in the repository. `tests/personal-data-denylist.json` holds
SHA-256 digests of them, because a public file listing the terms would publish
the very thing the list exists to keep out. Hashing hides them from a reader,
not from someone who guesses a term and hashes it, so the file is obscured
rather than secret.

A failure names the file and the line and withholds the text, because the CI
log of a public repository is as public as the repository. Open the line, take
out what it says about the operator, and commit that.

The guard reads every tracked file and every untracked file git would add, so
anything the operator keeps in the ignored `data/` and `settings/` directories
is outside it. `tests/no-personal-data.test.ts` holds the normalisation rule,
what a term may not be, and how to add one without writing it down anywhere.

## Gates

`npm test`, `npm run typecheck`, `npm run fmt:check`, and the GitHub Action
that runs all three on every pull request. `npm run score:remote` after any
change to a judge phrase list; it scores the remote criterion's text path
against the postings already in your store.

## Contacts

Contacts records the recruiters you have actually written back to, so the
list can show which companies you are already in conversation with.

It is not a phase of the daily run, because it needs a mail connector that
only an interactive session can drive. A session runs the searches and writes
the raw threads to `captures/*.json`. That directory is gitignored, and
captured mail never enters git. Everything after that is ordinary code over
that file:

```
npm run contacts:sync -- captures/<file>.json
```

That carries your decisions down from the hosted store, judges the threads,
and puts the processor's rows back up.
