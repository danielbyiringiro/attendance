-- ============================================================================
-- Migration 009 — colleague search stays inside your circle
--
-- The convenience is easy; the boundary is the part worth testing. Search must
-- reach the people you already work with and nobody else, or it becomes the
-- directory of every account that 008 deliberately refused to build.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('44444444-4444-4444-4444-444444444444', 'colleague@example.edu'),
    ('55555555-5555-5555-5555-555555555555', 'stranger@example.edu')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.staff (user_id, email, display_name, status) VALUES
    ('44444444-4444-4444-4444-444444444444', 'colleague@example.edu', 'Chidi Colleague', 'approved'),
    ('55555555-5555-5555-5555-555555555555', 'stranger@example.edu',  'Sam Stranger', 'approved')
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

-- ----------------------------------------------------------------------------
-- Staff two runs two classes and shares one of them with the colleague
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_shared uuid;
  v_solo   uuid;
BEGIN
  v_shared := (public.create_class('ASSERT-009-SHARED', 'Shared',
                 DATE '2026-05-18', DATE '2026-08-28') ->> 'class_id')::uuid;
  v_solo   := (public.create_class('ASSERT-009-SOLO', 'Solo',
                 DATE '2026-05-18', DATE '2026-08-28') ->> 'class_id')::uuid;

  PERFORM public.add_class_member(v_shared, 'colleague@example.edu');
END
$setup$;

DO $search$
DECLARE
  v_shared uuid;
  v_solo   uuid;
  r        jsonb;
  ok       boolean;
BEGIN
  SELECT id INTO v_shared FROM public.classes WHERE code = 'ASSERT-009-SHARED';
  SELECT id INTO v_solo   FROM public.classes WHERE code = 'ASSERT-009-SOLO';

  -- Searching the class they are NOT on finds the colleague, because we already
  -- share the other class with them. That is the whole point of the feature.
  r := public.search_addable_staff(v_solo, 'colle');
  IF jsonb_array_length(r) <> 1 THEN
    RAISE EXCEPTION 'expected to find 1 colleague, found %: %',
      jsonb_array_length(r), r;
  END IF;
  IF r -> 0 ->> 'email' <> 'colleague@example.edu' THEN
    RAISE EXCEPTION 'found the wrong person: %', r -> 0;
  END IF;

  -- Display name is searchable too, not just the address.
  r := public.search_addable_staff(v_solo, 'chidi');
  IF jsonb_array_length(r) <> 1 THEN
    RAISE EXCEPTION 'searching by display name found %', jsonb_array_length(r);
  END IF;

  -- Someone we have never worked with is NOT findable, by name or by email.
  -- Without this the picker becomes a directory of every account.
  r := public.search_addable_staff(v_solo, 'stranger');
  IF jsonb_array_length(r) <> 0 THEN
    RAISE EXCEPTION 'search reached someone outside our shared classes: %', r;
  END IF;

  r := public.search_addable_staff(v_solo, 'sam');
  IF jsonb_array_length(r) <> 0 THEN
    RAISE EXCEPTION 'search reached a stranger by display name: %', r;
  END IF;

  -- An empty query browses the whole circle. That is more than one person here:
  -- the 008 rescue put every bootstrapped account on the backfilled class
  -- together, so they are all colleagues of each other. Asserting membership
  -- rather than a count, because the size depends on that topology while the
  -- boundary does not.
  r := public.search_addable_staff(v_solo, '');
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r) e
    WHERE e ->> 'email' = 'colleague@example.edu')
  THEN
    RAISE EXCEPTION 'browsing did not include a colleague we share a class with: %', r;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(r) e
    WHERE e ->> 'email' = 'stranger@example.edu')
  THEN
    RAISE EXCEPTION 'browsing reached someone outside our shared classes: %', r;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(r) e
    WHERE e ->> 'email' = 'ta.two@example.edu')
  THEN
    RAISE EXCEPTION 'browsing offered the caller themselves: %', r;
  END IF;

  -- People already on the class belong in the members list, not the picker.
  r := public.search_addable_staff(v_shared, 'colle');
  IF jsonb_array_length(r) <> 0 THEN
    RAISE EXCEPTION 'search offered someone already on the class';
  END IF;

  -- You never appear in your own picker.
  r := public.search_addable_staff(v_solo, 'ta.two');
  IF jsonb_array_length(r) <> 0 THEN
    RAISE EXCEPTION 'search offered the caller themselves';
  END IF;

  -- Picking by id is held to the same rule as searching. Otherwise the id alone
  -- would be enough to add anybody, and the boundary comes back through a side
  -- door.
  ok := false;
  BEGIN
    PERFORM public.add_class_member_by_id(
      v_solo, (SELECT id FROM public.staff WHERE email = 'stranger@example.edu'));
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a stranger was added by id without ever being findable';
  END IF;

  -- The colleague can be added by id, since we do share a class.
  PERFORM public.add_class_member_by_id(
    v_solo, (SELECT id FROM public.staff WHERE email = 'colleague@example.edu'));

  IF jsonb_array_length(public.list_class_members(v_solo)) <> 2 THEN
    RAISE EXCEPTION 'adding the colleague by id did not take';
  END IF;

  -- A full email still reaches anyone, which reveals nothing the caller did not
  -- already know.
  PERFORM public.add_class_member(v_solo, 'stranger@example.edu');
  IF jsonb_array_length(public.list_class_members(v_solo)) <> 3 THEN
    RAISE EXCEPTION 'an exact email could not add someone outside the circle';
  END IF;
END
$search$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- A non-member cannot search a class at all
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

DO $outsider$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    PERFORM public.search_addable_staff(
      (SELECT id FROM public.classes WHERE code = 'ASSERT-009-SOLO'), 'a');
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member searched a class they cannot reach';
  END IF;

  RAISE NOTICE '009 search assertions passed';
END
$outsider$;

RESET ROLE;
RESET request.jwt.claim.sub;

ROLLBACK;
