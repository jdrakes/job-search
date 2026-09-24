-- Migration 20260913000000_employer_principal_is_staff: an employer may
-- record that its staff level is spelled Principal. Level words are set once
-- for the whole search, and an operator who excludes the Principal band
-- still wants the employers who use that word for the level they do want, so
-- the exception is per employer rather than another word in the criteria row.
--
-- Hand-written, as every migration after the init is: an ALTER cannot be
-- derived from a before-and-after schema without a database to diff against.
-- The column's type and default are what the regenerated db/schema.sql
-- carries for `employers`, copied verbatim; `src/schema.ts` (`Employer`) and
-- `scripts/gen-schema.ts` stay the one definition and this file is a
-- snapshot of it at one moment.
--
-- Written idempotently on purpose. `supabase db reset` replays the
-- REGENERATED init first, which already carries the column, so this
-- statement must be a no-op there; against the live project, still holding
-- the init as it was first applied, it is what actually adds it. The default
-- is the parser's reading of an absent key — false, "not that kind of
-- employer" — so every row written before the column existed reads the same
-- as its JSON.

ALTER TABLE "employers" ADD COLUMN IF NOT EXISTS "principalIsStaff" boolean NOT NULL DEFAULT false;

-- The receipt the application reads. See the init migration's header: this is
-- NOT the CLI's own supabase_migrations.schema_migrations.
INSERT INTO "schema_migrations" ("id") VALUES ('20260913000000_employer_principal_is_staff');
