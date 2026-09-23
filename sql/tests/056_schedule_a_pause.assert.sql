-- ============================================================================
-- Migration 056 — schedule a pause, and warn before it starts
--
-- The assertion that matters: a scheduled pause stops NOTHING until its time.
-- A warning that also blocks check-ins is not a warning, it is an outage with
-- extra steps — and it would be the easy mistake to make, because the row says
-- paused = true from the moment it is scheduled.
--
-- What is checked:
--
--   scheduling says "scheduled", and a student can still check in
--   once the start time passes, the same row refuses everything
--   an end time before the start is refused
--   resuming clears the schedule, so no stale start time fires later
--   the end time resumes nothing by itself
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('56000000-0000-0000-0000-000000000050', 'admin@assert-056.test',
   'Admin Person', 'approved', true)
ON CONFLICT (user_id) DO NOTHING;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  v_sess   uuid;
BEGIN
  v_class := (public.create_class('ASSERT-056', 'Scheduling a pause',
                CURRENT_DATE - 7, CURRENT_DATE + 28, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S056A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 7
   WHERE cohort_id = v_cohort;

  v_sess := (public.create_ad_hoc_session(
               v_cohort, CURRENT_DATE,
               (now() AT TIME ZONE 'Africa/Accra')::time) ->> 'session_id')::uuid;

  CREATE TEMP TABLE t056 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_sess AS session_id,
         (public.open_session(v_sess) ->> 'pin') AS pin;
END;
$setup$;

-- ------------------------------ a pause set for later stops nothing yet --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '56000000-0000-0000-0000-000000000050';

DO $schedule$
DECLARE v_state jsonb;
BEGIN
  v_state := public.admin_set_service_paused(
    true, 'Maintenance tonight', now() + INTERVAL '2 hours',
    now() + INTERVAL '3 hours');

  IF (v_state ->> 'state') <> 'scheduled' THEN
    RAISE EXCEPTION '056: a pause set for later reads as %', v_state ->> 'state';
  END IF;
  IF (v_state ->> 'paused')::boolean THEN
    RAISE EXCEPTION '056: a pause set for later reports itself as in force';
  END IF;

  RAISE NOTICE '056 ok: a pause set for later says so, and is not in force';
END;
$schedule$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $still_working$
DECLARE
  t     record;
  v_res jsonb;
BEGIN
  SELECT * INTO t FROM t056;

  -- The whole point: a warning must not be an outage.
  v_res := public.mark_attendance('S056A', t.pin);
  IF NOT (v_res ->> 'success')::boolean THEN
    RAISE EXCEPTION '056: a scheduled pause stopped a check-in before its time: %',
      v_res;
  END IF;
  DELETE FROM public.attendance_records WHERE session_id = t.session_id;

  RAISE NOTICE '056 ok: students can still check in while a pause is only scheduled';
END;
$still_working$;

-- ------------------------------------- once its time passes, it bites --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '56000000-0000-0000-0000-000000000050';

DO $arrives$
DECLARE v_state jsonb;
BEGIN
  -- The same row, one minute into the past rather than two hours ahead. No
  -- second switch is thrown: this is what the clock does on its own.
  v_state := public.admin_set_service_paused(
    true, 'Maintenance now', now() - INTERVAL '1 minute',
    now() + INTERVAL '1 hour');

  IF (v_state ->> 'state') <> 'paused' THEN
    RAISE EXCEPTION '056: a pause whose time has come reads as %',
      v_state ->> 'state';
  END IF;
  IF NOT (v_state ->> 'paused')::boolean THEN
    RAISE EXCEPTION '056: a started pause does not report itself as in force';
  END IF;

  RAISE NOTICE '056 ok: when the start time passes, the same row is in force';
END;
$arrives$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $now_refused$
DECLARE
  t     record;
  v_res jsonb;
  ok    boolean;
BEGIN
  SELECT * INTO t FROM t056;

  BEGIN
    v_res := public.mark_attendance('S056A', t.pin);
    ok := NOT (v_res ->> 'success')::boolean;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '056: a check-in went through after the pause had started';
  END IF;

  RAISE NOTICE '056 ok: after the start time, check-in is refused';
END;
$now_refused$;

-- ---------------------------- the times have to make sense, and resuming clears --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '56000000-0000-0000-0000-000000000050';

DO $sanity$
DECLARE
  v_state jsonb;
  ok      boolean;
BEGIN
  BEGIN
    PERFORM public.admin_set_service_paused(
      true, 'Backwards', now() + INTERVAL '2 hours', now() + INTERVAL '1 hour');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '056: the app was expected back before the pause started';
  END IF;

  -- Resuming has to clear the schedule. A start time left behind would pause
  -- the app again at an hour nobody remembers setting.
  v_state := public.admin_set_service_paused(false);
  IF (v_state ->> 'state') <> 'running' THEN
    RAISE EXCEPTION '056: after resuming the state is %', v_state ->> 'state';
  END IF;
  IF (v_state ->> 'starts_at') IS NOT NULL
     OR (v_state ->> 'ends_at') IS NOT NULL THEN
    RAISE EXCEPTION '056: resuming left a schedule behind: %', v_state;
  END IF;

  RAISE NOTICE '056 ok: impossible times are refused, and resuming clears the schedule';
END;
$sanity$;

-- --------------------------- an end time in the past resumes nothing --
DO $no_auto_resume$
DECLARE v_state jsonb;
BEGIN
  v_state := public.admin_set_service_paused(
    true, 'Overran', now() - INTERVAL '2 hours', now() - INTERVAL '1 hour');

  IF NOT (v_state ->> 'paused')::boolean THEN
    RAISE EXCEPTION
      '056: the app let itself back in when its end time passed — work overruns, and that would take check-ins into a database about to be replaced';
  END IF;

  PERFORM public.admin_set_service_paused(false);
  RAISE NOTICE '056 ok: a passed end time resumes nothing on its own';
END;
$no_auto_resume$;

ROLLBACK;
