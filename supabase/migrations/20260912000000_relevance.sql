-- Migration 20260912000000_relevance: the `relevance` table — one row per
-- (job, criteria version) holding the tier the grader gave a listing and the
-- reasons that fired. A criteria change re-grades into rows for the new
-- version and the old version's rows stay, so "what did we miss?" is a diff
-- over stored rows rather than a refetch (Relevance build, 2026-09-12).
--
-- Hand-written, as every migration after the init is. The CREATE TABLE and
-- the two CREATE INDEX statements below are what the regenerated
-- db/schema.sql carries for `relevance`, copied verbatim; tests/schema.test.ts
-- pins the two equal, so `src/schema.ts` stays the one definition and this
-- file is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the table, its indexes, RLS
-- and the policy, so every statement here must be a no-op there (a policy has
-- no IF NOT EXISTS, hence the DROP first). Against the live project, still
-- holding the init as it was first applied, they are what actually add the
-- table.
--
-- No backfill: nothing has ever been graded under a criteria version, and
-- `relevance grade` fills the table from `jobs` once the grader lands.
-- `id` is the derived `<key>@<criteria_version>`, one primary-key column per
-- table as both store adapters expect; `key` and `criteria_version` are
-- indexed beside it because that is how the rows are read.

CREATE TABLE IF NOT EXISTS "relevance" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL,
  "criteria_version" text NOT NULL,
  "tier" text NOT NULL CHECK ("tier" IN ('out', 'weak', 'possible', 'strong')),
  "reasons" jsonb NOT NULL,
  "graded_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "relevance_key_idx" ON "relevance" ("key");
CREATE INDEX IF NOT EXISTS "relevance_version_idx" ON "relevance" ("criteria_version");

ALTER TABLE "relevance" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "relevance";
CREATE POLICY "authenticated_read" ON "relevance" FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE "relevance" FROM authenticated;
GRANT SELECT ON TABLE "relevance" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260912000000_relevance');
