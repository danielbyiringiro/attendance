-- ============================================================================
-- 044 — a check-in says who made it, and the display can count check-ins
--
-- For the check-in beep: the student's phone, the presenter tab, the shared
-- display link and the TA dashboard can each make a sound when a student checks
-- in. Two things in the database stood in the way.
--
-- 1. A CHECK-IN OVER AN EXISTING ROW KEPT THE OLD PROVENANCE
--
-- mark_attendance inserts with marked_by_role = 'student', but when a row for
-- that student already exists — an absence close_session wrote before the TA
-- reopened, or a state a TA set — its ON CONFLICT DO UPDATE changed the state
-- and left marked_by_role as it was. So a student who checked in could be
-- stored as present with marked_by_role 'system' or 'staff'.
--
-- That was already wrong before any beep: the register reads marked_by_role to
-- tell "somebody decided this" from "nobody looked". It is fixed here by also
-- setting marked_by_role on that update. Rows written before this migration
-- keep the label they have; nothing reliable says which of them were students.
--
-- 2. THE SIGNED-OUT DISPLAY COULD NOT SEE CHECK-INS ARRIVE
--
-- The dashboard and presenter tab are signed in and hear each check-in over
-- realtime. The display link is not signed in and reads only get_class_display,
-- so each session now carries `checked_in`: how many students have checked
-- themselves in, present or late. The screen beeps when that number rises.
--
-- A number, not names: it is what a room watching the screen could count by
-- looking round, and the function still returns nothing about who.
--
-- Both functions are copied from their latest definitions (028 and 041), with
-- only the changes described above.
--
-- Run AFTER 043. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. mark_attendance — from 028, the update also records who marked
-- ----------------------------------------------------------------------------

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
    WHERE upper(btrim(s.pin)) = v_pin
      AND public.session_is_live(s)
  ) THEN
    -- Two different refusals, because "too early" and "too late" are both
    -- fixable and by different people. Still PIN-only, so neither says
    -- anything about who is asking.
    IF EXISTS (
      SELECT 1
      FROM public.class_sessions s
      WHERE s.status = 'open'
        AND upper(btrim(s.pin)) = v_pin
        AND s.opened_at IS NOT NULL
        AND now() < public.session_opens_at(s)
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'reason',  'not_open_yet',
        'error',   'That code is right, but check-in has not opened yet. It '
                   'opens shortly before the class starts.');
    END IF;

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
  WHERE upper(btrim(s.pin)) = v_pin
    AND public.session_is_live(s);

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
  WHERE upper(btrim(s.pin)) = v_pin
    AND public.session_is_live(s);

  SELECT state INTO v_existing
  FROM public.attendance_records
  WHERE session_id = v_session.id AND student_id = v_student_id;

  IF v_existing IS NOT NULL AND v_existing IN ('present', 'late') THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'already_marked',
      'error',   'You have already marked your attendance for this session.');
  END IF;

  -- Late is measured from whichever is later, the class starting or the TA
  -- opening. From opened_at alone, somebody marking at 08:50 for a 09:00 class
  -- opened at 08:45 would be recorded LATE before the class had begun — the
  -- kind of wrong nobody notices until a student disputes it.
  v_state := CASE
    WHEN v_session.opened_at IS NOT NULL
         AND now() > GREATEST(v_session.opened_at, v_session.starts_at)
                     + make_interval(mins => v_session.late_window_minutes)
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
    SET state          = EXCLUDED.state,
        marked_at      = EXCLUDED.marked_at,
        method_used    = EXCLUDED.method_used,
        -- 044: the student made this mark, whoever wrote the row it replaces.
        marked_by_role = EXCLUDED.marked_by_role
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

REVOKE ALL ON FUNCTION public.mark_attendance(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_attendance(text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. get_class_display — from 041, each session carries its check-in count
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_class_display(p_token text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_max_attempts constant integer := 10;
  c_refused      constant jsonb   := jsonb_build_object('ok', false, 'reason', 'refused');
  v_link  public.class_display_links%ROWTYPE;
  v_class public.classes%ROWTYPE;
  v_today date;
BEGIN
  IF p_token IS NULL OR p_code IS NULL
     OR length(p_token) > 128 OR length(p_code) > 64 THEN
    RETURN c_refused;
  END IF;

  SELECT * INTO v_link FROM public.class_display_links WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN c_refused;
  END IF;

  IF v_link.failed_attempts >= c_max_attempts THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked');
  END IF;

  -- Forgiving about how it was typed: case, spaces and dashes do not matter.
  -- src/lib/classDisplay.ts normalises the same way, in the same order.
  IF upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g')) <> v_link.access_code THEN
    UPDATE public.class_display_links
       SET failed_attempts = failed_attempts + 1
     WHERE class_id = v_link.class_id;
    RETURN c_refused;
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_link.class_id;
  IF v_class.archived_at IS NOT NULL THEN
    RETURN c_refused;
  END IF;

  -- Today where the class is, not where the server is.
  v_today := (now() AT TIME ZONE v_class.timezone)::date;

  RETURN jsonb_build_object(
    'ok',         true,
    'class_name', v_class.name,
    'class_code', v_class.code,
    'timezone',   v_class.timezone,
    -- Anything open, whatever its date, and today's sessions not yet opened.
    -- Closed and cancelled sessions have nothing left to show.
    'sessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',                  s.id,
               'cohort_label',        co.label,
               'status',              s.status,
               -- The PIN only while open. A scheduled session's PIN is not yet
               -- a code anyone should be able to read.
               'pin',                 CASE WHEN s.status = 'open' THEN s.pin END,
               'starts_at',           s.starts_at,
               'opened_at',           s.opened_at,
               'closed_at',           s.closed_at,
               'duration_minutes',    s.duration_minutes,
               'early_open_minutes',  s.early_open_minutes,
               'auto_close_minutes',  s.auto_close_minutes,
               'late_window_minutes', s.late_window_minutes,
               -- 044: students who checked themselves in, for the beep. A
               -- count only; a TA's mark is not a check-in arriving.
               'checked_in', (
                 SELECT count(*)
                 FROM public.attendance_records a
                 WHERE a.session_id = s.id
                   AND a.marked_by_role = 'student'
                   AND a.state IN ('present', 'late'))
             ) ORDER BY s.starts_at, co.label)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      WHERE s.class_id = v_class.id
        AND (s.status = 'open'
             OR (s.status = 'scheduled' AND s.session_date = v_today))
    ), '[]'::jsonb),
    -- So an idle screen can say when it will next have something to show.
    'next', (
      SELECT jsonb_build_object('starts_at', s.starts_at, 'cohort_label', co.label)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      WHERE s.class_id = v_class.id
        AND s.status = 'scheduled'
        AND s.starts_at > now()
      ORDER BY s.starts_at
      LIMIT 1
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_class_display(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_class_display(text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_class_display(text, text) IS
  'For a screen that is not signed in: with a class''s display token and its '
  'current access code, the class''s open and upcoming-today sessions, with the '
  'PIN of any that is open and how many students have checked in (044). Ten '
  'wrong codes lock the link. See migration 041.';
