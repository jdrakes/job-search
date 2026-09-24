-- Migration 20260913000001_worklist: the `worklist` table — one run's items,
-- posting bodies included, which the half that decides reads. This is what
-- replaces the `runs/<id>` branch: `worklist.json` and `recheck.json` become
-- rows told apart by `kind` (the git-bus retirement, 2026-09-13).
--
-- Hand-written, as every migration after the init is. The CREATE TABLE below
-- is what the regenerated db/schema.sql carries for `worklist`, copied
-- verbatim; tests/schema.test.ts pins the two equal, so `src/schema.ts` stays
-- the one definition and this file is a snapshot of it at one moment.
--
-- `liveness` and `duplicate_of` were added to the CREATE TABLE here rather
-- than by a later ALTER (2026-09-13, the same build): this file has never been
-- applied to any database — nothing in CI pushes migrations, and the branch
-- that introduces it has not landed — so there is no `worklist` table anywhere
-- for an ALTER to reach, and a delta against a table that does not exist would
-- be noise in the history for ever. A second migration becomes necessary the
-- moment this one has run somewhere.
--
-- The primary key was changed in place here on the same grounds, later the
-- same day and still before any apply: it was `key` alone, which let a second
-- run overwrite the rows of a run still open, and is now the derived
-- `<run_id>@<key>` (src/schema.ts: `worklistId`).
--
-- A third in-place change, 2026-09-13 and still before any apply: an UPDATE
-- policy and a four-column UPDATE grant on `runs` stood here for the half that
-- decides, which was to have signed in as a restricted `authenticated` user.
-- Supabase has no restricted backend key — a secret key bypasses RLS and has
-- full access, a publishable key is the `anon` role — so that half holds a
-- secret key like every other backend caller and reaches nothing through
-- `authenticated` at all. The grant would have widened the BROWSER's rights
-- for no reader, so it is gone and `authenticated`'s rights on `runs` are the
-- init's: SELECT only.
--
-- A fourth, 2026-09-14 and still before any apply: this file also widened
-- `runs_status_check` to admit a fourth run status, `answered`, which a cloud
-- routine set to tell a scheduled job its decisions were written. That half
-- runs locally and closes its own run, so the status is gone from
-- `RUN_STATUSES` and the widening with it — `runs` is left exactly as the init
-- has it, and this migration touches only `worklist`.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the table, its RLS and its
-- policy, so every statement here must be a no-op there (a policy has no
-- IF NOT EXISTS, hence the DROP before it). Against the live project, still
-- holding the init as it was first applied, they are what actually add them.
--
-- No backfill and no index. One row per (run, posting), and `cli fetch`
-- deletes the rows of every run that is `complete` — once `finish` closed it —
-- or `aborted`, so the table holds the run just written plus every run still
-- `open`. The largest run measured on 2026-09-13 makes that 166 rows at
-- ~6.6 KB of body each, ~1.1 MB.
-- Nothing here enforces that bound and nothing in SQL can: the DELETE is the
-- engine's, in src/cli/fetch.ts.
--
-- `authenticated` gets SELECT on `worklist` and nothing more: the browser
-- shows what a run was asked to judge, and every write to this table is the
-- engine's, with the secret key. No DELETE is granted on any table, here or
-- anywhere.

CREATE TABLE IF NOT EXISTS "worklist" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL,
  "run_id" text NOT NULL,
  "company" text NOT NULL,
  "title" text,
  "url" text,
  "location" text,
  "geo" text CHECK ("geo" IN ('us-remote', 'non-us', 'office-anchored', 'unknown')),
  "comp_low" integer,
  "comp_high" integer,
  "days_old" integer,
  "source" text,
  "body" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('candidate', 'recheck')),
  "liveness" text CHECK ("liveness" IN ('live', 'gone', 'unknown')),
  "duplicate_of" text,
  "at" timestamptz NOT NULL
);

ALTER TABLE "worklist" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "worklist";
CREATE POLICY "authenticated_read" ON "worklist" FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE "worklist" FROM authenticated;
GRANT SELECT ON TABLE "worklist" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260913000001_worklist');
