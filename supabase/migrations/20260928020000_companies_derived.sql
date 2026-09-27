-- Migration 20260928020000_companies_derived: `companies` keeps a name, its
-- boards and the operator's drop (job-search-archive#275).
--
-- A company now carries what nothing else can say: its name, its boards
-- (which discover writes) and whether the operator dropped it, with the
-- reason. Everything else said of a company is derived: it is read when it
-- is not dropped and has a board; where it came from and its aliases are in
-- `candidates` (the candidates migration copied every row there). So
-- `state`, `source`, `first_seen` and `alias_of` go, and with `state` the
-- rows that were only ever input: a `discovered` or `alias` row that owns
-- no posting.
--
-- Measured on the local store, 2026-09-27: 2,768 watched, 3,194 discovered,
-- 28 alias. 7 discovered and 2 alias rows own postings, so this deletes
-- 3,187 + 26 = 3,213 rows and keeps 2,777. The 9 that own postings stay,
-- with no board, so their postings stay out under Unwatched ("has no
-- board"). A watched row is never deleted, board or not.
--
-- The 2 kept alias rows are the exception to "with no board": each still
-- carries the board it was found on, which is another company's. Before
-- this migration `state = 'alias'` kept them from being read; once `state`
-- is gone, a row with a board is read, so those boards would be read a
-- second time under the alias's name. So their boards are emptied here,
-- while `state` can still pick them out, and they stay like the other 7:
-- kept, never read.
--
-- There is no way back from here but a `pg_dump -t companies` taken before
-- this is applied: the deleted rows and the dropped columns are not kept
-- anywhere else in this shape.
--
-- Idempotent, like every migration here: once `state` is gone a re-run
-- cannot reach it, so the delete and the alias boards reset run only while
-- the column exists.
-- Dropping `state` drops its CHECK with it.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'state'
  ) THEN
    DELETE FROM "companies" c
    WHERE c."state" IN ('discovered', 'alias')
      AND NOT EXISTS (SELECT 1 FROM "postings" p WHERE p."company" = c."name");

    UPDATE "companies" SET "boards" = '[]'
    WHERE "state" = 'alias';
  END IF;
END $$;

ALTER TABLE "companies" DROP COLUMN IF EXISTS "state";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "source";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "first_seen";
ALTER TABLE "companies" DROP COLUMN IF EXISTS "alias_of";

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928020000_companies_derived')
  ON CONFLICT DO NOTHING;
