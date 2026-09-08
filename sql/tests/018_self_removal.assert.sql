-- ============================================================================
-- Migration 018 — losing your own access has to be deliberate
--
-- The failure this closes is quiet: you aim at a collaborator, the list has
-- reordered under you, and you remove yourself instead. With no admin bypass
-- there is no way back except another member or the SQL editor.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('77777777-7777-7777-7777-777777777777', 'aaa-sorts-first@example.edu')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.staff (user_id, email, display_name) VALUES
    ('77777777-7777-7777-7777-777777777777', 'aaa-sorts-first@example.edu', 'Early Alphabet')
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE v_class uuid;
BEGIN
  v_class := (public.create_class('ASSERT-018', 'Membership',
                CURRENT_DATE, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  CREATE TEMP TABLE t018 ON COMMIT DROP AS SELECT v_class AS class_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- Alone on the class: you cannot remove yourself at all, confirmed or not
-- ----------------------------------------------------------------------------

DO $alone$
DECLARE
  v_class uuid := (SELECT class_id FROM t018);
  v_me    uuid := public.current_staff_id();
  v_msg   text;
BEGIN
  BEGIN
    PERFORM public.remove_class_member(v_class, v_me, true);
    RAISE EXCEPTION 'the last member removed themselves, orphaning the class';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'the last member removed themselves, orphaning the class' THEN
      RAISE;
    END IF;
  END;

  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'the refused removal still took away access';
  END IF;
END
$alone$;

-- ----------------------------------------------------------------------------
-- With a collaborator, an unconfirmed self-removal is still refused
--
-- This is the mis-click: the collaborator's email sorts before yours, so the
-- list reorders the moment it reloads.
-- ----------------------------------------------------------------------------

DO $misclick$
DECLARE
  v_class uuid := (SELECT class_id FROM t018);
  v_me    uuid := public.current_staff_id();
  v_msg   text;
BEGIN
  PERFORM public.add_class_member(v_class, 'aaa-sorts-first@example.edu');

  BEGIN
    PERFORM public.remove_class_member(v_class, v_me);
    RAISE EXCEPTION 'an unconfirmed self-removal went through';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'an unconfirmed self-removal went through' THEN
      RAISE;
    END IF;
  END;

  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'the refused self-removal still took away access';
  END IF;
END
$misclick$;

-- ----------------------------------------------------------------------------
-- You are first in the list, so your row does not move when somebody is added
-- ----------------------------------------------------------------------------

DO $ordering$
DECLARE
  v_class uuid := (SELECT class_id FROM t018);
  v_first jsonb;
BEGIN
  v_first := public.list_class_members(v_class) -> 0;

  IF NOT (v_first ->> 'is_you')::boolean THEN
    RAISE EXCEPTION
      'the list does not put you first, so adding somebody whose email sorts '
      'earlier moves your row: %', v_first;
  END IF;
END
$ordering$;

-- ----------------------------------------------------------------------------
-- Removing somebody else is unaffected, and a confirmed departure works
-- ----------------------------------------------------------------------------

DO $deliberate$
DECLARE
  v_class uuid := (SELECT class_id FROM t018);
  v_me    uuid := public.current_staff_id();
  v_other uuid;
  r       jsonb;
BEGIN
  SELECT s.id INTO v_other
  FROM public.staff s WHERE s.email = 'aaa-sorts-first@example.edu';

  -- Somebody else: no confirmation needed.
  r := public.remove_class_member(v_class, v_other);
  IF NOT (r ->> 'removed')::boolean THEN
    RAISE EXCEPTION 'removing a collaborator was refused: %', r;
  END IF;
  IF (r ->> 'was_self')::boolean THEN
    RAISE EXCEPTION 'removing somebody else reported itself as a self-removal';
  END IF;

  -- Back to one member, so leaving is refused again for the other reason.
  PERFORM public.add_class_member(v_class, 'aaa-sorts-first@example.edu');

  -- Now deliberate, and allowed.
  r := public.remove_class_member(v_class, v_me, true);
  IF NOT (r ->> 'removed')::boolean THEN
    RAISE EXCEPTION 'a confirmed departure was refused: %', r;
  END IF;
  IF NOT (r ->> 'was_self')::boolean THEN
    RAISE EXCEPTION 'a self-removal did not report itself as one: %', r;
  END IF;

  IF public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'leaving the class did not actually remove access';
  END IF;
END
$deliberate$;

DO $done$ BEGIN RAISE NOTICE '018 self-removal assertions passed'; END $done$;

ROLLBACK;
