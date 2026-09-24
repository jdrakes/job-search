-- Migration 20260915040000_retire_previous_tables: drop the eight tables the
-- previous tool used.
--
-- The rebuilt system stores three things — `postings`, `companies` and
-- `criteria` — and reads none of these. They have sat unread since the reset
-- and were left in place deliberately at the time: dropping ten live
-- tables overnight bought nothing, and `employers` was read once to seed the
-- registry.
--
-- What was carried across first, so this is not a loss of the operator's own
-- record: 20 of the 27 postings the operator had acted on now carry their
-- status, applied_at and status_at in `postings`. Two ports did it — one
-- matching on key, one matching on URL, which is what caught the nine rows
-- whose keys are synthetic Notion-migration ids (`Roostr::legacy-fcd7a3d08f8f`
-- rather than `Roostr::7064897`). The remaining 7 are applications to reqs
-- that have since closed, so no posting exists to attach them to; they stay
-- in the operator's separate backup repository.
--
-- What the backup does NOT hold, checked before writing this: 25,524 `seen`
-- events (the old export filtered to decision events, that tool having
-- replaced sighting-events with the `jobs` table precisely because one run
-- appended 9,006 of them) and 478 `worklist` rows (per-run posting bodies
-- that the old tool deleted after each run by design). Both omissions are
-- that tool's own judgment about what counted as record, and this follows it
-- rather than second-guessing it.
--
-- Irreversible against the live project. Idempotent so a `db reset` replay
-- is a no-op: every table here is created by earlier migrations in this same
-- directory, so the drops run after those creates and leave the same state.

DROP TABLE IF EXISTS "worklist";
DROP TABLE IF EXISTS "relevance";
DROP TABLE IF EXISTS "pipeline";
DROP TABLE IF EXISTS "events";
DROP TABLE IF EXISTS "jobs";
DROP TABLE IF EXISTS "runs";
DROP TABLE IF EXISTS "employers";
DROP TABLE IF EXISTS "discoveries";

INSERT INTO "schema_migrations" ("id") VALUES ('20260915040000_retire_previous_tables');
