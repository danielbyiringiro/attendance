-- ============================================================================
-- 026 — make the legacy tables' protection explicit, and fix the signup hint
--
-- WHAT IS ACTUALLY TRUE, having checked
--
-- students, canvas_row_mappings and flagged_resolutions carry no REVOKE and no
-- policy from any migration in this repo. On the production database they are
-- nonetheless protected: RLS was switched on for them in the Supabase
-- dashboard, years before these migrations existed. So nothing was leaking.
--
-- It was leaking in the TEST HARNESS, where the legacy fixture creates those
-- tables the way the original schema did — without RLS — and Supabase's default
-- grant to anon therefore stood unopposed. That is what the sweep in 027
-- found, and the first draft of this file said the production database was
-- open. It was not. The check was one query and it should have been run before
-- the claim, not after.
--
-- WHY THIS IS STILL WORTH APPLYING
--
-- Their protection rests entirely on a checkbox somebody ticked in a dashboard
-- and nothing in this repository. A table restored from a backup, recreated by
-- hand, or created in a second environment from these migrations gets no such
-- protection, and the failure is silent — a table with neither a REVOKE nor RLS
-- looks identical in the dashboard to one that is fine.
--
-- Every table these migrations create is revoked from anon in the file that
-- creates it. 015 swept the legacy tables it retired; 016 swept flagged when it
-- took ownership. These three predate the migrations and were not retired —
-- students deliberately, as the global person registry. Being KEPT is why no
-- sweep was ever about them. This makes them match everything else.
--
-- WHAT IT DOES
--
-- Revokes anon, enables RLS, and adds the house policy — readable and writable
-- by `authenticated`, which is what every other table here has. Idempotent, so
-- where RLS is already on this is close to a no-op that writes the intent down.
--
-- No SECURITY DEFINER function is affected: they run as the owner, so
-- mark_attendance still reads students exactly as before. 027 asserts that,
-- because getting it wrong would lock every student out of marking attendance.
--
-- AND ONE REAL BUG, IN THE OTHER DIRECTION
--
-- allowed_email_domains has a policy TO authenticated, but the screen that
-- reads it is the SIGNUP screen, which is shown to people who by definition do
-- not have an account yet. So the hint naming the accepted domains has never
-- rendered for anybody it was written for: since 020 they have seen "No email
-- domains are accepted yet", which is wrong and discouraging. This one is live.
--
-- The list is not a secret. It is which institution this installation belongs
-- to, printed on the page as soon as somebody guesses.
--
-- Run AFTER 025. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The three the migrations never claimed
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
    RAISE NOTICE
      '026: public.% now revoked from anon with RLS and a policy (% row(s))',
      t, n;
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
