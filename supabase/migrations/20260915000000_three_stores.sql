-- Migration 20260915000000_three_stores: `postings`, `companies` and
-- `criteria` for the rebuilt ingestion pipeline.
--
-- Hand-written; there is no schema generator in this rebuild yet, so
-- src/schema.ts is the one definition and this file is its SQL by hand.
-- tests/schema.test.ts reads this file's column lists back and pins them
-- equal to POSTING_FIELDS, COMPANY_FIELDS and CRITERIA_FIELDS so the two
-- cannot drift apart unnoticed.
--
-- Written idempotently: CREATE TABLE IF NOT EXISTS, and DROP POLICY IF
-- EXISTS before each CREATE POLICY since a policy has no IF NOT EXISTS.
-- `supabase db reset` replays this file once into an empty Postgres, so
-- idempotency here guards a second `db push` against the same project,
-- not a replay.
--
-- The old `criteria` table (20260912000003_criteria.sql) is dropped first
-- (Ruling 3 of the ingestion plan): it is the one name that collides with
-- the new schema, and its rows are backed up twice elsewhere. `postings`
-- and `companies` are new tables; nothing old shares their names, so
-- nothing else is dropped. Every other old table is untouched here; a
-- later migration retires them.
--
-- Every UPDATE grant is column-limited because a policy cannot name
-- columns: on `postings`, the operator's own status(status, applied_at,
-- status_at, note); on `companies`, state and reason (the operator's call on
-- a discovered company); on `criteria`, every column, since the operator
-- edits it whole. No
-- INSERT and no DELETE anywhere: ingestion and the processor write with the
-- service key, not the browser's `authenticated` role.

DROP TABLE IF EXISTS "criteria";

CREATE TABLE IF NOT EXISTS "postings" (
  "key" text PRIMARY KEY,
  "company" text NOT NULL,
  "platform" text CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon')),
  "board" text,
  "title" text,
  "url" text,
  "location" text,
  "comp_low" integer,
  "comp_high" integer,
  "posted_at" date,
  "first_seen" timestamptz NOT NULL,
  "last_seen" timestamptz NOT NULL,
  "live" boolean,
  "body" text,
  "kept" boolean,
  "reasons" jsonb NOT NULL DEFAULT '[]',
  "evidence" jsonb NOT NULL DEFAULT '{}',
  "judged_with" timestamptz,
  "status" text CHECK ("status" IN ('applied', 'interviewing', 'rejected', 'offer', 'closed')),
  "applied_at" date,
  "status_at" date,
  "note" text
);

ALTER TABLE "postings" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "postings";
CREATE POLICY "authenticated_read" ON "postings" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_write" ON "postings";
CREATE POLICY "authenticated_write" ON "postings" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "postings" FROM authenticated;
GRANT SELECT ON TABLE "postings" TO authenticated;
GRANT UPDATE ("status", "applied_at", "status_at", "note") ON TABLE "postings" TO authenticated;

CREATE TABLE IF NOT EXISTS "companies" (
  "name" text PRIMARY KEY,
  "state" text NOT NULL CHECK ("state" IN ('discovered', 'watched', 'dropped')),
  "boards" jsonb NOT NULL DEFAULT '[]',
  "source" text,
  "reason" text,
  "first_seen" timestamptz NOT NULL,
  "last_seen" timestamptz NOT NULL
);

ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "companies";
CREATE POLICY "authenticated_read" ON "companies" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_write" ON "companies";
CREATE POLICY "authenticated_write" ON "companies" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "companies" FROM authenticated;
GRANT SELECT ON TABLE "companies" TO authenticated;
GRANT UPDATE ("state", "reason") ON TABLE "companies" TO authenticated;

CREATE TABLE IF NOT EXISTS "criteria" (
  "id" integer PRIMARY KEY CHECK ("id" = 1),
  "level_words" jsonb NOT NULL DEFAULT '[]',
  "role_words" jsonb NOT NULL DEFAULT '[]',
  "excluded_title_words" jsonb NOT NULL DEFAULT '[]',
  "team_name_words" jsonb NOT NULL DEFAULT '[]',
  "excluded_states" jsonb NOT NULL DEFAULT '[]',
  "missing_languages" jsonb NOT NULL DEFAULT '[]',
  "comp_floor" integer NOT NULL,
  "updated_at" timestamptz NOT NULL
);

ALTER TABLE "criteria" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "criteria";
CREATE POLICY "authenticated_read" ON "criteria" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_write" ON "criteria";
CREATE POLICY "authenticated_write" ON "criteria" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "criteria" FROM authenticated;
GRANT SELECT ON TABLE "criteria" TO authenticated;
GRANT UPDATE ("id", "level_words", "role_words", "excluded_title_words", "team_name_words", "excluded_states", "missing_languages", "comp_floor", "updated_at") ON TABLE "criteria" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260915000000_three_stores');
