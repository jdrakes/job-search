-- Migration 20260910000000_employer_disqualified: an employer may carry a
-- recorded company-wide disqualification, and the stage vocabulary gains
-- `employer_ruled_out`.
--
-- Hand-written, as every migration after the init is: an ALTER cannot be
-- derived from a before-and-after schema without a database to diff against.
-- The stage list is spelled out here because a migration is a snapshot of one
-- moment; `src/schema.ts`'s STAGES stays the only definition the code reads.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already carries both changes, so these
-- statements must be no-ops there; against the live project, still holding the
-- init as it was first applied, they are what actually add them.

ALTER TABLE "employers" ADD COLUMN IF NOT EXISTS "disqualified" jsonb;

ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_stage_check";

ALTER TABLE "events" ADD CONSTRAINT "events_stage_check" CHECK ("stage" IN ('silenced', 'in_pipeline', 'employer_ruled_out', 'non_us', 'below_floor', 'title', 'candidate'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260910000000_employer_disqualified');
