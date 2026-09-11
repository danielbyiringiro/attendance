-- ============================================================================
-- Migration 004 — attendance records
--
-- The central claim of this whole migration is that close_session() writes
-- absence down, so the two browser-side derivations can be deleted. These
-- assertions are mostly about that: the right people get marked, the wrong
-- people do not, and enrolment dates are respected.
--
-- Runs as an admin (staff one) so it can act across classes, inside a
-- transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $assert$
DECLARE
  v_class    uuid;
  v_cohort_a uuid;
  v_cohort_b uuid;
  v_sess     uuid;
  v_sess_b   uuid;
  v_later    uuid;
  v_rec      uuid;
  n          bigint;
  st         public.attendance_state;
  pin1       text;
  pin2       text;
  failed     boolean;
BEGIN
  -- --------------------------------------------------------------------------
  -- A class with two cohorts, a session each, and a roster
  -- --------------------------------------------------------------------------
  v_class := (public.create_class(
                'ASSERT-004', 'Attendance Class',
                DATE '2026-05-18', DATE '2026-05-28',
                'Africa/Accra', 2) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_cohort_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  -- S001, S002, S003 in cohort A; S004 in cohort B.
  INSERT INTO public.enrolments (class_id, cohort_id, student_id, enrolled_on) VALUES
    (v_class, v_cohort_a, 'S001', DATE '2026-05-18'),
    (v_class, v_cohort_a, 'S002', DATE '2026-05-18'),
    (v_class, v_cohort_a, 'S003', DATE '2026-05-18'),
    (v_class, v_cohort_b, 'S004', DATE '2026-05-18');

  -- S005 joins cohort A a week late, S006 leaves early. Neither should be
  -- marked absent for a session outside their enrolment.
  INSERT INTO public.enrolments (class_id, cohort_id, student_id, enrolled_on) VALUES
    (v_class, v_cohort_a, 'S005', DATE '2026-05-26');
  INSERT INTO public.enrolments (class_id, cohort_id, student_id, enrolled_on, dropped_on) VALUES
    (v_class, v_cohort_a, 'S006', DATE '2026-05-18', DATE '2026-05-20');

  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cohort_a, TIMESTAMPTZ '2026-05-21 09:00:00+00', DATE '1970-01-01')
  RETURNING id INTO v_sess;

  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cohort_b, TIMESTAMPTZ '2026-05-21 11:00:00+00', DATE '1970-01-01')
  RETURNING id INTO v_sess_b;

  -- --------------------------------------------------------------------------
  -- open_session
  -- --------------------------------------------------------------------------
  pin1 := public.open_session(v_sess) ->> 'pin';
  IF pin1 IS NULL OR length(pin1) <> 5 THEN
    RAISE EXCEPTION 'open_session did not generate a 5-character PIN, got %', pin1;
  END IF;

  -- Ambiguous glyphs are excluded: these get read aloud to a room.
  IF pin1 ~ '[O0I1]' THEN
    RAISE EXCEPTION 'generated PIN % contains an ambiguous character', pin1;
  END IF;

  -- Two sessions open at once, on different PINs. This is what the singleton
  -- session_state row could never do.
  pin2 := public.open_session(v_sess_b) ->> 'pin';
  IF pin2 = pin1 THEN
    RAISE EXCEPTION 'two concurrently open sessions were given the same PIN';
  END IF;

  SELECT count(*) INTO n FROM public.class_sessions
  WHERE class_id = v_class AND status = 'open';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 sessions open at once, found %', n;
  END IF;

  -- Opening does not rewrite the scheduled time; lateness is measured from
  -- opened_at, so a TA opening late does not mark the room late.
  SELECT count(*) INTO n FROM public.class_sessions
  WHERE id = v_sess AND starts_at = TIMESTAMPTZ '2026-05-21 09:00:00+00';
  IF n <> 1 THEN
    RAISE EXCEPTION 'open_session rewrote starts_at';
  END IF;

  -- --------------------------------------------------------------------------
  -- Some students mark, then the session closes
  -- --------------------------------------------------------------------------
  INSERT INTO public.attendance_records (session_id, student_id, state, marked_by_role)
  VALUES (v_sess, 'S001', 'present', 'student'),
         (v_sess, 'S002', 'late',    'student');

  -- The constraint present_students never had.
  failed := false;
  BEGIN
    INSERT INTO public.attendance_records (session_id, student_id, state)
    VALUES (v_sess, 'S001', 'present');
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a student was recorded twice for one session';
  END IF;

  -- S003 did not mark. S005 was not enrolled yet, S006 had left.
  SELECT public.close_session(v_sess) INTO n;
  IF n <> 1 THEN
    RAISE EXCEPTION 'close_session should have marked exactly 1 absentee, marked %', n;
  END IF;

  SELECT state INTO st
  FROM public.attendance_records WHERE session_id = v_sess AND student_id = 'S003';
  IF st IS DISTINCT FROM 'unexcused' THEN
    RAISE EXCEPTION 'the absent student is %, expected unexcused', st;
  END IF;

  -- This is the whole point: absence is a row now, not the lack of one.
  SELECT count(*) INTO n FROM public.attendance_records WHERE session_id = v_sess;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 records for a 3-person cohort session, found %', n;
  END IF;

  -- Marks already made are untouched.
  SELECT state INTO st
  FROM public.attendance_records WHERE session_id = v_sess AND student_id = 'S002';
  IF st IS DISTINCT FROM 'late' THEN
    RAISE EXCEPTION 'close_session overwrote a late mark with %', st;
  END IF;

  -- A student who joined after the session is not retrospectively absent.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE session_id = v_sess AND student_id = 'S005';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a student enrolled after the session was marked absent for it';
  END IF;

  -- Nor is one who had already left.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE session_id = v_sess AND student_id = 'S006';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a student who dropped before the session was marked absent for it';
  END IF;

  -- Closing one cohort's session does not touch the other's.
  SELECT count(*) INTO n FROM public.attendance_records WHERE session_id = v_sess_b;
  IF n <> 0 THEN
    RAISE EXCEPTION 'closing cohort A''s session wrote % records for cohort B', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.class_sessions WHERE id = v_sess AND status = 'closed' AND closed_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'close_session did not close and stamp the session';
  END IF;

  -- Closing twice is harmless: no duplicate absences.
  SELECT public.close_session(v_sess) INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'closing an already-closed session created % more records', n;
  END IF;

  -- --------------------------------------------------------------------------
  -- Corrections are logged by the trigger, not by convention
  -- --------------------------------------------------------------------------
  SELECT id INTO v_rec
  FROM public.attendance_records WHERE session_id = v_sess AND student_id = 'S003';

  UPDATE public.attendance_records SET state = 'excused' WHERE id = v_rec;

  SELECT count(*) INTO n
  FROM public.attendance_corrections
  WHERE record_id = v_rec AND previous_state = 'unexcused' AND new_state = 'excused';
  IF n <> 1 THEN
    RAISE EXCEPTION 'changing a state did not write a correction, found % rows', n;
  END IF;

  -- Touching a row without changing its state is not a correction.
  UPDATE public.attendance_records SET marked_at = now() WHERE id = v_rec;
  SELECT count(*) INTO n FROM public.attendance_corrections WHERE record_id = v_rec;
  IF n <> 1 THEN
    RAISE EXCEPTION 'a non-state update logged a spurious correction';
  END IF;

  -- --------------------------------------------------------------------------
  -- cancel_session clears the session entirely
  --
  -- This file used to assert the opposite: that the absences went and the
  -- check-ins stayed, on the reasoning that somebody did turn up and erasing
  -- that would be a lie about the past.
  --
  -- Migration 032 reversed it, because the reasoning was the wrong way round.
  -- If the class was cancelled it did not happen, and "present at a class that
  -- did not happen" is not a fact about a student. The rate already ignored
  -- cancelled sessions, so the row changed no percentage — it sat in the
  -- student's own history claiming they attended something that was called off,
  -- which is what a TA noticed.
  --
  -- The old rule also listed the states to delete and had quietly missed two:
  -- a student who arrived late, or was exempted, kept their record. Deleting by
  -- session rather than by a list of states is the form that cannot rot.
  -- --------------------------------------------------------------------------
  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cohort_a, TIMESTAMPTZ '2026-05-27 09:00:00+00', DATE '1970-01-01')
  RETURNING id INTO v_later;

  INSERT INTO public.attendance_records (session_id, student_id, state)
  VALUES (v_later, 'S001', 'present');

  PERFORM public.close_session(v_later);
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE session_id = v_later AND state = 'unexcused';
  IF n <> 3 THEN            -- S002, S003, S005 (enrolled by the 26th)
    RAISE EXCEPTION 'expected 3 unexcused before cancelling, found %', n;
  END IF;

  -- Four: the three absences close_session wrote, plus S001's check-in.
  SELECT public.cancel_session(v_later, 'Lecturer unwell') INTO n;
  IF n <> 4 THEN
    RAISE EXCEPTION
      'cancel_session should have removed 4 records (3 absences + 1 check-in), removed %', n;
  END IF;

  -- Nothing at all is left against it. Asserted on the whole session rather
  -- than state by state, so a state added later cannot slip through the way
  -- 'late' and 'exempted' did.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE session_id = v_later;
  IF n <> 0 THEN
    RAISE EXCEPTION
      '% attendance row(s) survived a cancellation — the class did not happen', n;
  END IF;

  -- Closing a cancelled session is refused rather than silently re-absenting.
  failed := false;
  BEGIN
    PERFORM public.close_session(v_later);
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a cancelled session was closed';
  END IF;

  -- --------------------------------------------------------------------------
  -- Deleting a session takes its records with it
  -- --------------------------------------------------------------------------
  DELETE FROM public.class_sessions WHERE id = v_sess_b;
  SELECT count(*) INTO n FROM public.attendance_records WHERE session_id = v_sess_b;
  IF n <> 0 THEN
    RAISE EXCEPTION 'attendance records survived their session being deleted';
  END IF;

  -- Hand a real session id to the scoping block below. A temp table carries no
  -- RLS, which is the point: the non-member must be refused because of WHO THEY
  -- ARE, not because they could not find the id.
  CREATE TEMP TABLE t_guard_ids ON COMMIT DROP AS
  SELECT v_sess AS closed_session, v_later AS cancelled_session;

  RAISE NOTICE '004 assertions passed';
END
$assert$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- Scoping: attendance is invisible outside the class it belongs to
-- ----------------------------------------------------------------------------

-- Staff two is a member of the rescued class, but was never put on the class
-- this file created. Scoping every count below to that class is what makes
-- "non-member" mean something now that there is no admin bypass to remove.

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $scoped$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM public.attendance_records ar
  JOIN public.classes c ON c.id = ar.class_id
  WHERE c.code = 'ASSERT-004';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-member sees % attendance records of that class', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.attendance_corrections ac
  JOIN public.classes c ON c.id = ac.class_id
  WHERE c.code = 'ASSERT-004';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a non-member sees % corrections of that class', n;
  END IF;
END
$scoped$;

-- The three session RPCs are SECURITY DEFINER, so they run as the owner and RLS
-- does not constrain them from the inside. Their explicit can_access_class()
-- check is the only thing standing between a stranger with a session id and
-- someone else's attendance. Test it directly rather than trusting the policy.
DO $rpc_guard$
DECLARE
  v_sess uuid;
  ok     boolean;
BEGIN
  -- A real id, taken from the temp table rather than from a query the policy
  -- would block. Without this the calls below would fail with "session does not
  -- exist" and prove nothing about permissions.
  SELECT closed_session INTO v_sess FROM t_guard_ids;
  IF v_sess IS NULL THEN
    RAISE EXCEPTION 'the guard block did not receive a session id to test with';
  END IF;

  -- The policy does hide it from an ordinary query...
  IF EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_sess) THEN
    RAISE EXCEPTION 'a non-member could read someone else''s session through the policy';
  END IF;

  -- ...and holding the id anyway must not help.
  ok := false;
  BEGIN
    PERFORM public.close_session(v_sess);
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member closed a session for a class they cannot access';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.cancel_session(v_sess, 'nope');
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member cancelled someone else''s session';
  END IF;

  ok := false;
  BEGIN
    PERFORM public.open_session(v_sess);
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a non-member opened someone else''s session';
  END IF;
END
$rpc_guard$;

RESET ROLE;
RESET request.jwt.claim.sub;

DO $grants$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('attendance_records', 'attendance_corrections')
    AND grantee = 'anon';
  IF n <> 0 THEN
    RAISE EXCEPTION 'anon holds % grants on the attendance tables', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename = 'attendance_records';
  IF n <> 1 THEN
    RAISE EXCEPTION 'attendance_records is not published for realtime';
  END IF;

  RAISE NOTICE '004 scoping assertions passed';
END
$grants$;

ROLLBACK;
