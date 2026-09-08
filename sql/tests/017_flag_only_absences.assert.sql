-- ============================================================================
-- Migration 017 — only an absence can be disputed
--
-- The rule is enforced in the database, not the browser: flag_attendance is
-- granted to anon, so a hidden button is not a rule. These assertions call the
-- RPC directly, the way anything bypassing the UI would.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  v_sess   uuid;
BEGIN
  v_class := (public.create_class('ASSERT-017', 'Disputes',
                CURRENT_DATE - 10, CURRENT_DATE + 20,
                'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.upsert_enrolments(v_cohort, '[
    {"student_id": "D017-PRESENT", "name": "Was There"},
    {"student_id": "D017-LATE",    "name": "Was Late"},
    {"student_id": "D017-EXCUSED", "name": "Was Excused"},
    {"student_id": "D017-ABSENT",  "name": "Was Absent"},
    {"student_id": "D017-NOROW",   "name": "No Record"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 10
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE - 3)::int)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE - 3, CURRENT_DATE - 3);

  SELECT id INTO v_sess FROM public.class_sessions WHERE cohort_id = v_cohort;
  UPDATE public.class_sessions SET status = 'closed' WHERE id = v_sess;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES
    (v_sess, v_class, 'D017-PRESENT', 'present',   now(), 'student'),
    (v_sess, v_class, 'D017-LATE',    'late',      now(), 'student'),
    (v_sess, v_class, 'D017-EXCUSED', 'excused',   now(), 'staff'),
    (v_sess, v_class, 'D017-ABSENT',  'unexcused', now(), 'system');

  CREATE TEMP TABLE t017 ON COMMIT DROP AS SELECT v_sess AS session_id;
END
$setup$;

DO $rules$
DECLARE
  v_sess uuid := (SELECT session_id FROM t017);
  n      integer;
  r      jsonb;
BEGIN
  -- Present: nothing to dispute.
  r := public.flag_attendance('D017-PRESENT', v_sess);
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked PRESENT was allowed to dispute the session';
  END IF;
  IF (r ->> 'error') <> 'already_present' THEN
    RAISE EXCEPTION 'unexpected refusal for a present student: %', r;
  END IF;

  -- Late still counts as attendance.
  r := public.flag_attendance('D017-LATE', v_sess);
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked LATE was allowed to dispute the session';
  END IF;

  -- Excused is a decision a TA made, not an absence to argue with.
  r := public.flag_attendance('D017-EXCUSED', v_sess);
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked EXCUSED was allowed to dispute the session';
  END IF;
  IF (r ->> 'error') <> 'not_an_absence' THEN
    RAISE EXCEPTION 'unexpected refusal for an excused student: %', r;
  END IF;

  -- An absence is exactly what a dispute is for.
  r := public.flag_attendance('D017-ABSENT', v_sess);
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked ABSENT could not dispute it: %', r;
  END IF;

  -- And a session with no record at all — the case a dispute exists to surface.
  r := public.flag_attendance('D017-NOROW', v_sess);
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student with no record could not raise a dispute: %', r;
  END IF;

  -- Exactly two flags, and only the two that should be there.
  SELECT count(*) INTO n FROM public.flagged WHERE session_id = v_sess;
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 flags on the session, found %', n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.flagged
    WHERE session_id = v_sess
      AND student_id IN ('D017-PRESENT', 'D017-LATE', 'D017-EXCUSED')
  ) THEN
    RAISE EXCEPTION 'a flag was recorded for somebody who had nothing to dispute';
  END IF;
END
$rules$;

DO $done$ BEGIN RAISE NOTICE '017 dispute-rule assertions passed'; END $done$;

ROLLBACK;
