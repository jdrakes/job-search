-- Migration 20261107000001_criteria_office_locations:
-- `criteria.office_locations`, places the operator can go to an office. A
-- posting whose location names one passes the remote criterion, whatever its
-- workplace. The empty default keeps an existing row remote only.
--
-- The GRANT is required: the three_stores migration limits the `authenticated`
-- role's UPDATE to named columns, so without it the Criteria view cannot save
-- the new field. Written idempotently, like every migration here.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "office_locations" jsonb NOT NULL DEFAULT '[]';

GRANT UPDATE ("office_locations") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20261107000001_criteria_office_locations');
