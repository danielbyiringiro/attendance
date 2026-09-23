-- ============================================================================
-- Migration 055 — pause the app
--
-- The assertion that matters is the one a check inside mark_attendance would
-- fail: a pause has to stop EVERY way a mark can be written, not the student
-- one. So a check-in, a staff mark and a session edit are all tried while
-- paused.
--
-- And the one that stops a pause being a trap: an admin must still be able to
-- sign in and turn it off. ensure_staff writes a staff row on every sign-in, so
-- a pause that froze `staff` would lock out the person holding the switch.
--
-- TWO ROLES, ON PURPOSE
--
-- The admin pauses; the TA who owns the class does the writing. Asked as the
-- admin, every one of those writes fails for the wrong reason: they are not on
-- the class, so RLS hides its sessions and the row trigger reports the session
-- as missing. An assertion that cannot tell a pause from a permission is not
-- testing a pause.
--
-- The session starts NOW, so the check-in is refused by the pause and not by a
-- window that has not opened yet. The first version of this file put it
-- tomorrow, and the refusal it actually read was "check-in has not opened yet"
-- — which would have passed with the pause removed entirely. The unpaused
-- check-in below exists to keep that from coming back.
--
-- What is checked:
--
--   a fresh database is not paused, and the fixture can genuinely check in
--   only an admin can pause; an ordinary TA cannot
--   while paused: a check-in, a staff mark and a session edit all refuse
--   while paused: an admin can still sign in, so the switch stays reachable
--   the sweep stands down instead of raising every minute
--   resuming puts everything back
--   the switch is reached through its functions, not as a table
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- Seeded as superuser: staff_admin_writes refuses a self-promotion, and 021
-- sets the same fixture the same way.
INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('55000000-0000-0000-0000-000000000050', 'admin@assert-055.test',
   'Admin Person', 'approved', true),
  ('55000000-0000-0000-0000-000000000051', 'ta@assert-055.test',
   'Ordinary TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  v_sess   uuid;
  v_spare  uuid;
BEGIN
  v_class := (public.create_class('ASSERT-055', 'Pausing',
                CURRENT_DATE - 7, CURRENT_DATE + 28, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S055A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 7
   WHERE cohort_id = v_cohort;

  -- Starting now, in the class's own timezone, so check-in is genuinely open.
  v_sess := (public.create_ad_hoc_session(
               v_cohort, CURRENT_DATE,
               (now() AT TIME ZONE 'Africa/Accra')::time) ->> 'session_id')::uuid;

  -- Still 'scheduled', so the session edit below is refused by the pause and
  -- not by update_session's own rule that a session which has run cannot move.
  v_spare := (public.create_ad_hoc_session(v_cohort, CURRENT_DATE + 2, TIME '09:00')
              ->> 'session_id')::uuid;

  CREATE TEMP TABLE t055 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_sess AS session_id,
         v_spare AS spare_id,
         (public.open_session(v_sess) ->> 'pin') AS pin;
END;
$setup$;

-- ---------------------------- a fresh database runs free, and the fixture works --
DO $default_off$
DECLARE
  t     record;
  v_res jsonb;
BEGIN
  SELECT * INTO t FROM t055;

  IF (public.get_service_state() ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: a fresh database came up paused';
  END IF;

  v_res := public.mark_attendance('S055A', t.pin);
  IF NOT (v_res ->> 'success')::boolean THEN
    RAISE EXCEPTION
      '055: the fixture cannot check in even unpaused, so "refused while paused" would prove nothing: %',
      v_res;
  END IF;
  DELETE FROM public.attendance_records WHERE session_id = t.session_id;

  RAISE NOTICE '055 ok: not paused by default, and the fixture can check in';
END;
$default_off$;

-- ------------------------------------------------- only an admin may pause --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '55000000-0000-0000-0000-000000000051';

DO $not_admin$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.admin_set_service_paused(true, 'Nope');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '055: an ordinary TA paused the app';
  END IF;
  -- Through the reader the app uses: service_paused() is internal, called by
  -- the triggers as the owner and granted to nobody.
  IF (public.get_service_state() ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: the refused call paused it anyway';
  END IF;
  RAISE NOTICE '055 ok: an ordinary TA cannot pause the app';
END;
$not_admin$;

-- ---------------------------------- the admin pauses, and stays able to act --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '55000000-0000-0000-0000-000000000050';

DO $pause$
DECLARE v_state jsonb;
BEGIN
  v_state := public.admin_set_service_paused(true, 'Moving house');
  IF NOT (v_state ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: pausing did not take';
  END IF;
  IF (public.get_service_state() ->> 'message') <> 'Moving house' THEN
    RAISE EXCEPTION '055: the message was not kept';
  END IF;

  IF (public.ensure_staff('Admin Person') ->> 'status') <> 'approved' THEN
    RAISE EXCEPTION '055: an admin could not sign in while paused';
  END IF;

  RAISE NOTICE '055 ok: an admin pauses, and can still sign in afterwards';
END;
$pause$;

-- --------------------------------------------- paused: every writer refuses --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $paused$
DECLARE
  t       record;
  v_res   jsonb;
  ok      boolean;
  v_sweep jsonb;
  v_rows  integer;
BEGIN
  SELECT * INTO t FROM t055;

  -- 1. A student checking in: the one path a check inside mark_attendance
  --    would have covered.
  BEGIN
    v_res := public.mark_attendance('S055A', t.pin);
    ok := NOT (v_res ->> 'success')::boolean;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '055: a student checked in while the app was paused';
  END IF;

  SELECT count(*) INTO v_rows FROM public.attendance_records
   WHERE session_id = t.session_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '055: % attendance rows were written while paused', v_rows;
  END IF;

  -- 2. A TA marking by hand — a different path to the same table.
  BEGIN
    INSERT INTO public.attendance_records
      (session_id, class_id, student_id, state, marked_at, marked_by_role)
    VALUES (t.session_id, t.class_id, 'S055A', 'present', now(), 'staff');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '055: a staff mark was written while paused';
  END IF;

  -- 3. A session edit — a different table entirely.
  BEGIN
    PERFORM public.update_session(t.spare_id, NULL, TIME '14:00');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '055: a session was edited while paused';
  END IF;

  -- 4. The sweep stands down rather than raising once a minute for the length
  --    of the pause.
  v_sweep := public.sync_sessions();
  IF NOT (v_sweep ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: the sweep ran while paused: %', v_sweep;
  END IF;

  RAISE NOTICE '055 ok: while paused, every way of writing the record refuses';
END;
$paused$;

-- --------------------------------------------------- resuming puts it back --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '55000000-0000-0000-0000-000000000050';

DO $resume$
BEGIN
  IF (public.admin_set_service_paused(false) ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: resuming did not take';
  END IF;
  RAISE NOTICE '055 ok: resumed';
END;
$resume$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $after$
DECLARE
  t      record;
  v_rows integer;
BEGIN
  SELECT * INTO t FROM t055;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (t.session_id, t.class_id, 'S055A', 'present', now(), 'staff');

  SELECT count(*) INTO v_rows FROM public.attendance_records
   WHERE session_id = t.session_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '055: after resuming, a mark still did not land';
  END IF;

  IF (public.sync_sessions() ->> 'paused')::boolean THEN
    RAISE EXCEPTION '055: the sweep is still standing down after resuming';
  END IF;

  RAISE NOTICE '055 ok: after resuming, marks land and the sweep runs again';
END;
$after$;

-- ------------------------------- the switch is not reachable as a table --
-- 027's rule, applied to the new table: the functions are the only way in.
DO $no_table$
DECLARE v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.service_state;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION
      '055: a signed-in TA read % rows of service_state directly', v_rows;
  END IF;
  RAISE NOTICE '055 ok: the switch is reached through its functions, not the table';
END;
$no_table$;

ROLLBACK;
