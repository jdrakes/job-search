-- Migration 20260912000001_grade: a pipeline row carries a graded verdict —
-- `grade`, one of the three GRADES, and `grade_parts`, the levels behind it —
-- in place of the 0–100 `score` and its `score_parts`, and `events.verdict`
-- admits REGRADE, the recheck verb that replaces RESCORE (Decision build,
-- 2026-09-12).
--
-- Hand-written, as every migration after the init is. The two ADD COLUMN
-- definitions below are what the regenerated db/schema.sql carries for
-- `pipeline`, copied verbatim, and the verdict IN-list is the one its `events`
-- table declares; tests/schema.test.ts pins both equal, so `src/schema.ts`
-- stays the one definition and this file is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates `pipeline` with both new
-- columns and without the two old ones, and `events` with REGRADE in its
-- CHECK, so every statement here must be a no-op there. Against the live
-- project, still holding the init as it was first applied, they are what
-- actually add the columns, drop the old ones and widen the CHECK.
--
-- No data moves. `pipeline` is a projection of `events`: the old numbers stay
-- in the log's ADD and RESCORE events (and in data/export/events.jsonl), and
-- `project()` rebuilds every row from the log with `grade` null until
-- scripts/regrade-legacy.ts writes one REGRADE per open row. Applied only once
-- nothing reads the two dropped columns.
--
-- `events_verdict_check` is Postgres's own default name for the unnamed inline
-- CHECK the init migration wrote on that column — the same rule
-- 20260911000001_smartrecruiters.sql confirmed live for `jobs_platform_check`.
-- The list has not changed since first apply, so the live constraint is the
-- init's, and the DROP/ADD pair is what widens it. RESCORE stays in the list:
-- `events` is append-only and its historical RESCORE rows remain valid.

ALTER TABLE "pipeline" ADD COLUMN IF NOT EXISTS "grade" text CHECK ("grade" IN ('marginal', 'good', 'strong'));
ALTER TABLE "pipeline" ADD COLUMN IF NOT EXISTS "grade_parts" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "pipeline" DROP COLUMN IF EXISTS "score";
ALTER TABLE "pipeline" DROP COLUMN IF EXISTS "score_parts";

ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_verdict_check";
ALTER TABLE "events" ADD CONSTRAINT "events_verdict_check"
  CHECK ("verdict" IN ('ADD', 'REJECT', 'NEEDS_MORE', 'CLOSE', 'ACTIVATE', 'REGRADE', 'RESCORE', 'KEEP', 'CONFIRM', 'REVERT', 'EDIT', 'DEFER'));

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260912000001_grade');
