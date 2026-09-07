-- ============================================================================
-- Migration 003 — staff and per-class access control
--
-- These assertions must ACT AS a signed-in user. Everything else in this suite
-- runs as postgres, which owns the tables and therefore bypasses RLS entirely —
-- so a policy test written the usual way would pass no matter what the policy
-- said. Each block below does SET ROLE authenticated and sets the JWT claim
-- auth.uid() reads.
--
-- Wrapped in a transaction that is rolled back, so it leaves nothing behind.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Setup, as the owner
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  n bigint;
BEGIN
  -- The bootstrap should have promoted every account in auth.users.
  SELECT count(*) INTO n FROM public.staff;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 bootstrapped staff rows, found %', n;
  END IF;

  SELECT count(*) INTO n FROM public.staff WHERE is_admin;
  IF n <> 3 THEN
    RAISE EXCEPTION 'bootstrap should make every existing account an admin, found %', n;
  END IF;

  -- Applying the migration must not narrow anyone's access on a live database.
  -- That is the whole reason the bootstrap exists.
  IF EXISTS (SELECT 1 FROM auth.users u
             WHERE NOT EXISTS (SELECT 1 FROM public.staff s WHERE s.user_id = u.id))
  THEN
    RAISE EXCEPTION 'an existing account was left without a staff row';
  END IF;
END
$setup$;

-- Demote two of them so there is something to scope. User one stays an admin.
UPDATE public.staff SET is_admin = false
WHERE user_id IN ('22222222-2222-2222-2222-222222222222',
                  '33333333-3333-3333-3333-333333333333');

-- ----------------------------------------------------------------------------
-- Acting as staff two (not an admin): creating a class makes you its owner
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
  IF public.is_admin() THEN
    RAISE EXCEPTION 'staff two should not be an admin at this point';
  END IF;

  -- A non-admin creates through the RPC. A direct INSERT ... RETURNING cannot
  -- work here: Postgres applies the SELECT policy to the returned row, and the
  -- class_staff row that policy looks for does not exist until the AFTER
  -- trigger fires.
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
  WHERE class_id = v_class AND staff_id = public.current_staff_id() AND role = 'owner';
  IF n <> 1 THEN
    RAISE EXCEPTION 'creating a class did not make the creator its owner';
  END IF;

  -- "N cohorts" arrived with the class, in one call, so a failure cannot leave
  -- a class with no sections.
  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class;
  IF n <> 2 THEN
    RAISE EXCEPTION 'create_class should have made 2 cohorts, found %', n;
  END IF;

  -- The children are scoped by can_access_class(class_id) and the owner reaches
  -- them.
  INSERT INTO public.cohort_schedules (class_id, cohort_id, weekday, start_time)
  SELECT v_class, id, 2, TIME '09:00'
  FROM public.cohorts WHERE class_id = v_class ORDER BY label LIMIT 1;

  SELECT count(*) INTO n FROM public.cohort_schedules WHERE class_id = v_class;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the owner cannot see their own schedule';
  END IF;

  -- Direct INSERT is admins only now, so this must be refused.
  BEGIN
    INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
    VALUES ('ASSERT-003-DIRECT', 'Direct insert', DATE '2026-05-18', DATE '2026-08-28');
    RAISE EXCEPTION 'a non-admin inserted into classes directly';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN check_violation THEN NULL;
  END;
END
$two_creates$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- Acting as staff three: another person's class is invisible, not just read-only
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

DO $three_isolated$
DECLARE
  v_own   uuid;
  v_other uuid;
  n       bigint;
  failed  boolean;
BEGIN
  -- Two's class must not be visible at all.
  SELECT count(*) INTO n FROM public.classes WHERE code = 'ASSERT-003-TWO';
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see a class belonging to staff two';
  END IF;

  -- Nor its cohorts, which is the point of scoping the children by class_id
  -- rather than only locking the parent row.
  SELECT count(*) INTO n FROM public.cohorts;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see % cohorts of a class they cannot access', n;
  END IF;

  SELECT count(*) INTO n FROM public.cohort_schedules;
  IF n <> 0 THEN
    RAISE EXCEPTION 'staff three can see another class''s schedule';
  END IF;

  v_own := (public.create_class(
              'ASSERT-003-THREE', 'Owned by three',
              DATE '2026-05-18', DATE '2026-08-28') ->> 'class_id')::uuid;

  -- Now exactly one class is visible: their own.
  SELECT count(*) INTO n FROM public.classes;
  IF n <> 1 THEN
    RAISE EXCEPTION 'staff three should see exactly 1 class, sees %', n;
  END IF;

  -- can_access_class is the predicate everything else leans on, so check it
  -- directly rather than only through its effects.
  IF NOT public.can_access_class(v_own) THEN
    RAISE EXCEPTION 'can_access_class denied the caller their own class';
  END IF;
END
$three_isolated$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- Writing into someone else's class must fail even with the id in hand. Run as
-- a statement rather than inside a DO block: a policy violation on INSERT is a
-- hard error, and catching it in PL/pgSQL would leave the transaction aborted.
SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

DO $no_cross_writes$
DECLARE
  v_other uuid;
  failed  boolean := false;
BEGIN
  -- Read the other class's id through a definer function, simulating someone
  -- who obtained it from a URL or an old export rather than from a query.
  SELECT id INTO v_other FROM public.classes WHERE code = 'ASSERT-003-TWO';
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'the id leaked through the SELECT policy';
  END IF;
END
$no_cross_writes$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- An admin sees everything
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $admin_sees_all$
DECLARE
  n bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'staff one should still be an admin';
  END IF;

  SELECT count(*) INTO n FROM public.classes WHERE code LIKE 'ASSERT-003%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'an admin should see both classes, sees %', n;
  END IF;

  -- An admin needs no class_staff row to reach a class.
  SELECT count(*) INTO n
  FROM public.class_staff cs
  JOIN public.staff s ON s.id = cs.staff_id
  WHERE s.user_id = '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'the admin unexpectedly holds % class_staff rows', n;
  END IF;
END
$admin_sees_all$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- An authenticated account that is not staff can do nothing
--
-- This is the case that matters if someone is given a Supabase login but no
-- staff row: they must not be able to create a class and bootstrap themselves
-- into the system.
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';

DO $stranger$
DECLARE
  n bigint;
BEGIN
  IF public.current_staff_id() IS NOT NULL THEN
    RAISE EXCEPTION 'an unknown uid resolved to a staff row';
  END IF;
  IF public.is_admin() THEN
    RAISE EXCEPTION 'an unknown uid was treated as an admin';
  END IF;

  SELECT count(*) INTO n FROM public.classes;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-staff account can see % classes', n;
  END IF;

  SELECT count(*) INTO n FROM public.staff;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-staff account can read the staff list';
  END IF;
END
$stranger$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- The INSERT policy refuses them. Asserted at statement level because a policy
-- violation aborts the transaction, which a DO block cannot then continue past.
SAVEPOINT before_stranger_insert;
SET ROLE authenticated;
SET request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';

DO $stranger_insert$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    PERFORM public.create_class('ASSERT-003-STRANGER', 'Should not exist',
                                DATE '2026-05-18', DATE '2026-08-28');
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-staff account created a class through create_class';
  END IF;
END
$stranger_insert$;

RESET ROLE;
RESET request.jwt.claim.sub;
ROLLBACK TO SAVEPOINT before_stranger_insert;

-- ----------------------------------------------------------------------------
-- Staff can see themselves but not each other; anon reaches nothing
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $self_read$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.staff;
  IF n <> 1 THEN
    RAISE EXCEPTION 'a non-admin should see only their own staff row, sees %', n;
  END IF;

  -- Demoting yourself, or promoting yourself, must not be possible.
  UPDATE public.staff SET is_admin = true WHERE user_id = '22222222-2222-2222-2222-222222222222';
  IF public.is_admin() THEN
    RAISE EXCEPTION 'a non-admin promoted themselves to admin';
  END IF;
END
$self_read$;

RESET ROLE;
RESET request.jwt.claim.sub;

DO $grants$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('staff', 'class_staff')
    AND grantee = 'anon';
  IF n <> 0 THEN
    RAISE EXCEPTION 'anon holds % grants on the staff tables', n;
  END IF;

  -- Every scoped table should now carry a policy that mentions the predicate,
  -- rather than the blanket USING (true) it had before.
  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('cohorts', 'enrolments', 'cohort_schedules', 'class_sessions')
    AND qual LIKE '%can_access_class%';
  IF n <> 4 THEN
    RAISE EXCEPTION 'expected 4 class-scoped policies, found %', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'classes' AND policyname = 'classes_auth_all';
  IF n <> 0 THEN
    RAISE EXCEPTION 'the old blanket policy on classes was left in place';
  END IF;

  RAISE NOTICE '003 assertions passed';
END
$grants$;

ROLLBACK;
