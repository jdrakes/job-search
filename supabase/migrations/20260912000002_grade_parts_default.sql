-- Migration 20260912000002_grade_parts_default: `pipeline.grade_parts`
-- defaults to the ungraded shape — every level null, no domain avoided —
-- instead of `{}`, and every row still holding `{}` is moved to it.
--
-- Hand-written, as every migration after the init is. The default literal
-- below is `UNGRADED_PARTS` (src/schema.ts) serialised, exactly what the
-- regenerated db/schema.sql carries for the column; tests/schema.test.ts pins
-- the two equal, so `src/schema.ts` stays the one definition and this file is
-- a snapshot of it at one moment.
--
-- Why. 20260912000001_grade added the column with DEFAULT '{}', so the 166
-- Closed rows that scripts/regrade-legacy.ts left alone hold `{}`, while
-- `project()` gives an ungraded row `newRow`'s `UNGRADED_PARTS`. The restore
-- drill (scripts/restore-drill.ts) compares the exported table against the
-- projection by content, so those rows fail it and .github/workflows/export.yml
-- commits no backup. Reviewer finding 1, Decision build, 2026-09-12.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already declares the new default and holds
-- no rows, so SET DEFAULT re-states what is there and the UPDATE matches
-- nothing. Against the live project both do the work. Rows are matched on
-- the jsonb value, so a row already moved is not touched again.

ALTER TABLE "pipeline" ALTER COLUMN "grade_parts" SET DEFAULT '{"comp":null,"stack":null,"domain_avoid":false,"comp_why":null}'::jsonb;

UPDATE "pipeline"
SET "grade_parts" = '{"comp":null,"stack":null,"domain_avoid":false,"comp_why":null}'::jsonb
WHERE "grade_parts" = '{}'::jsonb;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260912000002_grade_parts_default');
