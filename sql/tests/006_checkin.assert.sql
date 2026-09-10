-- ============================================================================
-- Migration 006 — check-in resolves the class from the PIN
--
-- Two things to prove. That it works: a student marks into the right one of
-- several concurrently open sessions. And that it does not leak: every refusal
-- looks the same, so the endpoint cannot be used to discover who is enrolled
-- where by anyone holding a student ID off a printed card.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $assert$
DECLARE
  v_class_x  uuid;
  v_class_y  uuid;
  v_cx_a     uuid;
  v_cx_b     uuid;
  v_cy_a     uuid;
  v_sess_xa  uuid;
  v_sess_xb  uuid;
  v_sess_y   uuid;
  r          jsonb;
  refusal_a  text;
  refusal_b  text;
  refusal_c  text;
  n          bigint;
  st         public.attendance_state;
BEGIN
  -- --------------------------------------------------------------------------
  -- Two classes, three cohorts, three sessions, all open at once
  -- --------------------------------------------------------------------------
  v_class_x := (public.create_class('ASSERT-006-X', 'Class X',
                  DATE '2026-05-18', DATE '2026-05-28',
                  'Africa/Accra', NULL, ARRAY['A','B']) ->> 'class_id')::uuid;
  v_class_y := (public.create_class('ASSERT-006-Y', 'Class Y',
                  DATE '2026-05-18', DATE '2026-05-28',
                  'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cx_a FROM public.cohorts WHERE class_id = v_class_x AND label = 'A';
  SELECT id INTO v_cx_b FROM public.cohorts WHERE class_id = v_class_x AND label = 'B';
  SELECT id INTO v_cy_a FROM public.cohorts WHERE class_id = v_class_y AND label = 'A';

  -- S001 takes BOTH classes; S002 only X/A; S003 only X/B.
  INSERT INTO public.enrolments (class_id, cohort_id, student_id, enrolled_on) VALUES
    (v_class_x, v_cx_a, 'S001', DATE '2026-05-18'),
    (v_class_x, v_cx_a, 'S002', DATE '2026-05-18'),
    (v_class_x, v_cx_b, 'S003', DATE '2026-05-18'),
    (v_class_y, v_cy_a, 'S001', DATE '2026-05-18'),
    -- For the late-opening case further down. S001 marks at this session
    -- early on, so a second mark from them would be refused as already_marked
    -- and answer a different question.
    (v_class_y, v_cy_a, 'S004', DATE '2026-05-18');

  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cx_a, now(), CURRENT_DATE) RETURNING id INTO v_sess_xa;
  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cx_b, now(), CURRENT_DATE) RETURNING id INTO v_sess_xb;
  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cy_a, now(), CURRENT_DATE) RETURNING id INTO v_sess_y;

  PERFORM public.open_session(v_sess_xa, 'XAAAA', 60);
  PERFORM public.open_session(v_sess_xb, 'XBBBB', 60);
  PERFORM public.open_session(v_sess_y,  'YAAAA', 60);

  -- --------------------------------------------------------------------------
  -- The PIN picks the class
  -- --------------------------------------------------------------------------
  r := public.mark_attendance('S001', 'XAAAA');
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'S001 could not check in to class X: %', r ->> 'error';
  END IF;
  IF r ->> 'class' <> 'Class X' THEN
    RAISE EXCEPTION 'the PIN resolved to %, expected Class X', r ->> 'class';
  END IF;

  SELECT state INTO st FROM public.attendance_records
  WHERE session_id = v_sess_xa AND student_id = 'S001';
  IF st IS DISTINCT FROM 'present' THEN
    RAISE EXCEPTION 'expected present, got %', st;
  END IF;

  -- The same student, the same moment, a different class. Impossible before:
  -- session_state held one PIN for the whole installation.
  r := public.mark_attendance('S001', 'YAAAA');
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'S001 could not also check in to class Y: %', r ->> 'error';
  END IF;
  IF r ->> 'class' <> 'Class Y' THEN
    RAISE EXCEPTION 'the second PIN resolved to %, expected Class Y', r ->> 'class';
  END IF;

  SELECT count(*) INTO n
  FROM public.attendance_records
  WHERE student_id = 'S001' AND state = 'present'
    AND session_id IN (v_sess_xa, v_sess_y);
  IF n <> 2 THEN
    RAISE EXCEPTION 'a student in two classes should hold 2 records, holds %', n;
  END IF;

  -- Nothing landed on the cohort they are not in.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE session_id = v_sess_xb;
  IF n <> 0 THEN
    RAISE EXCEPTION 'a mark leaked into a cohort the student is not enrolled in';
  END IF;

  -- Marking twice is refused, and does not overwrite the first record.
  r := public.mark_attendance('S001', 'XAAAA');
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked the same session twice';
  END IF;
  IF r ->> 'reason' <> 'already_marked' THEN
    RAISE EXCEPTION 'unexpected duplicate refusal: %', r;
  END IF;

  -- --------------------------------------------------------------------------
  -- Every refusal that depends on the STUDENT is the same sentence
  --
  -- The student ID is printed on a card. If "not enrolled in this class" and
  -- "no such student" read differently, anyone holding one can enumerate who
  -- is in which class.
  --
  -- 014 narrowed this: a refusal that depends only on the PIN — no open
  -- session has that code — is allowed to say so, because the answer is the
  -- same for every person in the building and reveals nothing about any of
  -- them. The two below are the ones that must stay indistinguishable.
  -- --------------------------------------------------------------------------
  refusal_a := public.mark_attendance('S002', 'ZZZZZ')  ->> 'error';  -- no such PIN
  refusal_b := public.mark_attendance('S002', 'XBBBB')  ->> 'error';  -- real PIN, not their cohort
  refusal_c := public.mark_attendance('S999', 'XAAAA')  ->> 'error';  -- not a student at all

  IF refusal_b IS DISTINCT FROM refusal_c THEN
    RAISE EXCEPTION
      'refusals differ and leak enrolment: wrong-cohort=%, unknown-student=%',
      refusal_b, refusal_c;
  END IF;

  -- The PIN-only refusal must NOT be the student-dependent one, or the
  -- narrowing in 014 silently did nothing.
  IF refusal_a IS NOT DISTINCT FROM refusal_b THEN
    RAISE EXCEPTION
      'a wrong code says the same as a wrong student, so the specific message was lost';
  END IF;

  -- And no record was created by any of them.
  SELECT count(*) INTO n FROM public.attendance_records WHERE student_id = 'S999';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a refused check-in still wrote a record';
  END IF;

  -- --------------------------------------------------------------------------
  -- Lateness is measured from the class starting, or from the TA opening if
  -- that came later
  --
  -- This block used to say "from when the TA opened, not the scheduled start",
  -- and moved opened_at while leaving starts_at at creation time. Since 028
  -- that describes a session opened THIRTY MINUTES BEFORE IT STARTS, where
  -- present is the right answer — a student cannot be late for a class that
  -- has not begun.
  --
  -- What that rule was protecting is still protected, and asserted below: a TA
  -- who opens LATE must not mark a room full of people late for having waited.
  -- So the class time moves with the opening here: a session that started half
  -- an hour ago and was opened then.
  -- --------------------------------------------------------------------------
  UPDATE public.class_sessions
     SET starts_at = now() - INTERVAL '30 minutes',
         opened_at = now() - INTERVAL '30 minutes',
         late_window_minutes = 10,
         auto_close_minutes = 120
   WHERE id = v_sess_xb;

  r := public.mark_attendance('S003', 'XBBBB');
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'S003 could not check in: %', r ->> 'error';
  END IF;
  IF r ->> 'state' <> 'late' THEN
    RAISE EXCEPTION 'expected a late mark 30 minutes past a 10 minute window, got %',
      r ->> 'state';
  END IF;

  -- And the case the old rule existed to protect: a TA who opens LATE.
  --
  -- The class started an hour ago and the TA has only just opened it. Marking
  -- from the class start alone would record everybody who waited as late, for
  -- somebody else's lateness. The anchor is whichever came later, so it is the
  -- opening here, and they are present.
  UPDATE public.class_sessions
     SET starts_at = now() - INTERVAL '60 minutes',
         opened_at = now() - INTERVAL '2 minutes',
         late_window_minutes = 10
   WHERE id = v_sess_y;

  r := public.mark_attendance('S004', 'YAAAA');
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'S004 could not check in at a late-opened session: %', r;
  END IF;
  IF r ->> 'state' <> 'present' THEN
    RAISE EXCEPTION
      'a student marking two minutes after the TA opened was recorded % — a '
      'room that waited an hour must not be marked late for it', r ->> 'state';
  END IF;

  -- Past auto_close, the window is shut even though the session is still open.
  UPDATE public.class_sessions
     SET starts_at  = now() - INTERVAL '3 hours',
         opened_at  = now() - INTERVAL '3 hours',
         auto_close_minutes = 15
   WHERE id = v_sess_xa;

  r := public.mark_attendance('S002', 'XAAAA');
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a check-in was accepted after the window closed';
  END IF;
  IF r ->> 'reason' <> 'window_closed' THEN
    RAISE EXCEPTION 'unexpected closed-window refusal: %', r;
  END IF;

  -- --------------------------------------------------------------------------
  -- A mark overwrites an absence, never the reverse
  --
  -- close_session may have already written unexcused for someone who then marks
  -- during a reopened window.
  -- --------------------------------------------------------------------------
  UPDATE public.class_sessions
     SET opened_at = now(), auto_close_minutes = 60, late_window_minutes = 60
   WHERE id = v_sess_xa;

  INSERT INTO public.attendance_records (session_id, student_id, state, marked_by_role)
  VALUES (v_sess_xa, 'S002', 'unexcused', 'system')
  ON CONFLICT (session_id, student_id) DO UPDATE SET state = 'unexcused';

  r := public.mark_attendance('S002', 'XAAAA');
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student marked absent could not then check in: %', r ->> 'error';
  END IF;

  SELECT state INTO st FROM public.attendance_records
  WHERE session_id = v_sess_xa AND student_id = 'S002';
  IF st IS DISTINCT FROM 'present' THEN
    RAISE EXCEPTION 'checking in did not clear the absence, state is %', st;
  END IF;

  -- ...and that flip was logged, because it changed a stored state.
  SELECT count(*) INTO n
  FROM public.attendance_corrections c
  JOIN public.attendance_records ar ON ar.id = c.record_id
  WHERE ar.session_id = v_sess_xa AND ar.student_id = 'S002'
    AND c.previous_state = 'unexcused' AND c.new_state = 'present';
  IF n <> 1 THEN
    RAISE EXCEPTION 'clearing an absence by checking in was not audited';
  END IF;

  -- The bridge is gone: mark_attendance no longer dual-writes
  -- present_students. Asserted in 015's suite, which runs as superuser —
  -- 015 retires that table into a schema `authenticated` cannot reach, and
  -- this file has SET ROLE authenticated above.

  -- --------------------------------------------------------------------------
  -- The anon countdown, without the singleton
  -- --------------------------------------------------------------------------
  r := public.get_open_session_summary();
  IF (r ->> 'open_count')::int < 1 THEN
    RAISE EXCEPTION 'the summary reports no open sessions while sessions are open';
  END IF;
  IF r ? 'pin' OR r ? 'class' OR r ? 'cohort' THEN
    RAISE EXCEPTION 'the anon summary leaks more than a count and a time: %', r;
  END IF;

  RAISE NOTICE '006 assertions passed';
END
$assert$;

RESET ROLE;
RESET request.jwt.claim.sub;

ROLLBACK;
