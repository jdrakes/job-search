-- Migration 20260928000000_candidates: the table every name enters through
-- (job-search-archive#275).
--
-- A candidate carries two facts from two hands: what its input said (a
-- `name`, a `url` or both, the `origin` that suggested it and that origin's
-- `evidence`) and what discover made of it (`outcome`, `outcome_at`, and
-- the `company` the outcome names). `outcome` null is unresolved. `company`
-- is set when the outcome names a company: watched, added, known when a
-- company matched, alias, dropped. `wrong_company` is reserved for #276.
-- Until now a name the processor had not placed lived in `companies` as a
-- `discovered` or `alias` row, so `companies` held the input queue and the
-- watch list at once.
--
-- Backfill, once, while `candidates` is empty: one row per `companies` row.
-- Measured on the local store, 2026-09-27: 2,768 watched, 3,194 discovered
-- (0 with a board), 28 alias; 7 discovered and 2 alias companies own 139
-- postings between them. Each row keeps its name, its source as `origin`,
-- and its `first_seen` as both `added_at` and `outcome_at`:
--
--   state        outcome     company
--   watched      watched     the name
--   discovered   no_board    the name when the company owns a posting,
--                            else null
--   alias        alias       alias_of
--
-- The discovered names that own postings keep their name as `company`
-- because their company row has to stay: losing it would put their
-- postings back in.
--
-- `source` labels one site two ways, `builtin` (4,919 rows) and
-- `builtin.com` (187), so the backfill reads `builtin.com` as `builtin`,
-- and `companies.source` is rewritten the same way until a later migration
-- drops that column. A null source becomes the origin `unknown`.
--
-- The CHECK on `outcome` names only the vocabulary: a CHECK passes on null,
-- so an unresolved candidate needs no `IS NULL` arm.
--
-- Read-only to the browser, like `companies`: the processor writes with the
-- service key. Written idempotently, like every migration here.
-- `gen_random_uuid()` is core Postgres from 13 on.

CREATE TABLE IF NOT EXISTS "candidates" (
  "id" text PRIMARY KEY,
  "name" text,
  "url" text,
  "origin" text NOT NULL,
  "evidence" text,
  "added_at" timestamptz NOT NULL,
  "outcome" text CHECK ("outcome" IN ('watched', 'added', 'known', 'alias', 'no_board', 'wrong_company', 'gone', 'dropped', 'bad_url')),
  "outcome_at" timestamptz,
  "company" text,
  CHECK ("name" IS NOT NULL OR "url" IS NOT NULL)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "candidates") THEN
    INSERT INTO "candidates"
      ("id", "name", "url", "origin", "evidence", "added_at", "outcome", "outcome_at", "company")
    SELECT
      gen_random_uuid()::text,
      c."name",
      NULL,
      CASE c."source" WHEN 'builtin.com' THEN 'builtin' ELSE coalesce(c."source", 'unknown') END,
      NULL,
      c."first_seen",
      CASE c."state"
        WHEN 'watched' THEN 'watched'
        WHEN 'discovered' THEN 'no_board'
        WHEN 'alias' THEN 'alias'
      END,
      c."first_seen",
      CASE c."state"
        WHEN 'watched' THEN c."name"
        WHEN 'discovered' THEN
          CASE WHEN EXISTS (SELECT 1 FROM "postings" p WHERE p."company" = c."name")
            THEN c."name" END
        WHEN 'alias' THEN c."alias_of"
      END
    FROM "companies" c;
  END IF;
END $$;

UPDATE "companies" SET "source" = 'builtin' WHERE "source" = 'builtin.com';

ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "candidates";
CREATE POLICY "authenticated_read" ON "candidates" FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE "candidates" FROM authenticated;
GRANT SELECT ON TABLE "candidates" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928000000_candidates')
  ON CONFLICT DO NOTHING;
