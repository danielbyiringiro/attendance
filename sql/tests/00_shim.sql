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

-- gen_random_uuid() lives in pgcrypto on older servers; on 13+ it is built in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The realtime publication the migrations add tables to. Supabase ships it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;
