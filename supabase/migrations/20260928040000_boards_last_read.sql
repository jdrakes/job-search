-- Migration 20260928040000_boards_last_read: a board in `companies.boards`
-- is `{platform, id}` and nothing else (job-search-archive#278).
--
-- `last_read` was written by the list phase on every board it read, every
-- run, so every company row was rewritten each morning. Nothing reads it:
-- the Gone criterion reads a posting's `gone_at` (20260927010000_gone_at)
-- and the list phase now writes `postings` only. `gone` is the older
-- two-run mark, which nothing has written or read since a gone board is
-- removed at once. Both keys are taken off every element; every other key
-- and the elements' order are kept.
--
-- Idempotent: a second run finds no row whose boards carry either key.

UPDATE "companies"
SET "boards" = (
  SELECT coalesce(jsonb_agg(b - 'last_read' - 'gone' ORDER BY position), '[]')
  FROM jsonb_array_elements("boards") WITH ORDINALITY AS element(b, position)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("boards") b
  WHERE b ? 'last_read' OR b ? 'gone'
);

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928040000_boards_last_read')
  ON CONFLICT DO NOTHING;
