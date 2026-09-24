-- Migration 20260911000000_jobs: the `jobs` table — one row per posting ever
-- fetched, upserted on every sighting — backfilled from the historical `seen`
-- events so `first_seen` for every key ever fetched survives the switch.
--
-- Hand-written, as every migration after the init is. The CREATE TABLE below
-- is the statement the regenerated db/schema.sql carries for `jobs`, copied
-- verbatim; tests/schema.test.ts pins the two equal, so `src/schema.ts` stays
-- the one definition and this file is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the table, its index, RLS and
-- the policy, so every statement here must be a no-op there (a policy has no
-- IF NOT EXISTS, hence the DROP first). Against the live project, still holding
-- the init as it was first applied, they are what actually add the table.
--
-- The backfill reads only `seen` events, which carry key, run, time and stage
-- and nothing else (`row` is null on a sighting), so a backfilled row holds
-- provenance and timing and null listing fields until the next sighting fills
-- them in. `ON CONFLICT DO NOTHING` makes it re-runnable and keeps a row a run
-- has already written ahead of the history. Historical `seen` rows are never
-- deleted: `events` is append-only (CLAUDE.md), and readers that want only
-- decisions filter on `kind`.

CREATE TABLE IF NOT EXISTS "jobs" (
  "key" text PRIMARY KEY,
  "company" text NOT NULL,
  "platform" text CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold')),
  "board" text,
  "source" text,
  "title" text,
  "url" text,
  "location" text,
  "geo" text CHECK ("geo" IN ('us-remote', 'non-us', 'office-anchored', 'unknown')),
  "comp_low" integer,
  "comp_high" integer,
  "updated" text,
  "first_seen" timestamptz NOT NULL,
  "last_seen" timestamptz NOT NULL,
  "last_run_id" text,
  "last_stage" text CHECK ("last_stage" IN ('silenced', 'in_pipeline', 'employer_ruled_out', 'non_us', 'below_floor', 'title', 'candidate'))
);

CREATE INDEX IF NOT EXISTS "jobs_last_seen_idx" ON "jobs" ("last_seen");

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "jobs";
CREATE POLICY "authenticated_read" ON "jobs" FOR SELECT TO authenticated USING (true);

REVOKE ALL ON TABLE "jobs" FROM authenticated;
GRANT SELECT ON TABLE "jobs" TO authenticated;

INSERT INTO "jobs" ("key", "company", "first_seen", "last_seen", "last_run_id", "last_stage")
SELECT
  "key",
  split_part("key", '::', 1),
  min("at"),
  max("at"),
  (array_agg("run_id" ORDER BY "at" DESC))[1],
  (array_agg("stage" ORDER BY "at" DESC))[1]
FROM "events"
WHERE "kind" = 'seen'
GROUP BY "key"
ON CONFLICT ("key") DO NOTHING;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260911000000_jobs');
