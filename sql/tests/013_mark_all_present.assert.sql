-- ============================================================================
-- Migration 013 — marking everyone present, without trampling decisions
--
-- The button is easy. What matters is what it leaves alone: an excused absence
-- a TA granted, often with a reason, must not be quietly turned into
-- attendance because somebody pressed "mark all present" on the wrong row.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_session uuid;
BEGIN
  v_class := (public.create_class('ASSERT-013', 'Roll call',
                CURRENT_DATE - 20, CURRENT_DATE + 20,
                'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.upsert_enrolments(v_cohort, '[
    {"student_id": "R013-NONE",     "name": "No record"},
    {"student_id": "R013-ABSENT",   "name": "Marked absent"},
    {"student_id": "R013-EXCUSED",  "name": "Excused"},
    {"student_id": "R013-EXEMPT",   "name": "Exempt"},
    {"student_id": "R013-LATE",     "name": "Late"},
    {"student_id": "R013-PRESENT",  "name": "Already present"}]'::jsonb);

  -- Backdate so everyone counts as enrolled on a session held yesterday.
  UPDATE public.enrolments
     SET enrolled_on = CURRENT_DATE - 20
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE - 1)::int)::jsonb);

  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE - 8, CURRENT_DATE - 1);

  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
  ORDER BY session_date DESC LIMIT 1;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES
    (v_session, v_class, 'R013-ABSENT',  'unexcused', now(), 'system'),
    (v_session, v_class, 'R013-EXCUSED', 'excused',   now(), 'staff'),
    (v_session, v_class, 'R013-EXEMPT',  'exempted',  now(), 'staff'),
    (v_session, v_class, 'R013-LATE',    'late',      now(), 'student'),
    (v_session, v_class, 'R013-PRESENT', 'present',   now(), 'student');

  CREATE TEMP TABLE t013 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_session AS session_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- The default sweeps up "not accounted for" and nothing else
-- ----------------------------------------------------------------------------

DO $default$
DECLARE
  v_session uuid := (SELECT session_id FROM t013);
  v_result  jsonb;
  v_state   text;
BEGIN
  v_result := public.mark_all_present(v_session);

  IF (v_result ->> 'filled')::int <> 1 THEN
    RAISE EXCEPTION
      'expected to fill in exactly the student with no record, got %: %',
      v_result ->> 'filled', v_result;
  END IF;
  IF (v_result ->> 'changed')::int <> 1 THEN
    RAISE EXCEPTION
      'expected to change exactly the unexcused student, got %: %',
      v_result ->> 'changed', v_result;
  END IF;
  IF (v_result ->> 'roll')::int <> 6 THEN
    RAISE EXCEPTION 'the roll should be 6 students: %', v_result;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-NONE';
  IF v_state <> 'present' THEN
    RAISE EXCEPTION 'a student with no record was not marked present: %', v_state;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-ABSENT';
  IF v_state <> 'present' THEN
    RAISE EXCEPTION 'an unexcused student was not marked present: %', v_state;
  END IF;

  -- The three that must survive untouched.
  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-EXCUSED';
  IF v_state <> 'excused' THEN
    RAISE EXCEPTION
      'an excused absence was overwritten by mark_all_present: %', v_state;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-EXEMPT';
  IF v_state <> 'exempted' THEN
    RAISE EXCEPTION 'an exempted student was swept up: %', v_state;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-LATE';
  IF v_state <> 'late' THEN
    RAISE EXCEPTION
      'a late arrival was flattened to present, losing the more specific truth: %',
      v_state;
  END IF;
END
$default$;

-- ----------------------------------------------------------------------------
-- Every overwrite is logged, so a correction cannot be made invisibly
-- ----------------------------------------------------------------------------

DO $trail$
DECLARE
  v_session uuid := (SELECT session_id FROM t013);
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.attendance_corrections c
  JOIN public.attendance_records a ON a.id = c.record_id
  WHERE a.session_id = v_session
    AND a.student_id = 'R013-ABSENT'
    AND c.previous_state = 'unexcused'
    AND c.new_state = 'present';

  IF n = 0 THEN
    RAISE EXCEPTION
      'overwriting an absence left no correction record; the trigger was bypassed';
  END IF;
END
$trail$;

-- ----------------------------------------------------------------------------
-- p_overwrite takes late and excused too — but never exempted
-- ----------------------------------------------------------------------------

DO $overwrite$
DECLARE
  v_session uuid := (SELECT session_id FROM t013);
  v_state   text;
BEGIN
  PERFORM public.mark_all_present(v_session, 'present', true);

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-EXCUSED';
  IF v_state <> 'present' THEN
    RAISE EXCEPTION 'p_overwrite did not replace an excused absence: %', v_state;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-LATE';
  IF v_state <> 'present' THEN
    RAISE EXCEPTION 'p_overwrite did not replace a late mark: %', v_state;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = v_session AND student_id = 'R013-EXEMPT';
  IF v_state <> 'exempted' THEN
    RAISE EXCEPTION
      'p_overwrite swept up an exempted student; the session does not apply to them: %',
      v_state;
  END IF;
END
$overwrite$;

-- ----------------------------------------------------------------------------
-- A scheduled session is closed, so the marks actually count
-- ----------------------------------------------------------------------------

DO $closes$
DECLARE
  v_class   uuid := (SELECT class_id FROM t013);
  v_cohort  uuid := (SELECT cohort_id FROM t013);
  v_session uuid;
  v_status  text;
BEGIN
  SELECT id, status INTO v_session, v_status
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND status = 'scheduled'
  ORDER BY session_date LIMIT 1;

  IF v_session IS NULL THEN
    RAISE EXCEPTION 'the fixture has no scheduled session to test with';
  END IF;

  PERFORM public.mark_all_present(v_session);

  SELECT status INTO v_status
  FROM public.class_sessions WHERE id = v_session;

  IF v_status <> 'closed' THEN
    RAISE EXCEPTION
      'a scheduled session stayed % after marking everyone present, so the marks are excluded from every count',
      v_status;
  END IF;

  -- And nobody was recorded absent on the way through.
  IF EXISTS (
    SELECT 1 FROM public.attendance_records
    WHERE session_id = v_session AND state = 'unexcused'
  ) THEN
    RAISE EXCEPTION 'closing after marking everyone present still wrote absences';
  END IF;
END
$closes$;

-- ----------------------------------------------------------------------------
-- Refusals
-- ----------------------------------------------------------------------------

DO $refusals$
DECLARE
  v_cohort  uuid := (SELECT cohort_id FROM t013);
  v_session uuid;
  v_msg     text;
BEGIN
  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
  ORDER BY session_date LIMIT 1;

  PERFORM public.cancel_session(v_session, 'Public holiday');

  BEGIN
    PERFORM public.mark_all_present(v_session);
    RAISE EXCEPTION 'marked everyone present at a cancelled session';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'marked everyone present at a cancelled session' THEN
      RAISE;
    END IF;
  END;

  IF (SELECT status FROM public.class_sessions WHERE id = v_session) <> 'cancelled' THEN
    RAISE EXCEPTION 'the refusal still reopened the cancelled session';
  END IF;
END
$refusals$;

DO $done$ BEGIN RAISE NOTICE '013 mark-all-present assertions passed'; END $done$;

ROLLBACK;
