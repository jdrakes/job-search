-- Migration 20260922010000_new_ats_platforms: widen `postings.platform`'s
-- CHECK to admit the nine ATS readers the design page's Discovery
-- criteria pass on technical grounds -- Jobvite, BambooHR, Avature, Breezy
-- HR, JazzHR, Recruitee, Personio, HRMDirect (ClearCompany's legacy
-- product; the hrmdirect.com domain and markup are what's actually read)
-- and iCIMS (read via its jibeapply.com subdomain, not icims.com itself).
--
-- Hand-written and idempotent like every migration after the init.

ALTER TABLE "postings" DROP CONSTRAINT IF EXISTS "postings_platform_check";
ALTER TABLE "postings" ADD CONSTRAINT "postings_platform_check"
  CHECK ("platform" IN ('greenhouse', 'ashby', 'lever', 'workday', 'eightfold', 'smartrecruiters', 'amazon', 'workable', 'rippling', 'jobvite', 'bamboohr', 'avature', 'breezy', 'jazzhr', 'recruitee', 'personio', 'hrmdirect', 'icims'));

INSERT INTO "schema_migrations" ("id") VALUES ('20260922010000_new_ats_platforms');
