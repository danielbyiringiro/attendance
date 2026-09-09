-- ============================================================================
-- Supabase shim for a vanilla Postgres container.
--
-- The migrations are written for Supabase and reference things a plain
-- postgres:15-alpine image does not have: the anon / authenticated /
-- service_role login roles, the auth schema, and auth.uid(). Without these,
-- every GRANT and every RLS policy in the migrations fails to parse and the
-- harness would only ever be testing the CREATE TABLE half of the work.
--
-- Applied first, before the legacy fixture. Test-only — never run in Supabase,
-- which already provides all of this.
-- ============================================================================

-- Roles. NOLOGIN is fine: the tests reach them with SET ROLE, not a connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase grants these by default on new objects; mirror it so the migrations
-- only have to express what they deliberately REVOKE.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- auth.uid() returns the current user's id from the request JWT. Under test
-- there is no JWT, so it reads a session GUC the suites can set:
--   SET LOCAL request.jwt.claim.sub = '<uuid>';
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- auth.users. Supabase owns this table; migration 003 reads it to bootstrap the
-- staff list, and the suites SET request.jwt.claim.sub to one of these ids to
-- act as that person.
-- raw_user_meta_data is where Supabase Auth puts whatever signUp() was given in
-- options.data — which is the only place the name typed on the signup form
-- survives, since confirming an email later starts a fresh browser with no
-- memory of the form. Migration 021 reads it.
CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text UNIQUE,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Separately, so a container built before this column existed still gains it.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'ta.one@example.edu'),
  ('22222222-2222-2222-2222-222222222222', 'ta.two@example.edu'),
  ('33333333-3333-3333-3333-333333333333', 'newcomer@example.edu')
ON CONFLICT (id) DO NOTHING;

-- gen_random_uuid() lives in pgcrypto on older servers; on 13+ it is built in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The realtime publication the migrations add tables to. Supabase ships it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
