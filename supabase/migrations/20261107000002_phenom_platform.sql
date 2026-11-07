-- Migration 20261107000002_phenom_platform: widen `postings.platform`'s CHECK
-- to admit Phenom career sites.
--
-- Hand-written and idempotent like every migration after the init. The
-- constraint's name, `postings_platform_check`, is Postgres's default for the
-- unnamed inline CHECK.

ALTER TABLE "postings" DROP CONSTRAINT IF EXISTS "postings_platform_check";
ALTER TABLE "postings" ADD CONSTRAINT "postings_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon', 'workable', 'rippling', 'jobvite', 'bamboohr', 'avature', 'breezy', 'jazzhr', 'recruitee', 'personio', 'hrmdirect', 'icims', 'clearcompany', 'phenom'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20261107000002_phenom_platform')
  ON CONFLICT DO NOTHING;
