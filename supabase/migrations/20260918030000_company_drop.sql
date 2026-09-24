-- Migration 20260918030000_company_drop: a company's drop is the operator's
-- column, its state is the processor's. `companies.state` held both
-- facts, so publish upserted companies whole and wrote the processor's
-- `watched` over a drop the operator made while the run was listing: Ferrous
-- Motors, dropped at ~12:17 on 2026-09-18 during a run that had pulled at
-- 12:10:51, was `watched` again by that run's 12:35 publish, and the 14:13
-- pull found `0 company states` to bring down. The drop moves to
-- `dropped_at` and `reason`, which only the operator writes; the processor's
-- `state` gains `alias` for a name whose board another company owns, with
-- the owner in `alias_of`, so the three states are all the processor's.
--
-- Data: the 18 `dropped` rows whose reason begins "alias of" become
-- `alias`, their owner parsed out of the reason and the reason cleared;
-- Propelio (and Ferrous Motors, if a store holds it dropped) keep
-- the drop as `dropped_at` + reason; Propelio also loses `ashby/propelio`,
-- which is Propelio's own board; Courier returns to `watched` with its reason
-- cleared, since `boardGone` now handles its 404'd board. The DO block
-- names any `dropped` row the moves did not cover, so an unexpected row
-- stops the migration by name rather than on the constraint.
--
-- The CHECK's name, `companies_state_check`, is Postgres's default for the
-- inline CHECK in 20260915000000_three_stores.sql, confirmed on the local
-- store via pg_constraint on 2026-09-18. The old CHECK goes before the data
-- moves, since it refuses 'alias'; the new one comes after the guard, since
-- it refuses 'dropped'. Written idempotently, like every migration here.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "dropped_at" timestamptz;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "alias_of" text;

ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_state_check";

UPDATE "companies"
SET "state" = 'alias',
    "alias_of" = trim(substring("reason" from '^alias of ([^(]+)')),
    "reason" = NULL
WHERE "state" = 'dropped' AND "reason" LIKE 'alias of %';

-- The owner row is itself named "Meridian Partners ( https://meridianpartners.example )";
-- its parenthesis is what the regex above reads as the terminator, so the
-- general rule wrote the alias row's own name into alias_of. The other 17
-- owners have no parenthesis in their name and are unaffected.
UPDATE "companies"
SET "alias_of" = 'Meridian Partners ( https://meridianpartners.example )'
WHERE "name" = 'Meridian Partners' AND "state" = 'alias';

UPDATE "companies"
SET "state" = 'watched', "dropped_at" = now()
WHERE "state" = 'dropped'
  AND "name" IN ('Propelio', 'Ferrous Motors')
  AND "dropped_at" IS NULL;

UPDATE "companies"
SET "boards" = (
  SELECT coalesce(jsonb_agg(b), '[]')
  FROM jsonb_array_elements("boards") b
  WHERE NOT (b->>'platform' = 'ashby' AND b->>'id' = 'propelio')
)
WHERE "name" = 'Propelio';

UPDATE "companies"
SET "state" = 'watched', "reason" = NULL
WHERE "state" = 'dropped' AND "name" = 'Courier';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "companies" WHERE "state" = 'dropped') THEN
    RAISE EXCEPTION 'companies still carry state=dropped: %',
      (SELECT string_agg("name", ', ') FROM "companies" WHERE "state" = 'dropped');
  END IF;
END $$;

ALTER TABLE "companies" ADD CONSTRAINT "companies_state_check"
  CHECK ("state" IN ('discovered', 'watched', 'alias'));

-- The list may drop a company and give its reason; the processor alone
-- writes `state`.
REVOKE UPDATE ("state", "reason") ON TABLE "companies" FROM authenticated;
GRANT UPDATE ("dropped_at", "reason") ON TABLE "companies" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260918030000_company_drop');
