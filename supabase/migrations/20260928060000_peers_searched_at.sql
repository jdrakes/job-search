-- Migration 20260928060000_peers_searched_at: a company's third fact,
-- written by peer expansion (job-search-archive#281).
--
-- Peer research seeds from companies James applied to and must never repeat
-- a seed it has already searched. `peers_searched_at` null marks a seed
-- unsearched; `scripts/peers.ts` (job-search-archive#281, Task 2) sets it to
-- `now()` on every seed it records a run for. The script connects as the
-- run does, not as `authenticated`, so it needs no grant here. The GRANT
-- below is the list's: it lets `authenticated` set or clear the column, as
-- it may a company's drop (`dropped_at`, `reason`,
-- 20260918030000_company_drop), under the RLS policy that already allows an
-- authenticated UPDATE of any company row (`authenticated_write`,
-- 20260915000000_three_stores). The run never writes this column:
-- `src/discover.ts` writes a new company's `name` and `boards` only, so the
-- column's null default fills it, and changes an existing company's
-- `boards` alone.
--
-- Idempotent, like every migration here: `IF NOT EXISTS` on the column, and
-- GRANT re-states a privilege rather than accumulating it.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "peers_searched_at" timestamptz;

GRANT UPDATE ("peers_searched_at") ON TABLE "companies" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260928060000_peers_searched_at')
  ON CONFLICT DO NOTHING;
