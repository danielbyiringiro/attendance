-- ============================================================================
-- Migration 009 — colleague search stays inside your circle
--
-- The convenience is easy; the boundary is the part worth testing. Search must
-- reach the people you already work with and nobody else, or it becomes the
-- directory of every account that 008 deliberately refused to build.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

-- NOTE: the search half of this file was rewritten by migration 027. It used
-- to assert that search reached only people you already shared a class with;
-- it now asserts the opposite, because that rule could not survive its own
-- bootstrap. The reasoning is at each assertion rather than only here.

BEGIN;

DO $seed$
BEGIN
  -- 022 refuses an auth account whose domain is not on the list, so a
  -- fixture has to declare the domain it invents people in.
  INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
  ON CONFLICT (domain) DO NOTHING;

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

  -- Somebody we have never worked with IS findable, as of migration 027.
  --
  -- This assertion used to say the opposite, and it was right at the time: 009
  -- kept the picker from becoming a directory of every account. What that rule
  -- could not survive was its own bootstrap — a newly approved colleague is on
  -- no class, so they shared one with nobody and could never be found by
  -- anyone, which made putting a new TA on their first class impossible
  -- without knowing their exact address.
  --
  -- The trade is deliberate: every row in `staff` is an account on an allowed
  -- institutional domain that an admin has since approved, so this says roughly
  -- what a departmental directory says. What replaced the old boundary is
  -- asserted below and in 028 — approved only, never yourself, never somebody
  -- already on the class, and you must manage the class to search it at all.
  r := public.search_addable_staff(v_solo, 'stranger');
  IF jsonb_array_length(r) <> 1 THEN
    RAISE EXCEPTION
      'an approved colleague on no shared class was not findable, which is the '
      'bootstrap 027 exists to break: %', r;
  END IF;

  r := public.search_addable_staff(v_solo, 'sam');
  IF jsonb_array_length(r) <> 1 THEN
    RAISE EXCEPTION 'the same person was not findable by display name: %', r;
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
  -- Browsing now reaches every approved colleague, for the same reason.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r) e
    WHERE e ->> 'email' = 'stranger@example.edu')
  THEN
    RAISE EXCEPTION 'browsing did not include an approved colleague: %', r;
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

  -- Picking by id is held to the same rule as searching, which is the point of
  -- 027 changing both together: search offering somebody the picker then
  -- refuses is worse than not offering them, because the failure lands after
  -- the click and blames a rule the screen appeared not to have.
  PERFORM public.add_class_member_by_id(
    v_solo, (SELECT id FROM public.staff WHERE email = 'colleague@example.edu'));

  IF jsonb_array_length(public.list_class_members(v_solo)) <> 2 THEN
    RAISE EXCEPTION 'adding the colleague by id did not take';
  END IF;

  -- Including somebody we share no class with, who search now returns.
  --
  -- The id comes out of the search result rather than a direct SELECT: RLS on
  -- `staff` is still shares_a_class_with(), so this caller cannot read that row
  -- from the table at all. search_addable_staff is SECURITY DEFINER and can.
  -- The UI is in the same position, which is why the picker passes an id it was
  -- given rather than one it looked up.
  DECLARE v_stranger uuid;
  BEGIN
    SELECT (row ->> 'staff_id')::uuid INTO v_stranger
    FROM jsonb_array_elements(public.search_addable_staff(v_solo, 'stranger')) AS row
    LIMIT 1;

    IF v_stranger IS NULL THEN
      RAISE EXCEPTION 'search did not carry the id of the person it offered';
    END IF;

    PERFORM public.add_class_member_by_id(v_solo, v_stranger);
  END;

  IF jsonb_array_length(public.list_class_members(v_solo)) <> 3 THEN
    RAISE EXCEPTION
      'search offered somebody the picker would not add — the two rules have '
      'come apart';
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
