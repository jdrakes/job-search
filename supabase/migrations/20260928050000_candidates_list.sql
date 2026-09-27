-- Migration 20260928050000_candidates_list: the list may add a candidate
-- (job-search-archive#280).
--
-- With one store, the list and the run write the same `candidates` row: the
-- input columns (`name`, `url`, `origin`, `evidence`) are written by whoever
-- suggested the name, and the outcome columns (`outcome`, `outcome_at`,
-- `company`) by the run's discover phase alone. Until now only the run wrote
-- the table, with the service key; this opens the list's first INSERT.
--
-- Defaults, so the list sends only the input columns: `id` defaults to a
-- random UUID in text, the same shape discover's `randomUUID()` writes, and
-- `added_at` to the time of the insert, so the browser's clock never dates a
-- row. The run still sets both itself; a default applies only when a column
-- is left out.
--
-- Two limits, one per mechanism, because a column privilege cannot inspect
-- a value and a policy cannot name columns (the same split as
-- 20260912000004_jobs_manual_insert). The column privilege names the four
-- input columns and no other, so `id`, `added_at` and the outcome columns
-- take their defaults (null for the outcome) and stay the run's to write.
-- The policy's WITH CHECK pins the row: an origin of 'james' or 'peers',
-- the two hands that add from the list, and no outcome. The `outcome IS
-- NULL` arm repeats what the column privilege already enforces, so a later
-- grant that widens the columns cannot let the browser resolve a candidate.
-- No UPDATE and no DELETE: a candidate's input is fixed once added, and its
-- outcome is discover's.
--
-- Idempotent: SET DEFAULT and GRANT re-state rather than accumulate, and a
-- policy has no IF NOT EXISTS, hence the DROP first.

ALTER TABLE "candidates" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
ALTER TABLE "candidates" ALTER COLUMN "added_at" SET DEFAULT now();

GRANT INSERT ("name", "url", "origin", "evidence") ON TABLE "candidates" TO authenticated;

DROP POLICY IF EXISTS "authenticated_add" ON "candidates";
CREATE POLICY "authenticated_add" ON "candidates" FOR INSERT TO authenticated
  WITH CHECK ("origin" IN ('james', 'peers') AND "outcome" IS NULL);

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928050000_candidates_list')
  ON CONFLICT DO NOTHING;
