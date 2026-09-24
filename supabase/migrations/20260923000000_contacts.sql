-- Migration 20260923000000_contacts: `contacts`, the fourth stored thing —
-- the recruiters James has an actual relationship with, so a search can
-- begin with the people who already know him rather than with a posting.
-- Nothing here recorded a human: `postings`, `companies` and `criteria`
-- are listings and rules, and the resume and the letters live in another
-- repo, so a warm recruiter had nowhere to be.
--
-- Hand-written, as every migration after the init is: there is no schema
-- generator here, so src/schema.ts is the one definition and this file is
-- its SQL by hand. tests/schema.test.ts reads this file's column list back
-- and pins it equal to CONTACT_FIELDS, and this table's `state` CHECK
-- equal to CONTACT_STATES, so the two cannot drift apart unnoticed.
--
-- Identity is the email address. A recruiter who changes agencies keeps
-- the address, and nothing merges two addresses automatically: `alias_of`
-- is James's column, set in the list when he sees a duplicate, because a
-- wrong merge is silent and a duplicate is visible. `company` is the
-- latest observation and `company_history` keeps the earlier ones
-- ({company, domain, first_seen, last_seen}), which is how a recruiter who
-- moved agencies stays one relationship rather than two rows.
--
-- `state` is the processor's column alone, and all three of its values are
-- derived: `employer` for an heb.com counterpart, `active` for a message
-- within 90 days, `target` for everyone else. James's drop lives beside it
-- in `dropped_at` and `reason`, as it does on `companies` since
-- 20260918030000_company_drop: when a drop and a processor's state shared
-- one column, a publish wrote the processor's copy back over the drop.
-- `note`, `contacted_at` and `alias_of` are the operator's for the same
-- reason, so a re-run of the sync cannot erase a decision.
--
-- The grants say that division to the browser: SELECT on the table, UPDATE
-- on exactly the five columns James authors, and nothing else. No INSERT
-- and no DELETE — the sync writes with the service key, not the browser's
-- `authenticated` role.
--
-- Written idempotently, like every migration here: CREATE TABLE IF NOT
-- EXISTS, and DROP POLICY IF EXISTS before each CREATE POLICY since a
-- policy has no IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "contacts" (
  "email" text PRIMARY KEY,
  "name" text,
  "company" text,
  "company_history" jsonb NOT NULL DEFAULT '[]',
  "state" text NOT NULL CHECK ("state" IN ('target', 'active', 'employer')),
  "signals" jsonb NOT NULL DEFAULT '[]',
  "first_contact" timestamptz,
  "last_contact" timestamptz,
  "thread_count" integer NOT NULL DEFAULT 0,
  "threads" jsonb NOT NULL DEFAULT '[]',
  "last_subject" text,
  "dropped_at" timestamptz,
  "reason" text,
  "note" text,
  "contacted_at" timestamptz,
  "alias_of" text
);

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "james_read" ON "contacts";
CREATE POLICY "james_read" ON "contacts" FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "james_write" ON "contacts";
CREATE POLICY "james_write" ON "contacts" FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- A policy cannot name columns, so the column list is the grant's.
REVOKE ALL ON TABLE "contacts" FROM authenticated;
GRANT SELECT ON TABLE "contacts" TO authenticated;
GRANT UPDATE ("dropped_at", "reason", "note", "contacted_at", "alias_of") ON TABLE "contacts" TO authenticated;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260923000000_contacts');
