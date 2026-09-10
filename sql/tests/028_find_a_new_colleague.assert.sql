-- ============================================================================
-- Migration 027 — a newly approved colleague can be found, and only them
--
-- The bug was a bootstrap: search returned only people you already shared a
-- class with, so somebody on no class was invisible to everybody, forever.
-- The first assertion is that exact person.
--
-- The rest is the boundary that replaced the old one. Widening a search is
-- easy to widen too far, and the cheap mistakes here are offering an account
-- that cannot actually be added, and letting somebody who does not run the
-- class run the search at all.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
  ON CONFLICT (domain) DO NOTHING;

  INSERT INTO auth.users (id, email) VALUES
    ('c8000000-0000-0000-0000-00000000000a', 'brand-new-028@example.edu'),
    ('c8000000-0000-0000-0000-00000000000b', 'still-waiting-028@example.edu'),
    ('c8000000-0000-0000-0000-00000000000c', 'turned-down-028@example.edu')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.staff (user_id, email, display_name, status) VALUES
    ('c8000000-0000-0000-0000-00000000000a', 'brand-new-028@example.edu',
     'Brand New', 'approved'),
    ('c8000000-0000-0000-0000-00000000000b', 'still-waiting-028@example.edu',
     'Still Waiting', 'pending'),
    ('c8000000-0000-0000-0000-00000000000c', 'turned-down-028@example.edu',
     'Turned Down', 'rejected')
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $search$
DECLARE
  v_class uuid;
  r       jsonb;
BEGIN
  v_class := (public.create_class('ASSERT-028', 'Finding People',
                CURRENT_DATE, CURRENT_DATE + 30) ->> 'class_id')::uuid;

  -- ==========================================================================
  -- THE BUG: somebody approved, on no class at all
  --
  -- Under the old rule this person shared a class with nobody and could never
  -- be returned — which made putting a new TA on their first class impossible
  -- without knowing their exact email.
  -- ==========================================================================
  r := public.search_addable_staff(v_class, 'brand-new');

  IF NOT (r::text LIKE '%brand-new-028@example.edu%') THEN
    RAISE EXCEPTION
      'a newly approved colleague on no class cannot be found — this is the '
      'bootstrap the migration exists to break: %', r;
  END IF;

  -- Found by name as well as address: somebody adding a colleague knows their
  -- name and often not their institutional email.
  r := public.search_addable_staff(v_class, 'Brand');
  IF NOT (r::text LIKE '%brand-new-028@example.edu%') THEN
    RAISE EXCEPTION 'searching by display name found nothing: %', r;
  END IF;

  -- ==========================================================================
  -- And they can then actually be added, by id, straight from the picker
  --
  -- The old add_class_member_by_id refused anybody the caller did not share a
  -- class with. Left alone, it would reject exactly the people search had just
  -- offered.
  -- ==========================================================================
  DECLARE
    v_id uuid;
    n    bigint;
  BEGIN
    SELECT (row ->> 'staff_id')::uuid INTO v_id
    FROM jsonb_array_elements(public.search_addable_staff(v_class, 'brand-new')) AS row
    LIMIT 1;

    PERFORM public.add_class_member_by_id(v_class, v_id);

    SELECT count(*) INTO n
    FROM public.class_staff WHERE class_id = v_class AND staff_id = v_id;

    IF n <> 1 THEN
      RAISE EXCEPTION
        'search offered somebody the picker could not add — the two rules have '
        'come apart';
    END IF;
  END;

  -- Once on the class they leave the picker: they belong in the members list.
  r := public.search_addable_staff(v_class, 'brand-new');
  IF r::text LIKE '%brand-new-028@example.edu%' THEN
    RAISE EXCEPTION 'somebody already on the class is still offered: %', r;
  END IF;

  -- ==========================================================================
  -- THE BOUNDARY: approved only
  --
  -- Offering an account that add_class_member will refuse is worse than not
  -- offering it — the failure lands after the click, blaming a rule the screen
  -- appeared not to have.
  -- ==========================================================================
  r := public.search_addable_staff(v_class, 'still-waiting');
  IF r::text LIKE '%still-waiting-028@example.edu%' THEN
    RAISE EXCEPTION 'a pending account was offered: %', r;
  END IF;

  r := public.search_addable_staff(v_class, 'turned-down');
  IF r::text LIKE '%turned-down-028@example.edu%' THEN
    RAISE EXCEPTION 'a rejected account was offered: %', r;
  END IF;

  -- Nor by id, for somebody who reads the pending list some other way.
  DECLARE failed boolean := false;
  BEGIN
    BEGIN
      PERFORM public.add_class_member_by_id(
        v_class,
        (SELECT id FROM public.staff WHERE email = 'still-waiting-028@example.edu'));
    EXCEPTION WHEN others THEN failed := true;
    END;

    IF NOT failed THEN
      RAISE EXCEPTION 'a pending account was added to a class by id';
    END IF;
  END;

  -- You are not offered yourself.
  r := public.search_addable_staff(v_class, 'ta.one');
  IF r::text LIKE '%ta.one@example.edu%' THEN
    RAISE EXCEPTION 'the caller was offered themselves: %', r;
  END IF;

  CREATE TEMP TABLE t028 ON COMMIT DROP AS SELECT v_class AS class_id;
END
$search$;

-- ----------------------------------------------------------------------------
-- Running the search still requires running the class
--
-- The widening is about WHO can be found, not about who may look. Without this
-- the search would be a staff directory for anybody with an account.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $outsider$
DECLARE
  v_class uuid := (SELECT class_id FROM t028);
  failed  boolean := false;
BEGIN
  BEGIN
    PERFORM public.search_addable_staff(v_class, 'brand');
  EXCEPTION WHEN others THEN failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      'somebody who does not manage this class ran its collaborator search';
  END IF;
END
$outsider$;

DO $done$ BEGIN RAISE NOTICE '028 colleague-search assertions passed'; END $done$;

ROLLBACK;
