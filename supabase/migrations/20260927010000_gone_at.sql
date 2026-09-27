-- Migration 20260927010000_gone_at: `postings.gone_at` replaces
-- `postings.last_seen` (job-search-archive#274).
--
-- `gone_at` is null while a board's latest successful read lists the
-- posting, set to that read's time the first time one does not, and cleared
-- the first time one lists it again. A posting that is neither new, changed,
-- gone nor returned no longer needs `last_seen = now` rewritten on it every
-- run: measured 2026-09-27, about 116,000 rows a weekday, an estimated
-- 214 MB of the file left as dead tuples.
--
-- Backfill: a row gone today under the old rule (`last_seen` before its
-- board's `last_read`) gets that `last_read` as its `gone_at`, so no
-- posting's Gone verdict flips when this ships. The board is matched the
-- way the old rule matched it (`boardIndex`, src/judge/listing.ts): by
-- platform and board id, among watched companies not dropped, whose
-- `boards` jsonb elements carry `platform`, `id` and `last_read` (`Board`,
-- src/schema.ts).
--
-- Dropped, all unread: `postings.last_seen` (read only by the old Gone
-- rule), `postings.live` (NULL on every row), `companies.last_seen`.
--
-- Written idempotently, like every migration here: once `last_seen` is gone
-- a re-run cannot reach the backfill's column, so the backfill runs only
-- while it exists.

ALTER TABLE "postings" ADD COLUMN IF NOT EXISTS "gone_at" timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'postings' AND column_name = 'last_seen'
  ) THEN
    UPDATE "postings" p
    SET "gone_at" = b.last_read
    FROM (
      SELECT board->>'platform' AS platform, board->>'id' AS board,
             (board->>'last_read')::timestamptz AS last_read
      FROM "companies" c, jsonb_array_elements(c.boards) AS board
      WHERE c.state = 'watched' AND c.dropped_at IS NULL
        AND board->>'last_read' IS NOT NULL
    ) b
    WHERE p.platform = b.platform AND p.board = b.board
      AND p.last_seen < b.last_read
      AND p.gone_at IS NULL;
  END IF;
END $$;

ALTER TABLE "postings" DROP COLUMN IF EXISTS "last_seen";
ALTER TABLE "postings" DROP COLUMN IF EXISTS "live";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "last_seen";

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260927010000_gone_at');
