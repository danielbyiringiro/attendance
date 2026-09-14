-- ============================================================================
-- Migration 044 — a check-in records who made it; the display counts them
--
-- Three students on one open session:
--
--   S044-NEW     no row yet            checks in    -> inserted as 'student'
--   S044-OVER    a 'system' absence    checks in    -> must become 'student'
--   S044-STAFF   marked present by a TA              -> stays 'staff', not counted
--
-- S044-OVER is the case that was wrong: the update kept 'system', so a real
-- check-in was stored as a decision nobody made. The display count must then be
-- two, not three — a TA's mark is not a check-in arriving.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_session uuid;
  r         jsonb;
BEGIN
  v_class := (public.create_class('ASSERT-044', 'Beep',
                CURRENT_DATE - 7, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S044-NEW",   "name": "New"},
      {"student_id": "S044-OVER",  "name": "Over"},
      {"student_id": "S044-STAFF", "name": "Staff"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 7
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE)::int)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE, CURRENT_DATE);
  SELECT id INTO v_session FROM public.class_sessions WHERE cohort_id = v_cohort LIMIT 1;

  PERFORM public.open_session(v_session, 'B44PIN', 60);

  -- An absence the system wrote, as close_session does, before the reopen.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_session, v_class, 'S044-OVER', 'unexcused', now(), 'system');

  -- A TA marking somebody present by hand.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_session, v_class, 'S044-STAFF', 'present', now(), 'staff');

  r := public.issue_display_code(v_class);

  PERFORM set_config('t044.session', v_session::text, true);
  PERFORM set_config('t044.token',   r ->> 'token',   true);
  PERFORM set_config('t044.code',    r ->> 'code',    true);
END;
$setup$;

RESET ROLE;
SET ROLE anon;

DO $check_ins$
DECLARE r jsonb;
BEGIN
  r := public.mark_attendance('S044-NEW', 'B44PIN');
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION '044 setup: a fresh check-in failed: %', r;
  END IF;

  r := public.mark_attendance('S044-OVER', 'B44PIN');
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION '044 setup: checking in over a system absence failed: %', r;
  END IF;
END;
$check_ins$;

RESET ROLE;

-- ------------------------------------------------------------ provenance --
DO $provenance$
DECLARE
  v_session uuid := current_setting('t044.session')::uuid;
  v_role    text;
  v_state   public.attendance_state;
BEGIN
  SELECT marked_by_role INTO v_role FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'S044-NEW';
  IF v_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION '044: a fresh check-in is stored as %, not student', v_role;
  END IF;

  SELECT marked_by_role, state INTO v_role, v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'S044-OVER';
  IF v_state NOT IN ('present', 'late') THEN
    RAISE EXCEPTION '044: the check-in over a system absence did not change the state (%)', v_state;
  END IF;
  IF v_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION '044: a student who checked in over an absence is stored as marked by %, '
      'as if nobody had looked', v_role;
  END IF;

  SELECT marked_by_role INTO v_role FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'S044-STAFF';
  IF v_role IS DISTINCT FROM 'staff' THEN
    RAISE EXCEPTION '044: a TA''s own mark changed provenance to %', v_role;
  END IF;

  RAISE NOTICE '044 ok: every check-in is stored as the student''s, and a TA''s mark stays the TA''s';
END;
$provenance$;

-- -------------------------------------------------------- display count --
SET ROLE anon;

DO $display$
DECLARE
  r         jsonb;
  v_checked integer;
BEGIN
  r := public.get_class_display(current_setting('t044.token'), current_setting('t044.code'));
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '044 setup: the display refused its own link: %', r;
  END IF;

  SELECT (s ->> 'checked_in')::integer INTO v_checked
  FROM jsonb_array_elements(r -> 'sessions') AS s
  WHERE s ->> 'id' = current_setting('t044.session');

  IF v_checked IS NULL THEN
    RAISE EXCEPTION '044: the display''s session carries no checked_in count: %', r -> 'sessions';
  END IF;

  IF v_checked <> 2 THEN
    RAISE EXCEPTION '044: the display counts % check-ins, not the 2 students who checked in '
      '(a TA''s mark is not one)', v_checked;
  END IF;

  RAISE NOTICE '044 ok: the display counts the two check-ins and not the TA''s mark';
END;
$display$;

ROLLBACK;
