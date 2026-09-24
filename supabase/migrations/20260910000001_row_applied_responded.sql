-- Migration 20260910000001_row_applied_responded: a pipeline row can now
-- carry the day it was applied to and the day a reply arrived, and the
-- browser's writable-column grant widens to match `UI_WRITABLE`.
--
-- Hand-written, as every migration after the init is: an ALTER cannot be
-- derived from a before-and-after schema without a database to diff against.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already carries both changes, so these
-- statements must be no-ops there; against the live project, still holding the
-- init as it was first applied, they are what actually add them.

ALTER TABLE "pipeline" ADD COLUMN IF NOT EXISTS "applied_at" date;
ALTER TABLE "pipeline" ADD COLUMN IF NOT EXISTS "responded_at" date;

REVOKE ALL ON TABLE "pipeline" FROM authenticated;
GRANT SELECT ON TABLE "pipeline" TO authenticated;
GRANT UPDATE ("status", "notes", "blocked_on", "applied_at", "responded_at") ON TABLE "pipeline" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260910000001_row_applied_responded');
