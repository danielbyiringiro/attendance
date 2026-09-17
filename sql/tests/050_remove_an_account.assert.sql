-- ============================================================================
-- Migration 050 — removing an account
--
-- Four accounts, seeded on ids nobody else in the suite uses:
--
--   admin      does the deleting
--   rejected   the case this exists for — a student who signed up
--   owner      approved, and on a class, so deleting them would strip it
--   ordinary   approved, on nothing, and not an admin
--
-- What is checked:
--
--   an ordinary account cannot delete anybody
--   an admin cannot delete themselves
--   an admin cannot delete somebody who still manages a class
--   a rejected account goes, and its announcement reads go with it
--   what they posted stays, holding no author
--   deleting does not stop them coming back — ensure_staff makes a new row
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('50000000-0000-0000-0000-000000000050', 'admin@assert-050.test',
   'Admin Person', 'approved', true),
  ('50000000-0000-0000-0000-000000000051', 'student@assert-050.test',
   'Hopeful Student', 'rejected', false),
  ('50000000-0000-0000-0000-000000000052', 'owner@assert-050.test',
   'Class Owner', 'approved', false),
  ('50000000-0000-0000-0000-000000000053', 'ordinary@assert-050.test',
   'Ordinary Person', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

-- The class the owner manages, built here rather than inside a role-scoped
-- block. 007 seeds its permission fixture the same way: class_staff is written
-- under RLS in the app, and a test that trips over that is testing the fixture
-- rather than the thing it came to check.
-- WHERE NOT EXISTS rather than ON CONFLICT: classes has no unique CONSTRAINT
-- on code, it has a unique expression INDEX on lower(btrim(code)) (001), which
-- ON CONFLICT (code) does not match.
INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
SELECT 'ASSERT-050', 'Owned', CURRENT_DATE - 10, CURRENT_DATE + 40
WHERE NOT EXISTS (
  SELECT 1 FROM public.classes WHERE lower(btrim(code)) = 'assert-050');

INSERT INTO public.class_staff (class_id, staff_id, role)
SELECT k.id, s.id, 'owner'
FROM public.classes k, public.staff s
WHERE k.code = 'ASSERT-050' AND s.email = 'owner@assert-050.test'
ON CONFLICT (class_id, staff_id) DO NOTHING;

DO $ids$
BEGIN
  PERFORM set_config('t050.admin',
    (SELECT id::text FROM public.staff WHERE email = 'admin@assert-050.test'), true);
  PERFORM set_config('t050.student',
    (SELECT id::text FROM public.staff WHERE email = 'student@assert-050.test'), true);
  PERFORM set_config('t050.owner',
    (SELECT id::text FROM public.staff WHERE email = 'owner@assert-050.test'), true);
  PERFORM set_config('t050.ordinary',
    (SELECT id::text FROM public.staff WHERE email = 'ordinary@assert-050.test'), true);
END;
$ids$;

-- ----------------------------------------------------------------------------
-- An ordinary account cannot remove anybody
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '50000000-0000-0000-0000-000000000053';

DO $not_admin$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.admin_delete_staff(current_setting('t050.student')::uuid);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '050: an ordinary account deleted somebody';
  END IF;

  -- As superuser. staff_select is (user_id = auth.uid() OR is_admin()), so
  -- asked as this account the row is invisible whether or not it still exists
  -- — the check would fail even on a correct refusal, which is what it did.
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.staff
                  WHERE id = current_setting('t050.student')::uuid) THEN
    RAISE EXCEPTION '050: the refused call deleted the account anyway';
  END IF;
  SET ROLE authenticated;

  RAISE NOTICE '050 ok: only an admin may remove an account';
END;
$not_admin$;

-- ----------------------------------------------------------------------------
-- The admin, and the two refusals
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '50000000-0000-0000-0000-000000000050';

DO $refusals$
DECLARE
  ok boolean;
BEGIN
  -- Themselves.
  BEGIN
    PERFORM public.admin_delete_staff(current_setting('t050.admin')::uuid);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '050: an admin deleted their own account';
  END IF;

  -- Somebody who still manages a class, seeded at the top. class_staff
  -- cascades, so deleting them would quietly take a member off that class.
  BEGIN
    PERFORM public.admin_delete_staff(current_setting('t050.owner')::uuid);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '050: an admin deleted somebody who still manages a class';
  END IF;

  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.class_staff
                  WHERE staff_id = current_setting('t050.owner')::uuid) THEN
    RAISE EXCEPTION '050: the refused delete stripped the class anyway';
  END IF;
  SET ROLE authenticated;

  RAISE NOTICE '050 ok: an admin cannot delete themselves, or somebody who still holds a class';
END;
$refusals$;

-- ----------------------------------------------------------------------------
-- The case this exists for
-- ----------------------------------------------------------------------------

DO $deletes$
DECLARE
  v_note   uuid;
  v_result jsonb;
BEGIN
  -- Something of theirs that must go, and something that must not. 049 holds
  -- announcements by SET NULL and reads by CASCADE.
  v_note := (public.admin_post_announcement('Term starts', 'Sessions are up.')).id;

  -- As superuser: announcement_reads_own is WITH CHECK (staff_id =
  -- current_staff_id()), so an admin cannot record a read on somebody else's
  -- behalf — correctly. The fixture needs the row, not the permission.
  RESET ROLE;
  INSERT INTO public.announcement_reads (announcement_id, staff_id)
  VALUES (v_note, current_setting('t050.student')::uuid);
  SET ROLE authenticated;

  v_result := public.admin_delete_staff(current_setting('t050.student')::uuid);

  IF NOT (v_result ->> 'deleted')::boolean THEN
    RAISE EXCEPTION '050: the delete reported failure: %', v_result;
  END IF;

  IF EXISTS (SELECT 1 FROM public.staff
              WHERE id = current_setting('t050.student')::uuid) THEN
    RAISE EXCEPTION '050: the account is still there';
  END IF;

  -- As superuser, for the reason above: announcement_reads_own hides another
  -- account's rows, so asked as the admin this could never fail.
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.announcement_reads
              WHERE staff_id = current_setting('t050.student')::uuid) THEN
    RAISE EXCEPTION '050: their read rows outlived the account';
  END IF;
  SET ROLE authenticated;

  -- The announcement was posted by the admin, not the student, but the point
  -- stands either way: content survives its author.
  IF NOT EXISTS (SELECT 1 FROM public.announcements WHERE id = v_note) THEN
    RAISE EXCEPTION '050: deleting an account took an announcement with it';
  END IF;

  RAISE NOTICE '050 ok: a rejected account goes, its read rows go, and what was posted stays';
END;
$deletes$;

-- ----------------------------------------------------------------------------
-- And they can come back, which is the accepted cost of not keeping a list
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '50000000-0000-0000-0000-000000000051';

DO $they_return$
DECLARE
  r jsonb;
BEGIN
  -- ensure_staff needs an auth.users row to read an email from; the shim's
  -- auth.uid() is the GUC above, and 020 tolerates a missing email.
  r := public.ensure_staff('Hopeful Student');

  IF (r ->> 'status') = 'domain_not_allowed' THEN
    RAISE NOTICE '050 ok: they came back to a closed door, because their domain is not accepted';
  ELSIF (r ->> 'status') <> 'pending' THEN
    RAISE EXCEPTION '050: a deleted account came back as %, expected pending — '
      'delete is housekeeping, not a block, and the test should say so',
      r ->> 'status';
  ELSE
    RAISE NOTICE '050 ok: a deleted account returns as pending — housekeeping, not a wall';
  END IF;
END;
$they_return$;

ROLLBACK;
