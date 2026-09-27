-- Migration 20260928030000_relabel_builtin: the candidates backfill
-- (20260928000000_candidates) gave the 4,919 companies once labelled
-- source 'builtin' the origin 'bootstrap', on the belief that they came
-- from a bootstrap import where the word meant "built in to the tool".
-- They did not. The git history shows a discovery source named "builtin"
-- that crawled builtin.com/jobs/remote on 2026-09-15 (added 04:44 CDT,
-- run from 04:48, removed at 15:54 after a Cloudflare challenge), and the
-- rows' first_seen times fall inside that window at a crawl's pace. The
-- Built In website is one source, so both its eras carry one origin,
-- 'builtin.com', the name the source has today, and a count of candidates
-- by origin credits the site with everything it found.
--
-- Idempotent: a second run finds no 'bootstrap' row.

UPDATE "candidates" SET "origin" = 'builtin.com' WHERE "origin" = 'bootstrap';

INSERT INTO "schema_migrations" ("id") VALUES ('20260928030000_relabel_builtin')
  ON CONFLICT DO NOTHING;
