-- Migration 20260915020000_first_seen_default: `postings.first_seen`
-- defaults to now(), so a row can be written without naming it.
--
-- Hand-written, as every migration after the init is.
--
-- Why. `ingest` read every stored posting of a company back
-- (`GET postings?company=eq.<X>`, once per watched company) for one reason:
-- to carry `first_seen` forward on a re-list, since a payload that omits a
-- column would otherwise insert a default. Measured on the live store
-- 2026-09-15: 61,180 postings averaging 6,764 bytes, 5,567 of it body, so
-- one company's postings came back as 2.6 MB in 1,773 ms — and two runs died
-- on that query with Postgres 57014, "canceling statement due to statement
-- timeout". The same query asking only for `key,first_seen` took 269 ms.
--
-- PostgREST's `resolution=merge-duplicates` writes only the columns the
-- payload names, so omitting `first_seen` already keeps the stored value on
-- an update — it is the INSERT path that refuses, because Postgres builds a
-- whole tuple and the column is NOT NULL with no default. Confirmed against
-- the live store 2026-09-15: a payload without `first_seen` returns 400.
-- now() is precisely what ingestion wrote there anyway — the moment the row
-- was first inserted — so the default says the same thing the read did,
-- without the read.
--
-- Written idempotently, like every migration here: SET DEFAULT re-states the
-- same default when replayed, so a `supabase db reset` that runs this after
-- 20260915000000_three_stores is a no-op beyond the receipt below.

ALTER TABLE "postings" ALTER COLUMN "first_seen" SET DEFAULT now();

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260915020000_first_seen_default');
