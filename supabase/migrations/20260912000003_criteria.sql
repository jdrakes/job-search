-- Migration 20260912000003_criteria: the `criteria` table — the store's copy
-- of each file under profile/criteria/, one row per version, so the UI's
-- Criteria tab can read what the engine reads from the repo — and
-- `runs.queue_depth`, the Active rows by grade when `finish` closed a run
-- (Interface build, 2026-09-12).
--
-- Hand-written, as every migration after the init is. The CREATE TABLE and
-- the ADD COLUMN definition below are what the regenerated db/schema.sql
-- carries for `criteria` and for `runs`, copied verbatim; tests/schema.test.ts
-- pins them equal, so `src/schema.ts` stays the one definition and this file
-- is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the table, its RLS, both
-- policies and the column, so every statement here must be a no-op there (a
-- policy has no IF NOT EXISTS, hence the DROP first). Against the live
-- project, still holding the init as it was first applied, they are what
-- actually add the table and the column.
--
-- The file stays the authority: the engine reads it, hash-enforced, and the
-- browser cannot reach the repo. No backfill here — `criteria sync` upserts
-- one row per file and runs live once after this migration, and in the import
-- workflow after that. The UPDATE policy exists for one write, a rejection
-- from the UI, and the column privilege limits it to the three columns a
-- rejection touches; the body is never edited (architecture: versions are
-- never edited or deleted) and approve stays in the CLI because it stamps the
-- repo file.
--
-- `queue_depth` is nullable and has no default: a run finished before the
-- measure existed has no depth, and `{}` would read as "measured, empty".

CREATE TABLE IF NOT EXISTS "criteria" (
  "version" text PRIMARY KEY,
  "status" text NOT NULL CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "derived_at" timestamptz NOT NULL,
  "supersedes" text,
  "profile_hash" text NOT NULL,
  "approved_at" timestamptz,
  "rejected_at" timestamptz,
  "rejected_reason" text,
  "body" jsonb NOT NULL
);

ALTER TABLE "criteria" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "criteria";
CREATE POLICY "authenticated_read" ON "criteria" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_write" ON "criteria";
CREATE POLICY "authenticated_write" ON "criteria" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "criteria" FROM authenticated;
GRANT SELECT ON TABLE "criteria" TO authenticated;
GRANT UPDATE ("status", "rejected_at", "rejected_reason") ON TABLE "criteria" TO authenticated;

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "queue_depth" jsonb;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260912000003_criteria');
