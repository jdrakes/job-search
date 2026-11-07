-- Migration 20261107000000_criteria_work_words: `criteria.work_words`, the
-- words that say a title names the operator's kind of work. Until now they
-- were two lists in src/judge/listing.ts, which only engineering could pass.
--
-- The default is those two lists joined, so an existing row judges as it did:
-- the two words only the role rule held (architect, technical staff) reach the
-- level rule only for a row whose level words do not admit them first.
--
-- The GRANT is required: the three_stores migration limits the `authenticated`
-- role's UPDATE to named columns, so without it the Criteria view cannot save
-- the new field. Written idempotently, like every migration here.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "work_words" jsonb NOT NULL
  DEFAULT '["engineer", "engineering", "developer", "swe", "programmer", "architect", "technical staff"]';

GRANT UPDATE ("work_words") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20261107000000_criteria_work_words');
