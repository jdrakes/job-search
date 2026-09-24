-- Migration 20260916000000_body_hash: `postings.body_hash`, the md5 of the
-- stored body, so a re-list can tell an unchanged body from an edited one
-- without reading the body back.
--
-- Why. Greenhouse, Ashby, Lever and Amazon listings carry the body, so
-- every run upserted ~80,000 rows × ~5.5 KB of body that had not changed:
-- measured 2026-09-16, listing spent 2,465 s in 1,892 upserts and lost three
-- chunks to 57014. With the hash, `ingest` writes `body` only for a new
-- posting or one whose listing body hashes differently.
--
-- Not backfilled here: an UPDATE over every body is a long statement for
-- no gain — stored rows start null, so the first run after this writes
-- each body once more (as every run did) and sets the hash; the next run
-- is the first cheap one.
--
-- Written idempotently, like every migration here.

ALTER TABLE "postings" ADD COLUMN IF NOT EXISTS "body_hash" text;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260916000000_body_hash');
