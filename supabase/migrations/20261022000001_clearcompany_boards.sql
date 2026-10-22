-- Migration 20261022000001_clearcompany_boards: HRMDirect's sites now
-- redirect to ClearCompany (see 20261022000000_clearcompany_platform), so
-- the stored state follows.
--
-- 1. Every `companies.boards` element (jsonb `[{"id","platform"}]`, plus
--    `last_read` where the run has set it) with platform `hrmdirect` becomes
--    `clearcompany` with the same id and its other fields kept. Three are
--    dropped instead: `tuvoli` (the same site as flexjet), `pearson`
--    ("Pearson Tire", not the publisher) and `starbucks` ("Starbucks - Org
--    Test ADP", a test tenant).
-- 2. Postings with platform `hrmdirect` that are still live get
--    `gone_at = now()`. Their keys are not moved: ClearCompany ids are
--    UUIDs, so the same jobs arrive under new keys and the old rows retire.
-- 3. A DO block raises if either is incomplete, which rolls the file back.
--
-- Hand-written and idempotent: a second run finds no `hrmdirect` element and
-- no live `hrmdirect` posting, so it changes nothing. Apply after
-- 20261022000000_clearcompany_platform.

UPDATE "companies"
SET "boards" = (
  SELECT coalesce(jsonb_agg(
    CASE WHEN b->>'platform' = 'hrmdirect'
      THEN jsonb_set(b, '{platform}', '"clearcompany"')
      ELSE b
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements("boards") b
  WHERE NOT (b->>'platform' = 'hrmdirect' AND b->>'id' IN ('tuvoli', 'pearson', 'starbucks'))
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("boards") b WHERE b->>'platform' = 'hrmdirect'
);

UPDATE "postings"
SET "gone_at" = now()
WHERE "platform" = 'hrmdirect' AND "gone_at" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "companies", jsonb_array_elements("boards") b
    WHERE b->>'platform' = 'hrmdirect'
  ) THEN
    RAISE EXCEPTION 'a company board still says hrmdirect';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "postings" WHERE "platform" = 'hrmdirect' AND "gone_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'an hrmdirect posting still has gone_at null';
  END IF;
END $$;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20261022000001_clearcompany_boards')
  ON CONFLICT DO NOTHING;
