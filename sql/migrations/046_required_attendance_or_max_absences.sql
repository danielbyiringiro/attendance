-- ============================================================================
-- 046 — a class requires a percentage, or allows a number of absences
--
-- Required attendance was the only way to say what a class expects. 75%, and
-- the roster colouring, the below-the-line filter and the student's own history
-- all read it.
--
-- Plenty of courses are not run that way. They allow a number of absences —
-- "miss more than four and you fail" — and a percentage is a roundabout way of
-- saying that, especially early in a term, when the number of sessions it will
-- be taken over is not settled yet. Worse, it moves: a student who has missed
-- four of twelve is at 67%, and the same four out of thirty is 87%, so a class
-- that thinks in absences and sets 75% is flagging different students in
-- September and in November.
--
-- classes gains two columns:
--
--   attendance_rule  'percentage' — what every class does today, and the
--                    default — or 'absences'
--   max_absences     how many are allowed under the second rule
--
-- Both always hold a value, so switching the rule back and forth keeps
-- whatever was set for the other one.
--
-- WHICH ABSENCES COUNT
--
-- The unexcused ones. An excused absence and an exemption already sit outside
-- the rate everywhere else — the app's own isAbsentState, and what
-- close_session writes — so a class that excuses a student and then counts it
-- against their allowance would be saying two different things.
--
-- update_class takes both, and get_student_attendance returns them, so the
-- student's own page can speak in the rule their class actually uses instead of
-- a percentage it does not.
--
-- Run AFTER 045. Idempotent.
-- ============================================================================

ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS attendance_rule text    NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS max_absences    integer NOT NULL DEFAULT 4;

-- Dropped and re-added rather than IF NOT EXISTS, which constraints do not
-- take: this is what makes the migration safe to run twice.
ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS classes_attendance_rule_check;
ALTER TABLE public.classes
  ADD CONSTRAINT classes_attendance_rule_check
  CHECK (attendance_rule IN ('percentage', 'absences'));

ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS classes_max_absences_check;
ALTER TABLE public.classes
  ADD CONSTRAINT classes_max_absences_check
  CHECK (max_absences >= 0);

COMMENT ON COLUMN public.classes.attendance_rule IS
  'What this class requires: ''percentage'' reads min_attendance_percentage, '
  '''absences'' reads max_absences (046).';
COMMENT ON COLUMN public.classes.max_absences IS
  'Unexcused absences a student may have before they are short, under the '
  '''absences'' rule. Excused and exempted never count (046).';

-- ----------------------------------------------------------------------------
-- update_class — two more optional parameters
--
-- The old ten-parameter version is dropped first. Adding parameters with
-- defaults leaves the previous signature in place as a second overload, and a
-- call naming only the old parameters then matches both — which PostgREST
-- reports as "could not choose the best candidate function", on a screen that
-- was working the day before.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_class(
  uuid, text, text, date, date, text, numeric, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.update_class(
  p_class_id                    uuid,
  p_name                        text    DEFAULT NULL,
  p_description                 text    DEFAULT NULL,
  p_term_starts_on              date    DEFAULT NULL,
  p_term_ends_on                date    DEFAULT NULL,
  p_timezone                    text    DEFAULT NULL,
  p_min_attendance_percentage   numeric DEFAULT NULL,
  p_default_duration_minutes    integer DEFAULT NULL,
  p_default_late_window_minutes integer DEFAULT NULL,
  p_default_auto_close_minutes  integer DEFAULT NULL,
  p_attendance_rule             text    DEFAULT NULL,
  p_max_absences                integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF p_attendance_rule IS NOT NULL
     AND p_attendance_rule NOT IN ('percentage', 'absences') THEN
    RAISE EXCEPTION 'attendance_rule must be percentage or absences, not %',
      p_attendance_rule;
  END IF;

  UPDATE public.classes
     SET name                        = COALESCE(NULLIF(btrim(p_name), ''), name),
         description                 = COALESCE(p_description, description),
         term_starts_on              = COALESCE(p_term_starts_on, term_starts_on),
         term_ends_on                = COALESCE(p_term_ends_on, term_ends_on),
         timezone                    = COALESCE(NULLIF(btrim(p_timezone), ''), timezone),
         min_attendance_percentage   = COALESCE(p_min_attendance_percentage, min_attendance_percentage),
         default_duration_minutes    = COALESCE(p_default_duration_minutes, default_duration_minutes),
         default_late_window_minutes = COALESCE(p_default_late_window_minutes, default_late_window_minutes),
         default_auto_close_minutes  = COALESCE(p_default_auto_close_minutes, default_auto_close_minutes),
         -- 046. Each is set on its own, so switching the rule keeps the number
         -- the other one uses.
         attendance_rule             = COALESCE(p_attendance_rule, attendance_rule),
         max_absences                = COALESCE(p_max_absences, max_absences)
   WHERE id = p_class_id
  RETURNING * INTO v_class;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  RETURN to_jsonb(v_class);
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_class(
  uuid, text, text, date, date, text, numeric, integer, integer, integer, text, integer)
  FROM public;
GRANT EXECUTE ON FUNCTION public.update_class(
  uuid, text, text, date, date, text, numeric, integer, integer, integer, text, integer)
  TO authenticated;

-- ----------------------------------------------------------------------------
-- get_student_attendance — the class's rule travels with its sessions
--
-- Copied from 045 with `attendance_rule` and `max_absences` added beside
-- `min_attendance`, which the history page already reads per class. Nothing
-- else changes.
-- ----------------------------------------------------------------------------

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
                 'session_id',      s.id,
                 'date',            s.session_date,
                 'class',           k.name,
                 'class_code',      k.code,
                 'cohort',          co.label,
                 'status',          s.status,
                 'state',           ar.state,
                 'marked_at',       ar.marked_at,
                 'min_attendance',  k.min_attendance_percentage,
                 -- 046: which rule this class is run by, and its allowance.
                 'attendance_rule', k.attendance_rule,
                 'max_absences',    k.max_absences)
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
  'recorded, what the class requires and how (046), any days they have flagged, '
  'and the days off (with reasons) that applied to them (045).';
