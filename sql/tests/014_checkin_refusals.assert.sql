-- ============================================================================
-- Migration 014 — a check-in says what it safely can, and no more
--
-- The interesting assertions are the ones about what the endpoint REFUSES to
-- distinguish. A student ID is printed on a card; if the answer for "not
-- enrolled" differs from the answer for "no such student", anyone holding one
-- can find out who is in which class.
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
  v_class := (public.create_class('ASSERT-014', 'Refusals',
                CURRENT_DATE - 5, CURRENT_DATE + 30,
                'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S014-IN", "name": "Enrolled"}]'::jsonb);

  -- Exists in the registry, but not in this class.
  INSERT INTO public.students (student_id, cohort, name)
  VALUES ('S014-OUT', 'A', 'Elsewhere')
  ON CONFLICT (student_id) DO NOTHING;

  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE)::int)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE, CURRENT_DATE);

  SELECT id INTO v_session FROM public.class_sessions WHERE cohort_id = v_cohort;
  PERFORM public.open_session(v_session, 'ZZ999', 30);

  CREATE TEMP TABLE t014 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_session AS session_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- PIN-only failures are named
-- ----------------------------------------------------------------------------

DO $pin_only$
DECLARE r jsonb;
BEGIN
  r := public.mark_attendance('S014-IN', 'NOPE1');
  IF (r ->> 'reason') <> 'no_such_code' THEN
    RAISE EXCEPTION 'a code matching no open session was not named as such: %', r;
  END IF;

  -- The same answer for somebody who does not exist at all: this branch is
  -- decided before the student is ever looked at.
  IF (public.mark_attendance('WHO-EVER', 'NOPE1') ->> 'reason')
     <> 'no_such_code' THEN
    RAISE EXCEPTION 'the no-such-code answer depended on the student';
  END IF;
END
$pin_only$;

DO $window$
DECLARE
  v_session uuid := (SELECT session_id FROM t014);
  r jsonb;
BEGIN
  -- Opened well outside its own window.
  UPDATE public.class_sessions
     SET opened_at = now() - INTERVAL '10 hours'
   WHERE id = v_session;

  r := public.mark_attendance('S014-IN', 'ZZ999');
  IF (r ->> 'reason') <> 'window_closed' THEN
    RAISE EXCEPTION 'an expired window was not named as such: %', r;
  END IF;

  -- And it says the same to a stranger, because it is a fact about the
  -- session, not about them.
  IF (public.mark_attendance('S014-OUT', 'ZZ999') ->> 'reason')
     <> 'window_closed' THEN
    RAISE EXCEPTION 'the window-closed answer depended on the student';
  END IF;

  UPDATE public.class_sessions SET opened_at = now() WHERE id = v_session;
END
$window$;

-- ----------------------------------------------------------------------------
-- Student-dependent failures stay indistinguishable — the whole point
-- ----------------------------------------------------------------------------

DO $oracle$
DECLARE
  v_enrolled_elsewhere jsonb;
  v_no_such_student    jsonb;
BEGIN
  v_enrolled_elsewhere := public.mark_attendance('S014-OUT', 'ZZ999');
  v_no_such_student    := public.mark_attendance('NOBODY-AT-ALL', 'ZZ999');

  IF (v_enrolled_elsewhere ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student not enrolled in the class was let in';
  END IF;

  IF (v_enrolled_elsewhere ->> 'error') <> (v_no_such_student ->> 'error') THEN
    RAISE EXCEPTION
      'the endpoint is an enrolment oracle: "not enrolled" says % but "no such student" says %',
      v_enrolled_elsewhere ->> 'error', v_no_such_student ->> 'error';
  END IF;

  IF (v_enrolled_elsewhere ->> 'reason') <> (v_no_such_student ->> 'reason') THEN
    RAISE EXCEPTION
      'the reason code distinguishes an existing student from an invented one: % vs %',
      v_enrolled_elsewhere ->> 'reason', v_no_such_student ->> 'reason';
  END IF;
END
$oracle$;

-- ----------------------------------------------------------------------------
-- The happy path still works, and still refuses a second mark
-- ----------------------------------------------------------------------------

DO $happy$
DECLARE r jsonb;
BEGIN
  r := public.mark_attendance('S014-IN', 'zz999');   -- case-insensitive
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'an enrolled student with the right code was refused: %', r;
  END IF;
  IF (r ->> 'class') <> 'Refusals' THEN
    RAISE EXCEPTION 'the reply did not name the class: %', r;
  END IF;
  IF (r ->> 'state') <> 'present' THEN
    RAISE EXCEPTION 'a mark inside the late window was not present: %', r;
  END IF;

  r := public.mark_attendance('S014-IN', 'ZZ999');
  IF (r ->> 'reason') <> 'already_marked' THEN
    RAISE EXCEPTION 'a second mark was not refused: %', r;
  END IF;
END
$happy$;

-- ----------------------------------------------------------------------------
-- The legacy dual-write is gone
-- ----------------------------------------------------------------------------

DO $bridge$
BEGIN
  IF EXISTS (SELECT 1 FROM public.present_students WHERE student_id = 'S014-IN') THEN
    RAISE EXCEPTION
      'mark_attendance still dual-writes present_students; nothing reads it any more';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.attendance_records
    WHERE student_id = 'S014-IN' AND session_id = (SELECT session_id FROM t014)
  ) THEN
    RAISE EXCEPTION 'the real attendance record was not written';
  END IF;
END
$bridge$;

DO $done$ BEGIN RAISE NOTICE '014 refusal assertions passed'; END $done$;

ROLLBACK;
