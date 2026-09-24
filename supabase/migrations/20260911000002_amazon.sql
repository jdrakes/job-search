-- Migration 20260911000002_amazon: widen `jobs.platform`'s CHECK constraint
-- to admit the seventh board platform, Amazon: the first bespoke career
-- site, not an ATS vendor another employer might also be on.
--
-- Hand-written, as every migration after the init is. The DROP/ADD pair
-- below is the delta the regenerated db/schema.sql shows for `jobs`: only
-- the `platform` CHECK's IN-list gains 'amazon', nothing else. The
-- constraint's name, `jobs_platform_check`, is Postgres's own default for an
-- unnamed inline CHECK on that column — the same name
-- 20260911000001_smartrecruiters.sql confirmed live via
-- pg_get_constraintdef and widened for the same reason.
--
-- Written idempotently on purpose, same as every migration after the init:
-- `supabase db reset` replays the REGENERATED init first, which already
-- creates `jobs` with `amazon` in the CHECK, so the DROP/ADD here is a no-op
-- there. Against the live project, still holding the narrower CHECK from
-- when 20260911000001_smartrecruiters.sql last widened it, this is what
-- actually widens it further.

ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_platform_check";
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260911000002_amazon');
