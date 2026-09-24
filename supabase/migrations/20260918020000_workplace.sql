-- Migration 20260918020000_workplace: `postings.workplace`, the board's own
-- word for where the posting is (Ashby and Lever state it directly; null
-- elsewhere), so the remote criterion can read it instead of the body text.
--
-- Measured 2026-09-17 on 463 Ashby/Lever postings judged that morning: the
-- text path rejected 47 of 118 the board called remote and admitted 0 of 88
-- it called on-site.
--
-- No backfill: every stored row starts null, and the first run after this
-- re-judges every Ashby/Lever row once, the same way a changed comp_high
-- already does.
--
-- Written idempotently, like every migration here.

ALTER TABLE "postings" ADD COLUMN IF NOT EXISTS "workplace" text;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260918020000_workplace');
