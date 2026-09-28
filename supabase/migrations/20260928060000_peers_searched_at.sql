-- Migration 20260928060000_peers_searched_at: a company's third fact,
-- written by peer expansion (job-search-archive#281).
--
-- Peer research seeds from companies James applied to and must never repeat
-- a seed it has already searched. `peers_searched_at` null marks a seed
-- unsearched; `scripts/peers.ts` (job-search-archive#281, Task 2) sets it to
-- `now()` on every seed it records a run for, through the same column grant
-- that already lets the list write a company's drop (`dropped_at`,
-- `reason`, 20260918030000_company_drop) and the same RLS policy
-- (`authenticated_write`, 20260915000000_three_stores) that already allows
-- an authenticated UPDATE of any company row. The run itself never sets
-- this column: `src/discover.ts` writes a fresh company's `reason` and
-- `dropped_at` as null the same way, and `peers_searched_at` follows that
-- precedent rather than a new one.
--
-- Idempotent, like every migration here: `IF NOT EXISTS` on the column, and
-- GRANT re-states a privilege rather than accumulating it.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "peers_searched_at" timestamptz;

GRANT UPDATE ("peers_searched_at") ON TABLE "companies" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928060000_peers_searched_at')
  ON CONFLICT DO NOTHING;
