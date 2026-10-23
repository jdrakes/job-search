-- Migration 20261022000000_clearcompany_platform: widen `postings.platform`'s
-- CHECK to admit ClearCompany, which replaced HRMDirect: every
-- `{slug}.hrmdirect.com` now redirects to `apply.clearcompany.com/{slug}`.
-- 'hrmdirect' stays, because historical postings still say it.
--
-- Hand-written and idempotent like every migration after the init. The
-- constraint's name, `postings_platform_check`, is Postgres's default for
-- the unnamed inline CHECK and is what pg_get_constraintdef reports live.

ALTER TABLE "postings" DROP CONSTRAINT IF EXISTS "postings_platform_check";
ALTER TABLE "postings" ADD CONSTRAINT "postings_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon', 'workable', 'rippling', 'jobvite', 'bamboohr', 'avature', 'breezy', 'jazzhr', 'recruitee', 'personio', 'hrmdirect', 'icims', 'clearcompany'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20261022000000_clearcompany_platform')
  ON CONFLICT DO NOTHING;
