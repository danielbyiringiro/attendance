-- ============================================================================
-- Migration 020 — approval, and what admin can and cannot reach
--
-- Two things worth pinning. That an unapproved account can do nothing, and
-- that an admin — who can repair class membership — still cannot see a single
-- roster, session or attendance record. 008's rule is that you see a class if
-- you are on it, and 020 must not have quietly become a way around it.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
  ON CONFLICT (domain) DO NOTHING;

  INSERT INTO auth.users (id, email) VALUES
    ('a0000000-0000-0000-0000-00000000000a', 'admin-021@example.edu'),
    ('b0000000-0000-0000-0000-00000000000b', 'pending-021@example.edu')
  ON CONFLICT (id) DO NOTHING;

  -- Since 022, an address outside the allowed domains cannot become an auth
  -- account at all — so the only way this one exists is the way it still
  -- happens in practice: the domain was on the list when they signed up, and
  -- an admin removed it afterwards. ensure_staff is what must still refuse
  -- them, and this sets that situation up honestly rather than by disabling
  -- the trigger.
  INSERT INTO public.allowed_email_domains (domain) VALUES ('elsewhere.com')
  ON CONFLICT (domain) DO NOTHING;

  INSERT INTO auth.users (id, email) VALUES
    ('c0000000-0000-0000-0000-00000000000c', 'outsider-021@elsewhere.com')
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.allowed_email_domains WHERE domain = 'elsewhere.com';

  INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
    ('a0000000-0000-0000-0000-00000000000a', 'admin-021@example.edu',
     'The Admin', 'approved', true)
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

-- ----------------------------------------------------------------------------
-- A new account is pending, and pending means nothing works
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = 'b0000000-0000-0000-0000-00000000000b';

DO $pending$
DECLARE
  r  jsonb;
  ok boolean;
BEGIN
  r := public.ensure_staff('New Comer');
  IF r ->> 'status' <> 'pending' THEN
    RAISE EXCEPTION 'a new account was not pending: %', r;
  END IF;

  IF public.current_staff_id() IS NOT NULL THEN
    RAISE EXCEPTION 'a pending account resolves to a staff id';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.create_class('ASSERT-021', 'Nope',
                                CURRENT_DATE, CURRENT_DATE + 30);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a pending account created a class';
  END IF;

  IF public.is_admin() THEN
    RAISE EXCEPTION 'a pending account reports itself as an admin';
  END IF;
END
$pending$;

-- ----------------------------------------------------------------------------
-- An address outside the allowed domains gets no staff row at all
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'c0000000-0000-0000-0000-00000000000c';

DO $domain$
DECLARE r jsonb;
BEGIN
  r := public.ensure_staff('Outsider');

  IF r ->> 'status' <> 'domain_not_allowed' THEN
    RAISE EXCEPTION
      'an address outside the allowed domains was let through: %', r;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.staff WHERE email = 'outsider-021@elsewhere.com'
  ) THEN
    RAISE EXCEPTION 'a staff row was created for a disallowed domain';
  END IF;
END
$domain$;

-- ----------------------------------------------------------------------------
-- The admin approves, and only then does anything work
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';

DO $approve$
DECLARE
  v_new uuid;
  r     jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'the bootstrapped admin is not an admin';
  END IF;

  -- Through admin_list_staff, not a direct SELECT: RLS on `staff` still
  -- applies to an admin — the policy is shares_a_class_with(), and they share
  -- no class with somebody who has never been approved. The admin_ functions
  -- are SECURITY DEFINER, which is the whole reason they exist. The UI has to
  -- go the same way.
  IF NOT (public.admin_list_staff('pending')::text LIKE '%pending-021@example.edu%') THEN
    RAISE EXCEPTION 'the pending account is not in the pending list';
  END IF;

  SELECT (row ->> 'staff_id')::uuid INTO v_new
  FROM jsonb_array_elements(public.admin_list_staff('pending')) AS row
  WHERE row ->> 'email' = 'pending-021@example.edu';

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'admin_list_staff did not carry the pending account''s id';
  END IF;

  r := public.admin_decide_staff(v_new, true);
  IF r ->> 'status' <> 'approved' THEN
    RAISE EXCEPTION 'approval did not take: %', r;
  END IF;

  -- An admin cannot reject themselves into oblivion.
  BEGIN
    PERFORM public.admin_decide_staff(public.current_staff_id(), false);
    RAISE EXCEPTION 'an admin rejected their own account';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'an admin rejected their own account' THEN RAISE; END IF;
  END;

  -- Nor demote the last one.
  BEGIN
    PERFORM public.admin_set_admin(public.current_staff_id(), false);
    RAISE EXCEPTION 'the only admin demoted themselves';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'the only admin demoted themselves' THEN RAISE; END IF;
  END;
END
$approve$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'b0000000-0000-0000-0000-00000000000b';

DO $now_works$
DECLARE v_class uuid;
BEGIN
  IF public.current_staff_id() IS NULL THEN
    RAISE EXCEPTION 'an approved account still resolves to no staff id';
  END IF;

  v_class := (public.create_class('ASSERT-021', 'Now allowed',
                CURRENT_DATE, CURRENT_DATE + 30) ->> 'class_id')::uuid;

  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'the creator cannot reach the class they just made';
  END IF;

  CREATE TEMP TABLE t021 ON COMMIT DROP AS SELECT v_class AS class_id;
END
$now_works$;

-- ----------------------------------------------------------------------------
-- THE BOUNDARY: an admin can repair membership and cannot read attendance
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a0000000-0000-0000-0000-00000000000a';

DO $boundary$
DECLARE
  v_class uuid := (SELECT class_id FROM t021);
  n       bigint;
BEGIN
  -- Not a member of it.
  IF public.can_access_class(v_class) THEN
    RAISE EXCEPTION
      'an admin can reach a class they are not on — 008''s rule is broken';
  END IF;

  -- So every membership-scoped read is empty, whatever admin they hold.
  SELECT count(*) INTO n FROM public.classes WHERE id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'an admin can SELECT a class they are not on';
  END IF;

  SELECT count(*) INTO n FROM public.class_sessions WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'an admin can read sessions of a class they are not on';
  END IF;

  SELECT count(*) INTO n FROM public.enrolments WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'an admin can read the roster of a class they are not on';
  END IF;

  SELECT count(*) INTO n FROM public.attendance_records WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'an admin can read attendance of a class they are not on — this is the '
      'surveillance the design specifically refuses';
  END IF;

  -- But the repair powers work: they can see the class exists, and who is on it.
  IF NOT (public.admin_list_classes()::text LIKE '%ASSERT-021%') THEN
    RAISE EXCEPTION 'admin_list_classes does not show the class';
  END IF;

  IF NOT (public.admin_list_class_members(v_class)::text
          LIKE '%pending-021@example.edu%') THEN
    RAISE EXCEPTION 'admin_list_class_members does not show its member';
  END IF;
END
$boundary$;

-- ----------------------------------------------------------------------------
-- The rescue: putting somebody back on a class they lost
-- ----------------------------------------------------------------------------

DO $rescue$
DECLARE
  v_class uuid := (SELECT class_id FROM t021);
  n bigint;
BEGIN
  PERFORM public.admin_set_class_member(v_class, 'admin-021@example.edu', true);

  SELECT count(*) INTO n FROM public.class_staff WHERE class_id = v_class;
  IF n <> 2 THEN
    RAISE EXCEPTION 'the admin was not added to the class: % members', n;
  END IF;

  -- And now, being ON it, they can reach it — through membership, not admin.
  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'being added to a class did not grant access to it';
  END IF;

  PERFORM public.admin_set_class_member(v_class, 'admin-021@example.edu', false);

  IF public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'removing themselves did not remove their access';
  END IF;
END
$rescue$;

-- ----------------------------------------------------------------------------
-- A non-admin cannot use any of it
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'b0000000-0000-0000-0000-00000000000b';

DO $not_admin$
DECLARE ok boolean;
BEGIN
  ok := false;
  BEGIN PERFORM public.admin_list_staff();
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'a non-admin listed every account'; END IF;

  ok := false;
  BEGIN PERFORM public.admin_list_classes();
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'a non-admin listed every class'; END IF;

  ok := false;
  BEGIN PERFORM public.admin_set_domain('anything.com', true);
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'a non-admin changed the allowed domains'; END IF;

  ok := false;
  BEGIN
    PERFORM public.admin_decide_staff(public.current_staff_id(), true);
  EXCEPTION WHEN others THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'a non-admin approved an account'; END IF;
END
$not_admin$;

DO $done$ BEGIN RAISE NOTICE '021 approval and admin-boundary assertions passed'; END $done$;

ROLLBACK;
