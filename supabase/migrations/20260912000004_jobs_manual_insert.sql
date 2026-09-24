-- Migration 20260912000004_jobs_manual_insert: the browser may add a job by
-- hand (hand-add build, 2026-09-12; architecture Ruling 7 — a job added by
-- hand enters `jobs` with provenance recorded as manual and is graded and
-- decided by the same path as everything else).
--
-- Hand-written, as every migration after the init is. The policy and the
-- grants below are what the regenerated db/schema.sql carries for `jobs`,
-- copied verbatim; tests/schema.test.ts pins them equal, so `src/schema.ts`
-- (`MANUAL_SOURCE`, `JOBS_UI_WRITABLE`) stays the one definition and this
-- file is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the policy and the grant, so
-- every statement here must be a no-op there (a policy has no IF NOT EXISTS,
-- hence the DROP first; the REVOKE/GRANT trio re-states rather than
-- accumulates). Against the live project, still holding the init as it was
-- first applied, they are what actually open the write.
--
-- Two limits, one per mechanism, because a policy cannot name columns and a
-- column privilege cannot inspect a value. The policy's WITH CHECK pins
-- provenance: the browser can insert a job whose `source` is 'manual' and no
-- other, so it can never claim a job came from a board it did not fetch. The
-- column privilege names the form's fields and no other: `platform`, `board`,
-- `geo`, `updated`, `last_run_id` and `last_stage` stay the run's to stamp
-- when it first sees the job. No UPDATE and no DELETE: a job row is the
-- engine's record of a sighting, and a hand-added one is closed from the
-- card like any other, through a `decide` event.

DROP POLICY IF EXISTS "authenticated_write" ON "jobs";
CREATE POLICY "authenticated_write" ON "jobs" FOR INSERT TO authenticated WITH CHECK ("source" = 'manual');

REVOKE ALL ON TABLE "jobs" FROM authenticated;
GRANT SELECT ON TABLE "jobs" TO authenticated;
GRANT INSERT ("key", "company", "source", "title", "url", "location", "comp_low", "comp_high", "first_seen", "last_seen") ON TABLE "jobs" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260912000004_jobs_manual_insert');
