-- Migration 20260915030000_record_index: the index the Record reads through.
--
-- Measured 2026-09-15. The Record read became `kept IS TRUE OR status IS
-- NOT NULL` (what the operator acted on shows whatever the processor now
-- says),
-- which `postings_queue_idx` (partial on `kept AND status IS NULL`)
-- cannot serve, so it is a sequential scan over the table's ~300 MB of
-- bodies: 7.5–8.4 s whenever the pages have left the cache, which they do
-- between two visits a few minutes apart; 0.3–0.8 s when they have not.
-- The queue read, indexed, was 1.4 s cold on the same visit.
--
-- Partial on the Record's own predicate, as the queue's is on the queue's:
-- 177 rows of 85,455 today, and it stays that size as the table grows.
-- Idempotent like the rest: IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS "postings_record_idx" ON "postings" ("key")
  WHERE "kept" IS TRUE OR "status" IS NOT NULL;

INSERT INTO "schema_migrations" ("id") VALUES ('20260915030000_record_index');
