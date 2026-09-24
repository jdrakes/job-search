-- Migration 20260923120000_reprobe_runs: one row per `scripts/reprobe.ts`
-- pass, so the tool can answer "has this already been asked" from the
-- store rather than from a terminal scrollback.
--
-- Written after 2026-09-23, when a backlog pass re-probed six platforms
-- the backlog had been cleared against the day before: ~14,000 vendor
-- requests, and the redundancy only visible once the pass had returned
-- zero across 2,100 names. The prior pass's only trace was a scratch log
-- in an earlier session.
--
-- `platforms` is the pass's list sorted and comma-joined, so the same set
-- named in a different order is the same key. `refused_at` is the name a
-- vendor's 429 stopped the pass on, and where the next pass resumes.
-- `finished` stays null on a pass that was killed, which is what separates
-- "never completed" from "completed and found nothing".
--
-- Hand-written and idempotent like every migration after the init.

CREATE TABLE IF NOT EXISTS "reprobe_runs" (
  "started" text PRIMARY KEY,
  "platforms" text NOT NULL,
  "names" integer NOT NULL,
  "probed" integer NOT NULL DEFAULT 0,
  "watched" integer NOT NULL DEFAULT 0,
  "aliases" integer NOT NULL DEFAULT 0,
  "errors" integer NOT NULL DEFAULT 0,
  "refused_at" text,
  "finished" text
);

INSERT INTO "schema_migrations" ("id") VALUES ('20260923120000_reprobe_runs')
  ON CONFLICT DO NOTHING;
