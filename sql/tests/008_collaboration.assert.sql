-- ============================================================================
-- Migration 008 — collaboration without a directory
--
-- Two people can share a class. Neither can enumerate everyone with an account,
-- and neither can leave a class with nobody on it — with no admin bypass, that
-- would strand it beyond reach of anything but the SQL editor.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- Test-only. Lets a block hold a class id the SELECT policy would hide from it,
-- standing in for an id kept from an old page or a URL. Without this the calls
-- below would fail with "class does not exist" and prove nothing about
-- permissions. DDL is transactional, so the ROLLBACK at the end removes it.
CREATE OR REPLACE FUNCTION public.assert_class_id(p_code text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $helper$
  SELECT id FROM public.classes WHERE code = p_code;
$helper$;

GRANT EXECUTE ON FUNCTION public.assert_class_id(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- ensure_staff: signing in is what creates a staff row
-- ----------------------------------------------------------------------------

DO $seed$
BEGIN
  -- A fourth account that the 003 bootstrap never saw, standing in for someone
  -- provisioned after this migration ran.
  INSERT INTO auth.users (id, email)
  VALUES ('44444444-4444-4444-4444-444444444444', 'latecomer@example.edu')
  ON CONFLICT (id) DO NOTHING;
END
$seed$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

DO $newcomer$
DECLARE
  r  jsonb;
  ok boolean;
BEGIN
  -- Before signing in they are nobody: the 003 bootstrap only ever ran over the
  -- accounts that existed at the time.
  IF public.current_staff_id() IS NOT NULL THEN
    RAISE EXCEPTION 'an account the bootstrap never saw already had a staff row';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.create_class('ASSERT-008-NOPE', 'Should not exist',
                                DATE '2026-05-18', DATE '2026-08-28');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'an account with no staff row created a class';
  END IF;

  r := public.ensure_staff();
  IF r ->> 'staff_id' IS NULL THEN
    RAISE EXCEPTION 'ensure_staff did not return a staff row';
  END IF;
  IF r ->> 'email' <> 'latecomer@example.edu' THEN
    RAISE EXCEPTION 'ensure_staff recorded the wrong email: %', r ->> 'email';
  END IF;

  IF public.current_staff_id() IS NULL THEN
    RAISE EXCEPTION 'the staff row was not visible to the account it belongs to';
  END IF;

  -- Called on every page load, so it must be idempotent.
  PERFORM public.ensure_staff();
  PERFORM public.ensure_staff();
END
$newcomer$;

RESET ROLE;
RESET request.jwt.claim.sub;

DO $one_row$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.staff
  WHERE user_id = '44444444-4444-4444-4444-444444444444';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ensure_staff created % rows for one account', n;
  END IF;
END
$one_row$;

-- ----------------------------------------------------------------------------
-- Sharing a class
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $owner_shares$
DECLARE
  v_class uuid;
  r       jsonb;
  n       bigint;
  ok      boolean;
BEGIN
  v_class := (public.create_class('ASSERT-008', 'Shared Class',
                DATE '2026-05-18', DATE '2026-08-28') ->> 'class_id')::uuid;

  r := public.list_class_members(v_class);
  IF jsonb_array_length(r) <> 1 THEN
    RAISE EXCEPTION 'a new class should have exactly its creator on it, has %',
      jsonb_array_length(r);
  END IF;
  IF NOT (r -> 0 ->> 'is_you')::boolean THEN
    RAISE EXCEPTION 'the creator is not marked as the acting user';
  END IF;

  -- Adding by exact email. Not "pick from a list of everyone", which would make
  -- the staff table a directory of the whole institution.
  r := public.add_class_member(v_class, 'latecomer@example.edu');
  IF NOT (r ->> 'added')::boolean THEN
    RAISE EXCEPTION 'adding a collaborator failed: %', r;
  END IF;

  -- Case and padding should not defeat it: this is typed by hand.
  PERFORM public.add_class_member(v_class, '  LATECOMER@example.edu  ');

  r := public.list_class_members(v_class);
  IF jsonb_array_length(r) <> 2 THEN
    RAISE EXCEPTION 'expected 2 members, found %', jsonb_array_length(r);
  END IF;

  -- Someone with no account cannot be added, and the error says why rather than
  -- failing silently.
  ok := false;
  BEGIN
    PERFORM public.add_class_member(v_class, 'nobody@example.edu');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a collaborator with no account was added';
  END IF;
END
$owner_shares$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- The collaborator has the same rights, and no more reach than the class
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

DO $collaborator$
DECLARE
  v_class uuid;
  n       bigint;
BEGIN
  SELECT id INTO v_class FROM public.classes WHERE code = 'ASSERT-008';
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'the shared class is not visible to the person it was shared with';
  END IF;

  -- No roles: a collaborator can do what the creator can.
  IF NOT public.can_manage_class(v_class) THEN
    RAISE EXCEPTION 'a collaborator was refused management rights';
  END IF;

  PERFORM public.update_class(v_class, p_name => 'Renamed by the collaborator');

  -- They can see the other member, because the collaborators list needs names.
  SELECT count(*) INTO n FROM public.staff;
  IF n <> 2 THEN
    RAISE EXCEPTION
      'a collaborator sees % staff rows; expected themselves and the one person '
      'they share a class with', n;
  END IF;

  -- But sharing one class does not reveal the other person's other classes.
  SELECT count(*) INTO n FROM public.classes WHERE code = 'ASSERT-008';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the collaborator sees % copies of the shared class', n;
  END IF;
  SELECT count(*) INTO n FROM public.classes;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'a collaborator on one class can see % classes in total', n;
  END IF;
END
$collaborator$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- A class can never be left with nobody
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $last_member$
DECLARE
  v_class uuid;
  v_me    uuid;
  v_them  uuid;
  r       jsonb;
  ok      boolean;
BEGIN
  SELECT id INTO v_class FROM public.classes WHERE code = 'ASSERT-008';
  v_me := public.current_staff_id();
  SELECT id INTO v_them FROM public.staff WHERE email = 'latecomer@example.edu';

  -- Removing one of two is fine.
  r := public.remove_class_member(v_class, v_them);
  IF NOT (r ->> 'removed')::boolean THEN
    RAISE EXCEPTION 'removing a collaborator failed: %', r;
  END IF;

  -- Removing the last one is refused. With no admin bypass, a class with no
  -- members is reachable only from the SQL editor.
  ok := false;
  BEGIN
    PERFORM public.remove_class_member(v_class, v_me);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'the last member removed themselves and stranded the class';
  END IF;

  IF jsonb_array_length(public.list_class_members(v_class)) <> 1 THEN
    RAISE EXCEPTION 'the class did not end up with exactly its creator';
  END IF;
END
$last_member$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- A non-member cannot touch membership, even holding the class id
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

DO $outsider$
DECLARE
  v_class uuid;
  ok      boolean;
BEGIN
  -- Removed above, so this account is no longer on the class. The id is passed
  -- in from a definer lookup, standing in for one kept from an old page.
  v_class := public.assert_class_id('ASSERT-008');
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'the test could not obtain a class id to probe with';
  END IF;

  -- The policy does hide it from an ordinary query...
  IF EXISTS (SELECT 1 FROM public.classes WHERE id = v_class) THEN
    RAISE EXCEPTION 'a removed member can still see the class';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.add_class_member(v_class, 'latecomer@example.edu');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member added themselves back to the class';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.list_class_members(v_class);
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member listed the members of a class';
  END IF;

  RAISE NOTICE '008 collaboration assertions passed';
END
$outsider$;

RESET ROLE;
RESET request.jwt.claim.sub;

ROLLBACK;
