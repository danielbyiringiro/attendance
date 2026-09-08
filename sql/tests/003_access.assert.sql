-- ============================================================================
-- Migrations 003 + 008 — access is membership
--
-- 003 installed the machinery with an admin bypass and made everyone an admin,
-- so that applying it changed nobody's access. 008 removed the bypass. These
-- assertions describe the model as it now stands: you see a class if you are on
-- it, and that is the whole rule.
--
-- They must ACT AS a signed-in user. Every other suite runs as postgres, which
-- owns the tables and bypasses RLS entirely, so a policy test written the usual
-- way would pass no matter what the policy said.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Setup, as the owner
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  n bigint;
BEGIN
  -- 003 created a staff row per existing account. That part stands: without it
  -- nobody could sign in and reach anything.
  SELECT count(*) INTO n FROM public.staff;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 staff rows from the bootstrap, found %', n;
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users u
             WHERE NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = u.id))
  THEN
    RAISE EXCEPTION 'an existing account was left without a staff row';
  END IF;

  -- 008 reset the flag. It is inert now, and nothing should have set it since.
  SELECT count(*) INTO n FROM public.staff WHERE is_admin;
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% account(s) still carry is_admin. Access is membership; the flag grants '
      'nothing and should be false everywhere.', n;
  END IF;

  -- 008 rescued the backfilled class, which had no members because migration
  -- 005 ran with no JWT. Without this everyone would have lost it.
  SELECT count(*) INTO n
  FROM public.classes c
  WHERE NOT EXISTS (SELECT 1 FROM public.class_staff cs WHERE cs.class_id = c.id);
  IF n <> 0 THEN
    RAISE EXCEPTION '% class(es) have no members and are unreachable by anyone', n;
  END IF;
END
$setup$;

-- ----------------------------------------------------------------------------
-- Creating a class puts you on it
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $two_creates$
DECLARE
  v_class uuid;
  n       bigint;
BEGIN
  IF public.current_staff_id() IS NULL THEN
    RAISE EXCEPTION 'current_staff_id() did not resolve the acting user';
  END IF;

  v_class := (public.create_class(
                'ASSERT-003-TWO', 'Owned by two',
                DATE '2026-05-18', DATE '2026-08-28',
                'Africa/Accra', 2) ->> 'class_id')::uuid;

  SELECT count(*) INTO n FROM public.classes WHERE id = v_class;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the creator cannot see the class they just created';
  END IF;

  SELECT count(*) INTO n
  FROM public.class_staff
  WHERE class_id = v_class AND staff_id = public.current_staff_id();
  IF n <> 1 THEN
    RAISE EXCEPTION 'creating a class did not put the creator on it';
  END IF;

  -- There are no roles: being on a class means you can do everything to it.
  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'a member cannot access their own class';
  END IF;
  IF NOT public.can_manage_class(v_class) THEN
    RAISE EXCEPTION 'a member cannot manage their own class';
  END IF;

  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class;
  IF n <> 2 THEN
    RAISE EXCEPTION 'create_class should have made 2 cohorts, found %', n;
  END IF;

  INSERT INTO public.cohort_schedules (class_id, cohort_id, weekday, start_time)
  SELECT v_class, id, 2, TIME '09:00'
  FROM public.cohorts WHERE class_id = v_class ORDER BY label LIMIT 1;
END
$two_creates$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- Somebody else's class is invisible, not merely read-only
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

DO $three_isolated$
DECLARE
  v_own uuid;
  n     bigint;
BEGIN
  SELECT count(*) INTO n FROM public.classes WHERE code = 'ASSERT-003-TWO';
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see a class belonging to staff two';
  END IF;

  -- Nor its children: scoping the parent row alone would leave the cohorts and
  -- schedules readable, which is why every table carries class_id.
  SELECT count(*) INTO n
  FROM public.cohorts co
  JOIN public.classes c ON c.id = co.class_id
  WHERE c.code = 'ASSERT-003-TWO';
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see another class''s cohorts';
  END IF;

  SELECT count(*) INTO n
  FROM public.cohort_schedules cs
  JOIN public.classes c ON c.id = cs.class_id
  WHERE c.code = 'ASSERT-003-TWO';
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see another class''s schedule';
  END IF;

  v_own := (public.create_class(
              'ASSERT-003-THREE', 'Owned by three',
              DATE '2026-05-18', DATE '2026-08-28') ->> 'class_id')::uuid;

  -- Their own, plus the rescued class they were attached to. Not two's.
  SELECT count(*) INTO n FROM public.classes WHERE code LIKE 'ASSERT-003%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'staff three should see exactly 1 ASSERT-003 class, sees %', n;
  END IF;

  IF public.can_access_class(
       (SELECT id FROM public.classes WHERE code = 'ASSERT-003-THREE'))
     IS NOT TRUE
  THEN
    RAISE EXCEPTION 'can_access_class denied the caller their own class';
  END IF;
END
$three_isolated$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- No bypass: the flag grants nothing even when set
-- ----------------------------------------------------------------------------

DO $set_flag$
BEGIN
  -- Deliberately re-set the flag that used to mean "see everything".
  UPDATE public.staff SET is_admin = true
  WHERE user_id = '11111111-1111-1111-1111-111111111111';
END
$set_flag$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $no_bypass$
DECLARE
  n bigint;
BEGIN
  -- Staff one was attached to the rescued class, and to nothing else. The other
  -- two ASSERT-003 classes must stay invisible despite the flag.
  SELECT count(*) INTO n FROM public.classes WHERE code LIKE 'ASSERT-003%';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'is_admin still grants access to % class(es) the account is not on', n;
  END IF;
END
$no_bypass$;

RESET ROLE;
RESET request.jwt.claim.sub;

UPDATE public.staff SET is_admin = false;

-- ----------------------------------------------------------------------------
-- An account with no staff row can do nothing at all
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';

DO $stranger$
DECLARE
  n  bigint;
  ok boolean;
BEGIN
  IF public.current_staff_id() IS NOT NULL THEN
    RAISE EXCEPTION 'an unknown uid resolved to a staff row';
  END IF;

  SELECT count(*) INTO n FROM public.classes;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-member account can see % classes', n;
  END IF;

  SELECT count(*) INTO n FROM public.staff;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-member account can read the staff list';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.create_class('ASSERT-003-STRANGER', 'Should not exist',
                                DATE '2026-05-18', DATE '2026-08-28');
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'an account with no staff row created a class';
  END IF;
END
$stranger$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- Shape
-- ----------------------------------------------------------------------------

DO $grants$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('staff', 'class_staff', 'classes', 'cohorts', 'enrolments')
    AND grantee = 'anon';
  IF n <> 0 THEN
    RAISE EXCEPTION 'anon holds % grants on the class tables', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('cohorts', 'enrolments', 'cohort_schedules', 'class_sessions')
    AND qual LIKE '%can_access_class%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 class-scoped policies, found %', n;
  END IF;

  -- No INSERT policy on classes: create_class() is the only route, because a
  -- direct insert().select() could never work anyway.
  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'classes' AND cmd = 'INSERT';
  IF n <> 0 THEN
    RAISE EXCEPTION 'classes still has an INSERT policy; create_class is the route';
  END IF;

  RAISE NOTICE '003+008 access assertions passed';
END
$grants$;

ROLLBACK;
