-- Migration 20260914000000_discoveries: the `discoveries` table — one row per
-- company discovery has ever seen — and the two writes the Companies view
-- makes from the browser (discovery build, 2026-09-13: the top of the funnel
-- runs every weekday, is recorded, and grows the watchlist on its own).
--
-- Hand-written, as every migration after the init is. The CREATE TABLE, the
-- policies and the grants below are what the regenerated db/schema.sql
-- carries for `discoveries` and `employers`, copied verbatim; tests/
-- schema.test.ts pins them equal, so `src/schema.ts` (`Discovery`,
-- `DISCOVERIES_UI_WRITABLE`, `EMPLOYERS_UI_WRITABLE`) stays the one
-- definition and this file is a snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already creates the table, its RLS, both
-- policies and both grants, so every statement here must be a no-op there (a
-- policy has no IF NOT EXISTS, hence the DROP before each; the REVOKE/GRANT
-- groups re-state rather than accumulate). Against the live project, still
-- holding the init as it was first applied, they are what actually add them.
--
-- Two UPDATE grants, each column-limited, because a policy cannot name
-- columns. On `discoveries` the browser may flip `status` with a `reason`
-- and a `decided_at` — Reject in the Companies view — and nothing else:
-- `boards` is attached only from the Greenhouse verifier's result, and the
-- sighting counts are the run's to stamp. On `employers` the browser may
-- write `disqualified` — Drop in the Companies view, the one concept for
-- "the operator ruled this employer out" that the run already honours — and
-- no other column. No INSERT on either table and no DELETE anywhere: a
-- company
-- joins the watchlist only through `discover` (a board the ATS itself
-- confirmed) or `board add` (an identity a person supplied), both held with
-- the secret key.
--
-- No backfill and no index. The table starts empty and `discover` fills it;
-- 148 employers came from two hand-run passes (measured 2026-09-13), so it
-- is hundreds of rows read whole by one view.
--
-- `probed_at` (branch review, 2026-09-14) is the day the Greenhouse verifier
-- was asked about the company, hit or miss, null until it has been: a
-- company is probed once, so the daily request count at the ATS is bounded
-- by the day's new companies rather than by every boardless row ever seen.
-- Added here in place rather than by a further migration because this file
-- had been applied nowhere when it was edited.

CREATE TABLE IF NOT EXISTS "discoveries" (
  "company" text PRIMARY KEY,
  "channel" text NOT NULL CHECK ("channel" IN ('builtin', 'hn')),
  "best_comp" integer,
  "cards" integer NOT NULL,
  "first_seen" date NOT NULL,
  "last_seen" date NOT NULL,
  "boards" jsonb NOT NULL,
  "probed_at" date,
  "status" text NOT NULL CHECK ("status" IN ('new', 'added', 'rejected')),
  "decided_at" timestamptz,
  "reason" text
);

ALTER TABLE "discoveries" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON "discoveries";
CREATE POLICY "authenticated_read" ON "discoveries" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_write" ON "discoveries";
CREATE POLICY "authenticated_write" ON "discoveries" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "discoveries" FROM authenticated;
GRANT SELECT ON TABLE "discoveries" TO authenticated;
GRANT UPDATE ("status", "decided_at", "reason") ON TABLE "discoveries" TO authenticated;

DROP POLICY IF EXISTS "authenticated_write" ON "employers";
CREATE POLICY "authenticated_write" ON "employers" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE "employers" FROM authenticated;
GRANT SELECT ON TABLE "employers" TO authenticated;
GRANT UPDATE ("disqualified") ON TABLE "employers" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260914000000_discoveries');
