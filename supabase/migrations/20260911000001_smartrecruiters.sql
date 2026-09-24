-- Migration 20260911000001_smartrecruiters: widen `jobs.platform`'s CHECK
-- constraint to admit the sixth board platform, SmartRecruiters.
--
-- Hand-written, as every migration after the init is. The DROP/ADD pair below
-- is the delta the regenerated db/schema.sql shows for `jobs`: only the
-- `platform` CHECK's IN-list gains 'smartrecruiters', nothing else. The old
-- constraint's name, `jobs_platform_check`, is Postgres's own default for an
-- unnamed inline CHECK on that column (confirmed live via
-- pg_get_constraintdef against the linked project); the CREATE TABLE in the
-- init migration relies on that same default, so this migration must too.
--
-- Written idempotently on purpose, same as every migration after the init:
-- `supabase db reset` replays the REGENERATED init first, which already
-- creates `jobs` with `smartrecruiters` in the CHECK, so the DROP/ADD here is
-- a no-op there. Against the live project, still holding the narrower CHECK
-- from the init as first applied, this is what actually widens it.

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_platform_check";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260911000001_smartrecruiters');
