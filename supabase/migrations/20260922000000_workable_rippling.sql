-- Migration 20260922000000_workable_rippling: widen `postings.platform`'s
-- CHECK to admit Workable and Rippling, the two ATSs the Ingestion design
-- document adds to the source list.
--
-- Hand-written and idempotent like every migration after the init. The
-- constraint's name, `postings_platform_check`, is Postgres's default for
-- the unnamed inline CHECK and is what pg_get_constraintdef reports live.

ALTER TABLE "postings" DROP CONSTRAINT IF EXISTS "postings_platform_check";
ALTER TABLE "postings" ADD CONSTRAINT "postings_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon', 'workable', 'rippling'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260922000000_workable_rippling');
