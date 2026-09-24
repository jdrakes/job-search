-- Migration 20260918010000_criteria_assumed_bonus: `criteria.assumed_bonus_pct`,
-- the percentage target bonus to assume when a posting names a bonus but
-- gives no rate.
--
-- Null means the bonus is not counted; when stated, the text criterion caps
-- a stated target at 50% (Ruling 2 of the bonus plan).
--
-- The GRANT is required: the three_stores migration limits the
-- `authenticated` role's UPDATE to named columns, so without it the
-- Criteria view cannot save the new field. Written idempotently, like every
-- migration here.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "assumed_bonus_pct" integer;

GRANT UPDATE ("assumed_bonus_pct") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260918010000_criteria_assumed_bonus');
