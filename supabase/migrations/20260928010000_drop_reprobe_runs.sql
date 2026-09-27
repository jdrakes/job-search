-- Migration 20260928010000_drop_reprobe_runs: drop `reprobe_runs`
-- (job-search-archive#275).
--
-- The backlog pass it tracked (`scripts/reprobe.ts`) is deleted in the same
-- change: a URL now reaches every board the survey and the backlog pass
-- existed to find by hand, so there is nothing left to record a pass over.
-- Its one recorded row, from 2026-09-23, found nothing.
--
-- Idempotent, like every migration here.

DROP TABLE IF EXISTS "reprobe_runs";

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928010000_drop_reprobe_runs');
