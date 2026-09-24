-- Migration 20260915010000_posting_indexes: the two indexes the daily run
-- and the queue read through.
--
-- Measured 2026-09-15. A run at 1,665 watched companies died on
-- `GET postings?company=eq.Umbra` with Postgres 57014, "canceling statement
-- due to statement timeout". `ingest` reads a company's existing postings
-- once per company to recover `first_seen`, so that query runs once per
-- watched company — 163 times when the table held 18,939 rows, and 1,665
-- times once it held 44,467. With no index each of those is a sequential
-- scan over roughly 300 MB, because a posting's row carries its body.
--
-- The second index is the queue's own filter: the list opens on
-- `kept=is.true&status=is.null` and that is the query the operator waits on.
-- Partial, because it is the only combination the queue ever asks for and a
-- partial index stays small as the table grows.
--
-- Written idempotently, like every migration here: IF NOT EXISTS on both,
-- so a `db reset` that replays this file after the init is a no-op.

CREATE INDEX IF NOT EXISTS "postings_company_idx" ON "postings" ("company");

CREATE INDEX IF NOT EXISTS "postings_queue_idx" ON "postings" ("kept", "status")
  WHERE "kept" IS TRUE AND "status" IS NULL;

INSERT INTO "schema_migrations" ("id") VALUES ('20260915010000_posting_indexes');
