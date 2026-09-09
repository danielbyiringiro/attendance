-- ============================================================================
-- Migration 026 — what an anonymous visitor can reach
--
-- The bug this closes was not a broken rule. It was three tables that no rule
-- had ever been written about: they predate the migrations, they were not
-- retired by 015, and every REVOKE sweep since was written around whichever
-- tables somebody happened to be changing.
--
-- So the assertion is a SWEEP, not a list. It walks every table in public and
-- fails on any that anon can read without RLS, whatever its name and whenever
-- it was added. A named list would have passed happily for the whole time this
-- was broken, because nobody would have thought to put students on it.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- THE SWEEP: no table in public is readable by anon without RLS
-- ----------------------------------------------------------------------------

DO $sweep$
DECLARE
  r   record;
  bad text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT c.relname, c.relrowsecurity AS rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND has_table_privilege('anon', c.oid, 'SELECT')
  LOOP
    -- allowed_email_domains is readable on purpose, and asserted separately
    -- below. Everything else must be behind RLS at minimum.
    IF r.relname <> 'allowed_email_domains' AND NOT r.rls THEN
      bad := bad || r.relname;
    END IF;
  END LOOP;

  IF array_length(bad, 1) > 0 THEN
    RAISE EXCEPTION
      'anon can read these tables and no RLS stands between: %. The anon key '
      'ships in the browser bundle, so this is public data',
      array_to_string(bad, ', ');
  END IF;
END
$sweep$;

-- ----------------------------------------------------------------------------
-- And specifically: the three that were open
--
-- Named as well as swept, so a failure says which one came back rather than
-- only that something did.
-- ----------------------------------------------------------------------------

DO $named$
DECLARE
  t     text;
  priv  boolean;
  rls   boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['students', 'canvas_row_mappings', 'flagged_resolutions']
  LOOP
    SELECT has_table_privilege('anon', c.oid, 'SELECT'), c.relrowsecurity
      INTO priv, rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t;

    -- Catalogue state rather than a row count: flagged_resolutions is empty in
    -- the fixture, and an empty table reads as zero rows whether it is shut or
    -- wide open. A test that cannot tell those apart is not a test.
    IF priv AND NOT rls THEN
      RAISE EXCEPTION
        'public.% is readable by anon with no RLS — everything in it is public',
        t;
    END IF;
  END LOOP;
END
$named$;

-- And where the fixture does have rows, prove it in the obvious way too.
SET ROLE anon;

DO $students$
DECLARE n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.students;
  EXCEPTION WHEN insufficient_privilege THEN
    n := 0;   -- no grant at all: the stronger outcome
  END;

  IF n <> 0 THEN
    RAISE EXCEPTION
      'anon read % student row(s) — every ID and name in the installation', n;
  END IF;
END
$students$;

-- ----------------------------------------------------------------------------
-- The signup screen can still name its domains
--
-- The opposite failure, and the reason this is not simply "revoke everything".
-- The screen that reads this list is shown to people who have no account yet,
-- so a policy TO authenticated meant it never rendered for anybody it was
-- written for.
-- ----------------------------------------------------------------------------

DO $domains$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.allowed_email_domains;

  IF n = 0 THEN
    RAISE EXCEPTION
      'anon cannot read the allowed domains, so the signup screen says none '
      'are accepted — which is what it did before this migration';
  END IF;
END
$domains$;

-- ----------------------------------------------------------------------------
-- Reading them is all anon may do
-- ----------------------------------------------------------------------------

DO $readonly$
DECLARE failed boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.allowed_email_domains (domain) VALUES ('anon-added.com');
  EXCEPTION WHEN others THEN failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION 'anon added a domain, which is anon granting itself signup';
  END IF;
END
$readonly$;

-- ----------------------------------------------------------------------------
-- A signed-in TA still sees the students they need
--
-- The point of the fix is that anon cannot; breaking the app for everybody
-- else would be a different bug rather than a fix.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $ta$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.students;
  IF n = 0 THEN
    RAISE EXCEPTION 'a signed-in TA can no longer read any student';
  END IF;
END
$ta$;

-- ----------------------------------------------------------------------------
-- And check-in still works, which is the path that actually matters
--
-- mark_attendance is SECURITY DEFINER and reads students as the owner, so
-- revoking anon must not touch it. If this breaks, the fix has locked every
-- student out of marking their own attendance.
-- ----------------------------------------------------------------------------

DO $checkin_setup$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_session uuid;
BEGIN
  v_class := (public.create_class('ASSERT-027', 'Still Works',
                CURRENT_DATE - 7, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "A027", "name": "Can Still Check In"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 7
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE)::int)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE, CURRENT_DATE);

  SELECT id INTO v_session
  FROM public.class_sessions WHERE cohort_id = v_cohort LIMIT 1;

  PERFORM public.open_session(v_session, 'A27PIN', 60);
END
$checkin_setup$;

RESET ROLE;
SET ROLE anon;

DO $checkin$
DECLARE r jsonb;
BEGIN
  r := public.mark_attendance('A027', 'A27PIN');

  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION
      'check-in broke when students was closed to anon — mark_attendance is '
      'SECURITY DEFINER and should read it as the owner: %', r;
  END IF;

  -- And it still knows the name, which it reads from the table anon cannot.
  IF r ->> 'name' <> 'Can Still Check In' THEN
    RAISE EXCEPTION 'the student name did not come back: %', r;
  END IF;
END
$checkin$;

DO $done$ BEGIN RAISE NOTICE '027 anon-reach assertions passed'; END $done$;

ROLLBACK;
