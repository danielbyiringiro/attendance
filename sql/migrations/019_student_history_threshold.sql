-- ============================================================================
-- 019 — the student history knows what its class actually requires
--
-- classes.min_attendance_percentage is per class, and the TA dashboard already
-- colours a rate against it. The student-facing history had no access to it, so
-- it would have had to assume a number — and assuming 75 tells somebody in a
-- class requiring 60 that they are failing when they are not, or worse, tells
-- somebody in a class requiring 80 that they are fine.
--
-- Added per session row rather than as a separate key: the payload is already
-- shaped that way (each row carries its class name, code and cohort), and a
-- student in two classes needs the threshold that goes with each one.
--
-- Run AFTER 018. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_date', f.session_date,
                 'session_id',   f.session_id,
                 'status',       f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb),
    -- Cancelled sessions are included and labelled, so the screen can show
    -- "no class" instead of silently omitting the day.
    'sessions', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_id',     s.id,
                 'date',           s.session_date,
                 'class',          k.name,
                 'class_code',     k.code,
                 'cohort',         co.label,
                 'status',         s.status,
                 'state',          ar.state,
                 'marked_at',      ar.marked_at,
                 'min_attendance', k.min_attendance_percentage)
               ORDER BY s.session_date DESC)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      JOIN public.classes k  ON k.id  = s.class_id
      JOIN public.enrolments e
        ON e.cohort_id = s.cohort_id
       AND e.student_id = p_student_id
       AND e.enrolled_on <= s.session_date
       AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date)
      LEFT JOIN public.attendance_records ar
        ON ar.session_id = s.id AND ar.student_id = p_student_id
      WHERE s.status <> 'scheduled'), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_student_attendance(text) IS
  'One student''s attendance, as stored: every session their cohorts held, with '
  'the state recorded against it, the attendance each class requires, and any '
  'days they have flagged.';
