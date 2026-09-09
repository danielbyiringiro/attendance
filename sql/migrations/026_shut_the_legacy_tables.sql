-- ============================================================================
-- 026 — close the tables anon was never meant to reach
--
-- WHAT WAS OPEN
--
-- public.students is readable by anyone holding the anon key — which ships in
-- the browser bundle, by design, because every rule that matters is supposed
-- to be enforced by RLS. Every student ID and every name in the installation,
-- to anybody who opens the check-in page and a console.
--
-- canvas_row_mappings is the same, and joins a student ID to their row in a
-- Canvas gradebook. flagged_resolutions likewise: how a disputed attendance
-- record was settled.
--
-- HOW IT HAPPENED
--
-- Every table the migrations create is revoked from anon at the end of the file
-- that creates it — 001, 002, 004 and 005 each sweep their own. 015 revoked the
-- legacy tables it retired. 016 revoked flagged when it took ownership of it.
--
-- These three are the tables that predate the migrations and were NOT retired.
-- students is kept deliberately, as the global person registry; the other two
-- were simply never revisited. Being kept is exactly why they were missed:
-- every sweep was written around a set of tables somebody was changing, and
-- nobody was changing these.
--
-- Supabase grants anon and authenticated full table privileges by default and
-- expects RLS to take them back. A table with neither a REVOKE nor RLS is
-- therefore wide open, and looks no different in the dashboard from one that is
-- fine.
--
-- WHAT THIS DOES
--
-- Revokes anon on all three, and turns RLS on with the house policy — readable
-- and writable by `authenticated`, which is what every other table here has.
-- No SECURITY DEFINER function is affected: they run as the owner, so
-- mark_attendance still reads students exactly as before.
--
-- AND ONE THING IN THE OTHER DIRECTION
--
-- allowed_email_domains has RLS with a policy `TO authenticated` — but the
-- screen that reads it is the SIGNUP screen, which is shown to people who are
-- by definition not signed in yet. So the hint naming the accepted domains has
-- never rendered for anybody it was written for; they see "No email domains are
-- accepted yet" instead, which is both wrong and discouraging.
--
-- The list is not a secret. It is which institution this installation belongs
-- to, printed on the page as soon as somebody guesses. anon gets to read it.
--
-- Run AFTER 025. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The three that were open
-- ----------------------------------------------------------------------------

DO $shut$
DECLARE
  t     text;
  n     bigint;
  tables text[] := ARRAY['students', 'canvas_row_mappings', 'flagged_resolutions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n2 ON n2.oid = c.relnamespace
      WHERE n2.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE '026: public.% does not exist here, skipping', t;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- The house pattern, verbatim: signed in, and that is the gate. Per-class
    -- scoping for students would be wrong anyway — the registry is global, and
    -- a student belongs to everybody who teaches them.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_auth_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_auth_all', t);

    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    RAISE NOTICE '026: public.% closed to anon (% row(s) were exposed)', t, n;
  END LOOP;
END
$shut$;

-- ----------------------------------------------------------------------------
-- The one that was too closed
--
-- Readable by anon so the signup screen can name the domains it accepts before
-- anybody has an account. Writing still goes through admin_set_domain.
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS allowed_email_domains_read ON public.allowed_email_domains;
CREATE POLICY allowed_email_domains_read ON public.allowed_email_domains
  FOR SELECT TO anon, authenticated USING (true);

GRANT SELECT ON public.allowed_email_domains TO anon;

COMMENT ON TABLE public.allowed_email_domains IS
  'Which email domains may create an account. Readable by anon on purpose: the '
  'signup screen names them, and it is shown to people who do not have an '
  'account yet. Written only through admin_set_domain.';

-- ----------------------------------------------------------------------------
-- A standing check, so the next one is caught here rather than by somebody
--
-- Every table in public, every time this migration runs. It raises a WARNING
-- rather than failing: a migration that refuses to apply because of a table it
-- was not written for is a migration somebody deletes.
-- ----------------------------------------------------------------------------

DO $audit$
DECLARE
  r    record;
  bad  text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT c.relname, c.relrowsecurity AS rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND has_table_privilege('anon', c.oid, 'SELECT')
      -- Deliberately readable: see above.
      AND c.relname <> 'allowed_email_domains'
  LOOP
    IF NOT r.rls THEN
      bad := bad || r.relname;
    END IF;
  END LOOP;

  IF array_length(bad, 1) > 0 THEN
    RAISE WARNING
      '026: these tables are readable by anon with no RLS: %. Anything in them '
      'is public to anyone holding the anon key, which ships in the browser.',
      array_to_string(bad, ', ');
  ELSE
    RAISE NOTICE '026: no table in public is readable by anon without RLS';
  END IF;
END
$audit$;
