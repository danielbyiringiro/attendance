-- ============================================================================
-- 045 — a student's history shows the days their class did not meet, and why
--
-- A day off (036) reached a student's record in three ways, and none said so:
--
--   declared on a date nothing was held on   the session is removed (037), so
--                                            the day is simply blank
--   declared "does not count" after a class  everybody is marked exempted
--   declared "counts as attended"            everybody is marked present
--
-- So the student saw a blank day, "Exempt" or "Present", with no reason, while
-- the TA's calendar showed the same day as a holiday with its reason. The table
-- is readable only by staff on the class, so the history page could not show it.
--
-- get_student_attendance now also returns `days_off`: every day off in a class
-- the student is enrolled in that applies to them — declared for the whole class
-- or for their own cohort — with its date, class, cohort, mode and reason.
-- Nothing else it returns changes.
--
-- WHO SEES IT
--
-- Like the rest of this function it answers for whoever types a student ID, and
-- it has always returned that student's classes, cohorts and session dates. A day
-- off and its reason are the same kind of fact, written by staff to explain a
-- date to anyone reading the record. The forms that set one now say that
-- students will see the reason.
--
-- A day after the student left a class (dropped_on) is not theirs, and is left
-- out.
--
-- THE SAME SESSIONS THE TA SEES
--
-- The student's calendar is meant to show what the TA's record of that student
-- shows. The TA's record is every mark the student has in the class, plus their
-- cohort's sessions. Two marks were on it and missing here:
--
--   a register taken early, on a session  left out by `status <> 'scheduled'`;
--   that has not been opened              now kept when the student is marked
--
--   a mark from a cohort the student has  left out because sessions were joined
--   since moved out of                    to the enrolment on the cohort; now on
--                                         the class, which enrolments already
--                                         keep to one row per student
--
-- With both, the two calendars and the two rates agree. An unmarked scheduled
-- session still does not appear: a class next week is not a session anybody has
-- attended or missed.
--
-- The function is copied from its latest definition (042) with the `days_off`
-- key added and those two conditions widened.
--
-- Run AFTER 044. Idempotent.
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
      -- On the class, not the cohort (045): a mark kept from a cohort the
      -- student has since moved out of still shows, as it does for the TA.
      JOIN public.enrolments e
        ON e.class_id = s.class_id
       AND e.student_id = p_student_id
      LEFT JOIN public.attendance_records ar
        ON ar.session_id = s.id AND ar.student_id = p_student_id
      -- Not a scheduled session, unless the student is already marked on it
      -- (045): a register taken early counts on the TA side, so it does here.
      WHERE (s.status <> 'scheduled' OR ar.session_id IS NOT NULL)
        AND (
          -- On their cohort's register that day...
          (e.cohort_id = s.cohort_id
           AND e.enrolled_on <= s.session_date
           AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date))
          -- ...or somebody marked them on it anyway (042).
          OR ar.session_id IS NOT NULL
        )), '[]'::jsonb),
    -- 045: the days their classes did not meet, and why. Whole-class days off
    -- and ones for the student's own cohort; never another cohort's.
    'days_off', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'date',       d.on_date,
                 'class',      k.name,
                 'class_code', k.code,
                 'cohort',     co.label,
                 'mode',       d.mode,
                 'reason',     d.reason)
               ORDER BY d.on_date DESC, k.code)
      FROM public.enrolments e
      JOIN public.cohorts co ON co.id = e.cohort_id
      JOIN public.classes k  ON k.id  = e.class_id
      JOIN public.no_class_days d
        ON d.class_id = e.class_id
       AND (d.cohort_id IS NULL OR d.cohort_id = e.cohort_id)
      WHERE e.student_id = p_student_id
        AND (e.dropped_on IS NULL OR d.on_date <= e.dropped_on)), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_student_attendance(text) IS
  'One student''s attendance, as stored: every session their cohorts held while '
  'they were enrolled, plus any other session they were marked on, with the state '
  'recorded, the attendance each class requires, any days they have flagged, and '
  'the days off (with reasons) that applied to them (045).';
