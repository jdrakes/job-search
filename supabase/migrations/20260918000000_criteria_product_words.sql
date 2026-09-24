-- Migration 20260918000000_criteria_product_words: `criteria.product_words`,
-- the list of words whose presence in a title names product work for the
-- score's shape term.
--
-- The GRANT is required: the three_stores migration limits the
-- `authenticated` role's UPDATE to named columns, so without it the
-- Criteria view cannot save the new field. Written idempotently, like every
-- migration here.

ALTER TABLE "criteria" ADD COLUMN IF NOT EXISTS "product_words" jsonb NOT NULL DEFAULT '[]';

GRANT UPDATE ("product_words") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260918000000_criteria_product_words');
