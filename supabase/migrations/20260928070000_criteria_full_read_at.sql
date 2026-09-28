-- Migration 20260928070000_criteria_full_read_at: the first run-owned
-- column on `criteria`.
--
-- A criteria edit changes which postings pass, but a board that neither
-- produces nor was bound this week is otherwise read only on Monday, so the
-- edit could wait up to six days to reach it. `full_read_at` records the
-- `updated_at` of the criteria row that the last read of every board was
-- made for. While it is null or older than `updated_at`, the daily run reads
-- every board (`boardsToRead`, src/ingest.ts), then sets it to
-- `updated_at`. One global timestamp the run reads back each day, not
-- per-board state (the per-board `last_read` that
-- 20260928040000_boards_last_read removed had no reader).
--
-- The deliberate exception: 20260915000000_three_stores granted
-- `authenticated` UPDATE on every `criteria` column "since the operator
-- edits it whole". This column is written only by the run, which connects
-- with the service key and needs no grant, so it is NOT added to that
-- UPDATE list. `authenticated` keeps its table-wide SELECT, so the Criteria
-- view can read it but never write it. The same operator/run split as
-- `companies.peers_searched_at` beside `dropped_at` and `reason`. Ruled in
-- the approved plan "Criteria-driven full board read" (A design conflict).
--
-- Idempotent, like every migration here: `IF NOT EXISTS` on the column.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "full_read_at" timestamptz;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928070000_criteria_full_read_at')
  ON CONFLICT DO NOTHING;
