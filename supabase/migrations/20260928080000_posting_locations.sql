-- Migration 20260928080000_posting_locations: `postings.locations`, the
-- office set a same-requisition, multi-office listing collapses into
-- (job-search-archive#282, "Collapse same-requisition, multi-office
-- postings").
--
-- Greenhouse's public job-board API returns one row per (requisition ×
-- office); `groupByRequisition` (src/ingest.ts) now collapses those into one
-- `postings` row per requisition, keeping every office's own name and apply
-- link as `{name, url}` pairs so the UI can still show and link each one.
-- Every other platform has no requisition concept, so its listings pass
-- through `groupByRequisition` as singleton groups and this column holds
-- exactly one office there, same as today's single row.
--
-- jsonb array, matching the existing convention for a column of this shape
-- (`reasons`, `companies.boards`). Defaulted to '[]' rather than left
-- nullable so no reader has to handle a null array; the daily run's next
-- write to a stored row fills in its real office(s) via `toRow`.
--
-- Idempotent, like every migration here: `IF NOT EXISTS` on the column.

ALTER TABLE "postings" ADD COLUMN IF NOT EXISTS "locations" jsonb NOT NULL DEFAULT '[]';

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928080000_posting_locations')
  ON CONFLICT DO NOTHING;
