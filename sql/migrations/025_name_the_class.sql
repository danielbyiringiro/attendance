-- ============================================================================
-- 025 — tell the student which class they just marked
--
-- mark_attendance already returned the class NAME. It now returns the code as
-- well, because that is what a student calls a course: a timetable says CS254,
-- and "Introduction to Artificial Intelligence" is the thing on the syllabus.
-- Somebody in back-to-back lectures wants the four characters they recognise,
-- and wants them before they walk out of the wrong room.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not name the class BEFORE the code is typed, which was asked for and
-- turns out to have no safe form.
--
-- Listing the open classes publicly would say which of this institution's
-- classes are meeting right now, to anybody who loads the page. Looking up a
-- student's own open class from their ID is worse: a student ID is a number
-- printed on a card, so that turns the check-in box into an enrolment oracle —
-- type any ID, learn what they take and where they are. Migration 014 spent
-- itself closing exactly that, which is why its refusals are one message that
-- distinguishes nothing.
--
-- get_open_session_summary is therefore left as it was: a count and a closing
-- time, nothing else. 026 asserts that it stays that way, so the next person
-- to have this idea hears it from the test suite.
--
-- Run AFTER 024. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_attendance(
  p_student_id text,
  p_pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_student_id text := btrim(p_student_id);
  v_pin        text := upper(btrim(COALESCE(p_pin, '')));
  v_session    public.class_sessions%ROWTYPE;
  v_pin_open   integer;
  v_matches    integer;
  v_student    public.students%ROWTYPE;
  v_cohort     text;
  v_class_name text;
  v_class_code text;
  v_state      public.attendance_state;
  v_existing   public.attendance_state;
BEGIN
  IF v_student_id = '' OR v_pin = '' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Enter your Student ID and the PIN.');
  END IF;

  -- Does ANY open session carry this code? Nothing about the student is
  -- involved, so the answer is the same for everyone and can be reported.
  SELECT count(*) INTO v_pin_open
  FROM public.class_sessions s
  WHERE s.status = 'open'
    AND upper(btrim(s.pin)) = v_pin;

  IF v_pin_open = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'no_such_code',
      'error',   'That code is not open right now. Check the letters on '
                 'screen — it is not the same code every session.');
  END IF;

  -- The window runs from when the TA opened, not from the scheduled start: a
  -- session opened late should still accept marks for its full length. Also
  -- PIN-only, so it can be named.
  IF NOT EXISTS (
    SELECT 1
    FROM public.class_sessions s
    WHERE s.status = 'open'
      AND upper(btrim(s.pin)) = v_pin
      AND (s.opened_at IS NULL
           OR now() <= s.opened_at + make_interval(mins => s.auto_close_minutes))
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'window_closed',
      'error',   'That code was right, but its check-in window has closed. '
                 'Ask your TA to reopen it.');
  END IF;

  -- From here the answer depends on who is asking, so it stops being specific.
  SELECT count(*) INTO v_matches
  FROM public.class_sessions s
  JOIN public.enrolments e
    ON e.cohort_id = s.cohort_id
   AND e.student_id = v_student_id
   AND e.dropped_on IS NULL
   AND e.enrolled_on <= s.session_date
  WHERE s.status = 'open'
    AND upper(btrim(s.pin)) = v_pin;

  IF v_matches = 0 THEN
    -- ONE message for "not enrolled in that cohort" and "no such student".
    -- Separating them would let anyone with a student ID — a number printed on
    -- a card — find out who is in which class.
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'not_for_you',
      'error',   'That code is not valid for your ID. Check your Student ID, '
                 'and that this is your class.');
  END IF;

  IF v_matches > 1 THEN
    -- Should be unreachable: the open-PIN index and the one-enrolment-per-class
    -- constraint together forbid it. Refuse rather than guess which class.
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'ambiguous',
      'error',   'That code matches more than one of your classes. Please tell '
                 'your TA.');
  END IF;

  SELECT s.* INTO v_session
  FROM public.class_sessions s
  JOIN public.enrolments e
    ON e.cohort_id = s.cohort_id
   AND e.student_id = v_student_id
   AND e.dropped_on IS NULL
   AND e.enrolled_on <= s.session_date
  WHERE s.status = 'open'
    AND upper(btrim(s.pin)) = v_pin;

  SELECT state INTO v_existing
  FROM public.attendance_records
  WHERE session_id = v_session.id AND student_id = v_student_id;

  IF v_existing IS NOT NULL AND v_existing IN ('present', 'late') THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'already_marked',
      'error',   'You have already marked your attendance for this session.');
  END IF;

  v_state := CASE
    WHEN v_session.opened_at IS NOT NULL
         AND now() > v_session.opened_at + make_interval(mins => v_session.late_window_minutes)
    THEN 'late'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;

  -- ON CONFLICT, not a prior read: close_session may have written an unexcused
  -- row for this student between the check above and this insert.
  INSERT INTO public.attendance_records (
    session_id, class_id, student_id, state, marked_at, marked_by_role, method_used
  )
  VALUES (v_session.id, v_session.class_id, v_student_id, v_state, now(),
          'student', v_session.method)
  ON CONFLICT (session_id, student_id) DO UPDATE
    SET state       = EXCLUDED.state,
        marked_at   = EXCLUDED.marked_at,
        method_used = EXCLUDED.method_used
    WHERE public.attendance_records.state NOT IN ('present', 'late');

  SELECT * INTO v_student FROM public.students WHERE student_id = v_student_id;
  SELECT label INTO v_cohort FROM public.cohorts WHERE id = v_session.cohort_id;
  SELECT name, code INTO v_class_name, v_class_code
  FROM public.classes WHERE id = v_session.class_id;

  RETURN jsonb_build_object(
    'success', true,
    'name',    COALESCE(v_student.name, v_student_id),
    'cohort',  v_cohort,
    'class',   v_class_name,
    'class_code', v_class_code,
    'state',   v_state
  );
END;
$fn$;
