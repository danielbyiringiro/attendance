-- ============================================================================
-- 006 — check-in resolves the class from the PIN
--
-- The first migration the running app actually notices. Until now everything
-- has been additive; this replaces the bodies of the three RPCs the student
-- side calls.
--
-- Every signature is unchanged, deliberately. Index.tsx:112 and
-- StudentDashboard.tsx:77,156 keep working untouched, and a browser holding a
-- stale copy of the app keeps working too. The student UI still asks for an ID
-- and a PIN; the server now works out which of several open sessions that PIN
-- belongs to, rather than reading one global row.
--
-- The old mark_attendance read session_state WHERE id = 1: one PIN, one window,
-- one timer for the whole installation. That is the assumption that made a
-- second class impossible.
--
-- DUAL WRITE: attendance_records is the source of truth from here, but every
-- successful check-in ALSO writes the legacy present_students row, because the
-- dashboard, the exporter and the weekly report all still read it. Those are
-- ported one at a time in later commits; 008 removes the dual write.
--
-- Run AFTER 005. Idempotent.
-- ============================================================================

-- flagged gains a session_id so a dispute points at a real session rather than
-- a (student, date) pair that cannot say WHICH class was disputed.
ALTER TABLE public.flagged
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.class_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_flagged_session ON public.flagged (session_id);

-- ----------------------------------------------------------------------------
-- mark_attendance — same signature, new body
--
-- Resolution is a join, not a lookup: an open session whose PIN matches AND
-- whose cohort the student is enrolled in. Both halves matter. The PIN alone
-- would let a student mark into a class they do not attend; the enrolment alone
-- would not identify a session.
--
-- Two constraints from earlier migrations make this unambiguous, and neither is
-- decorative:
--   * the partial unique index on open PINs — two TAs cannot both use 1234
--   * UNIQUE (class_id, student_id) on enrolments — a student cannot be in two
--     cohorts of one class, which would otherwise match two open sessions
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

  -- Candidate sessions: open, PIN matches, student enrolled, and the student
  -- was on the roster on the day in question.
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
    -- ONE message for wrong PIN, closed window and not-enrolled alike.
    -- Distinguishing them turns this endpoint into an enrolment oracle for
    -- anyone holding a student ID, and the ID is printed on a card.
    RETURN jsonb_build_object(
      'success', false,
      'error', 'That PIN is not valid for you right now. Check the code on '
               'screen, and that the window is still open.');
  END IF;

  IF v_matches > 1 THEN
    -- Should be unreachable: the open-PIN index and the one-enrolment-per-class
    -- constraint together forbid it. Refuse rather than guess which class.
    RETURN jsonb_build_object(
      'success', false,
      'error', 'That PIN matches more than one of your classes. Please tell '
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

  -- The window runs from when the TA opened, not from the scheduled start: a
  -- session opened late should still accept marks for its full length.
  IF v_session.opened_at IS NOT NULL
     AND now() > v_session.opened_at + make_interval(mins => v_session.auto_close_minutes)
  THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'The attendance window has closed.');
  END IF;

  SELECT state INTO v_existing
  FROM public.attendance_records
  WHERE session_id = v_session.id AND student_id = v_student_id;

  IF v_existing IS NOT NULL AND v_existing IN ('present', 'late') THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'You have already marked your attendance.');
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

  -- ---- bridge -------------------------------------------------------------
  -- Keeps the dashboard, the exporter and the weekly report working while they
  -- are ported one at a time. Removed in 008. Guarded so re-marking after a
  -- correction cannot produce a second legacy row.
  IF NOT EXISTS (
    SELECT 1 FROM public.present_students
    WHERE student_id = v_student_id
      AND (timestamp AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
  ) THEN
    INSERT INTO public.present_students (student_id, cohort, timestamp)
    VALUES (v_student_id, COALESCE(v_cohort, ''), now());
  END IF;

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

-- ----------------------------------------------------------------------------
-- get_student_attendance — same four keys, plus one
--
-- present / cancelled / excused / flagged are kept exactly as they were so
-- StudentDashboard.tsx does not change. They are still derived from the legacy
-- tables, because that is what the current screen reads.
--
-- `sessions` is the replacement: stored state per session, with the class and
-- cohort attached, so a student in two classes can tell them apart. The old
-- keys go once the screen reads this one.
-- ----------------------------------------------------------------------------

-- Guarded: migration 015 retires present_students, cancelled_sessions and
-- excused_absences out of `public` and redefines this function to stop reading
-- them. Re-running 006 afterwards must not restore a body that references
-- tables that are no longer there.
DO $gsa$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'present_students'
  ) THEN
    RAISE NOTICE
      'get_student_attendance left as migration 015 defined it — the legacy '
      'tables it derived four of its keys from have been retired';
    RETURN;
  END IF;

  EXECUTE $gsa_sql$
CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('timestamp', ps.timestamp, 'cohort', ps.cohort)
               ORDER BY ps.timestamp DESC)
      FROM public.present_students ps
      WHERE ps.student_id = p_student_id), '[]'::jsonb),
    'cancelled', COALESCE((
      SELECT jsonb_agg(DISTINCT cs.date)
      FROM public.cancelled_sessions cs
      WHERE cs.is_cancelled), '[]'::jsonb),
    'excused', COALESCE((
      SELECT jsonb_agg(DISTINCT ea.date)
      FROM public.excused_absences ea
      WHERE ea.student_id = p_student_id), '[]'::jsonb),
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('session_date', f.session_date, 'status', f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb),
    -- The stored truth. Cancelled sessions are included and labelled, so the
    -- screen can show "no class" instead of silently omitting the day.
    'sessions', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_id',   s.id,
                 'date',         s.session_date,
                 'class',        k.name,
                 'class_code',   k.code,
                 'cohort',       co.label,
                 'status',       s.status,
                 'state',        ar.state,
                 'marked_at',    ar.marked_at)
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
  $gsa_sql$;
END
$gsa$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- flag_attendance — same signature, now records which session
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.flag_attendance(
  p_student_id text,
  p_session_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_student_id text := btrim(p_student_id);
  v_status     text;
  v_session    uuid;
BEGIN
  SELECT status INTO v_status
  FROM public.flagged
  WHERE student_id = v_student_id AND session_date = p_session_date;

  IF v_status IS NOT NULL AND v_status <> 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_pending');
  END IF;
  IF v_status = 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'denied');
  END IF;

  -- Resolve the session the student is actually disputing. Left NULL when it
  -- cannot be resolved rather than refusing: a dispute about a day with no
  -- session row is exactly the kind of gap a student should be able to raise.
  SELECT s.id INTO v_session
  FROM public.class_sessions s
  JOIN public.enrolments e
    ON e.cohort_id = s.cohort_id AND e.student_id = v_student_id
  WHERE s.session_date = p_session_date
  ORDER BY s.starts_at
  LIMIT 1;

  INSERT INTO public.flagged (student_id, session_date, status, session_id)
  VALUES (v_student_id, p_session_date, 'flagged', v_session);

  RETURN jsonb_build_object('success', true, 'session_id', v_session);
END;
$fn$;

REVOKE ALL ON FUNCTION public.flag_attendance(text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.flag_attendance(text, date) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- get_open_session_summary — the countdown, without the singleton
--
-- Index.tsx reads session_state directly as anon to render the pre-login timer,
-- which is why secure_database.sql grants anon SELECT on that table. Per-session
-- PINs make that row meaningless, so this replaces it.
--
-- Returns a count and the earliest closing time and nothing else. No PIN, no
-- class name, no cohort: a logged-out visitor should not learn which classes
-- are running, only that a window is open and roughly how long is left.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_open_session_summary()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'open_count', count(*),
    'closes_at',  min(s.opened_at + make_interval(mins => s.auto_close_minutes))
  )
  FROM public.class_sessions s
  WHERE s.status = 'open'
    AND s.opened_at IS NOT NULL
    AND now() <= s.opened_at + make_interval(mins => s.auto_close_minutes);
$fn$;

REVOKE ALL ON FUNCTION public.get_open_session_summary() FROM public;
GRANT EXECUTE ON FUNCTION public.get_open_session_summary() TO anon, authenticated;

COMMENT ON FUNCTION public.mark_attendance(text, text) IS
  'Student check-in. Resolves which open session the PIN belongs to and that '
  'the student is enrolled in its cohort. Signature unchanged from the '
  'single-class version so the client does not need redeploying. Dual-writes '
  'present_students until migration 008.';
