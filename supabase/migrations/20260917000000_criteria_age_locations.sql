-- Migration 20260917000000_criteria_age_locations: `criteria.max_age_days` and
-- `criteria.excluded_locations`, the age filter and the city exclusion list.
--
-- The GRANT is required: the three_stores migration limits the `authenticated`
-- role's UPDATE to named columns, so without it the Criteria view cannot save
-- the new fields. Written idempotently, like every migration here.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "max_age_days" integer;
ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "excluded_locations" jsonb NOT NULL DEFAULT '[]';

GRANT UPDATE ("max_age_days", "excluded_locations") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260917000000_criteria_age_locations');
