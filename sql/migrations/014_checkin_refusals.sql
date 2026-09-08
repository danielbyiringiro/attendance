-- ============================================================================
-- 014 — say why a check-in failed, as far as that can be said safely
--
-- 006 answered every failure with one message, on the grounds that
-- distinguishing "wrong PIN" from "not enrolled" turns the endpoint into an
-- enrolment oracle for anyone holding a student ID. That reasoning is sound and
-- is kept. But it was applied too broadly: the failures divide into two kinds,
-- and only one of them is about the student.
--
--   Depends only on the PIN — safe to name:
--     no open session has that code
--     the session with that code has passed its sign-up window
--
--   Depends on the student — must stay generic:
--     the code is live but they are not enrolled in that cohort
--     the student id does not exist
--
-- The first pair covers the overwhelming majority of real failures: a mistyped
-- code, and arriving after the window shut. Telling a student which of those
-- happened costs nothing, because the answer is identical for every person in
-- the building and the code is read aloud in the room anyway. Knowing a live
-- PIN is not a credential: enrolment is still checked, so it does not let
-- anybody mark attendance they could not already mark.
--
-- The second pair is unchanged, and deliberately indistinguishable from each
-- other.
--
-- This also drops the present_students dual-write. 006 added it as a bridge so
-- the dashboard, exporter and weekly report kept working while they were
-- ported one at a time, and said it would go in 008. It did not. Nothing in
-- the client reads that table any longer, so the write has no remaining
-- reader and stops here.
--
-- Run AFTER 013. Idempotent.
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
  SELECT name  INTO v_class_name FROM public.classes WHERE id = v_session.class_id;

  RETURN jsonb_build_object(
    'success', true,
    'name',    COALESCE(v_student.name, v_student_id),
    'cohort',  v_cohort,
    'class',   v_class_name,
    'state',   v_state
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.mark_attendance(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_attendance(text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.mark_attendance(text, text) IS
  'Student check-in. Resolves which open session the PIN belongs to and that '
  'the student is enrolled in its cohort. Failures that depend only on the PIN '
  'are named; failures that depend on the student are deliberately '
  'indistinguishable, so the endpoint cannot be used to discover who is '
  'enrolled in what.';
