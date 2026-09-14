-- ============================================================================
-- 042 — staff can mark a student on a session from before they were added
--
-- WHAT WAS WRONG
--
-- A roster is nearly always uploaded after the term has started, and
-- upsert_enrolments sets enrolled_on to the day of the upload. Every staff path
-- then treated "enrolled on the session's date" as "on the register at all":
--
--   the register (rosterForSession)      listed nobody added after the session
--   mark_all_present                     marked nobody added after the session
--   get_student_attendance               hid every session before enrolled_on,
--                                        including ones staff had marked
--   flag_attendance                      refused a dispute against those marks
--
-- So a student added today could not be marked for last week, a session added
-- by hand on a past date showed an empty register, and moving the term start
-- earlier generated sessions nobody could be marked on. Reproduced locally
-- before this was written: all four, with generate_sessions itself working.
--
-- WHAT CHANGES, AND WHAT DOES NOT
--
-- enrolled_on keeps its meaning — the day the student joined — and still
-- decides everything the system does BY ITSELF:
--
--   close_session's automatic absences   unchanged: nobody is recorded absent
--   the open/close sweep                 for a class from before they joined
--   no-class-day exemptions
--   student check-in (mark_attendance)
--
-- What changes is what a PERSON may do, and whether it is then visible:
--
--   mark_all_present      everyone in the cohort who had not been dropped by
--                         the session, whenever they joined — the same list the
--                         register now shows, so "everyone" means what is on
--                         screen
--   get_student_attendance a session appears if the student had joined by then,
--                         OR a record exists for them on it
--   flag_attendance       a session can be disputed on the same terms
--
-- A session from before somebody joined, that nobody marked, still does not
-- appear in their history and still counts for nothing. Only a deliberate mark
-- brings it in.
--
-- Run AFTER 041. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- mark_all_present — the roll is the cohort, not the cohort as of that date
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_all_present(
  p_session_id uuid,
  p_state      public.attendance_state DEFAULT 'present',
  p_overwrite  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_roll    integer := 0;
  v_filled  integer := 0;
  v_changed integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to record attendance for this class';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RAISE EXCEPTION
      'this session was cancelled, so nobody attended it — uncancel it first';
  END IF;

  IF p_state NOT IN ('present', 'late', 'excused') THEN
    RAISE EXCEPTION
      'mark_all_present writes present, late or excused, not %', p_state;
  END IF;

  -- Everyone in the cohort not dropped before the session. enrolled_on is
  -- deliberately NOT a filter here (see the header): this is a person marking
  -- a register, and a student added after the session is still on it.
  DROP TABLE IF EXISTS tmp_roll;
  CREATE TEMP TABLE tmp_roll ON COMMIT DROP AS
  SELECT e.student_id
  FROM public.enrolments e
  WHERE e.cohort_id = v_session.cohort_id
    AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date);

  SELECT count(*) INTO v_roll FROM tmp_roll;

  -- 1. Anyone with no record at all.
  WITH filled AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT v_session.id, v_session.class_id, r.student_id, p_state, now(), 'staff'
    FROM tmp_roll r
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_filled FROM filled;

  -- 2. Anyone whose stored state this replaces. The UPDATE goes through the
  --    correction trigger, so each one is logged with its previous value.
  WITH changed AS (
    UPDATE public.attendance_records a
       SET state = p_state,
           marked_at = now(),
           marked_by_role = 'staff'
      FROM tmp_roll r
     WHERE a.session_id = v_session.id
       AND a.student_id = r.student_id
       AND a.state <> p_state
       AND (
         CASE
           -- Exempted is never swept up: the session does not apply to them.
           WHEN a.state = 'exempted' THEN false
           WHEN p_overwrite THEN true
           -- Default: only states that mean "not accounted for".
           ELSE a.state IN ('unexcused', 'pending')
         END
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_changed FROM changed;

  DROP TABLE IF EXISTS tmp_roll;

  -- A session still `scheduled` is excluded from every count, so marking
  -- everyone present and leaving it there would look like nothing happened.
  -- close_session is reused rather than reimplemented; everyone on the roll
  -- now has a record, so it writes no absences.
  IF v_session.status <> 'closed' THEN
    PERFORM public.close_session(p_session_id);
  END IF;

  RETURN jsonb_build_object(
    'session_id', p_session_id,
    'state',      p_state,
    'roll',       v_roll,
    'filled',     v_filled,
    'changed',    v_changed,
    -- Everyone the call did not touch: already at this state, or deliberately
    -- protected. Derived from the roll so the three always sum to it.
    'left_alone', v_roll - v_filled - v_changed
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.mark_all_present(uuid, public.attendance_state, boolean) FROM public;
GRANT EXECUTE ON FUNCTION
  public.mark_all_present(uuid, public.attendance_state, boolean) TO authenticated;

COMMENT ON FUNCTION public.mark_all_present(uuid, public.attendance_state, boolean) IS
  'Record one state for everyone in a session''s cohort not dropped before it, '
  'including students added after the session (042). By default only fills in '
  'students with no record or marked unexcused/pending; excused, exempted, '
  'present and late are left alone. p_overwrite takes everything but exempted. '
  'Closes the session if it was not already closed.';

-- ----------------------------------------------------------------------------
-- get_student_attendance — a session with a mark on it is shown, whenever the
-- student joined
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
      LEFT JOIN public.attendance_records ar
        ON ar.session_id = s.id AND ar.student_id = p_student_id
      WHERE s.status <> 'scheduled'
        AND (
          -- On the register that day...
          (e.enrolled_on <= s.session_date
           AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date))
          -- ...or somebody marked them on it anyway (042).
          OR ar.session_id IS NOT NULL
        )), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_student_attendance(text) IS
  'One student''s attendance, as stored: every session their cohorts held while '
  'they were enrolled, plus any other session they were marked on, with the state '
  'recorded, the attendance each class requires, and any days they have flagged.';

-- ----------------------------------------------------------------------------
-- flag_attendance — a mark the history shows can be disputed
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.flag_attendance(
  p_student_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_student_id text := btrim(p_student_id);
  v_session    public.class_sessions%ROWTYPE;
  v_status     text;
  v_state      public.attendance_state;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_such_session');
  END IF;

  -- Only a session of a cohort they are actually in, and either one they had
  -- joined by, or one they have been marked on. The second is 042: without it
  -- a mark the history shows could not be disputed.
  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = v_student_id
      AND e.cohort_id = v_session.cohort_id
      AND (
        (e.enrolled_on <= v_session.session_date
         AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date))
        OR EXISTS (
          SELECT 1 FROM public.attendance_records a
          WHERE a.session_id = p_session_id AND a.student_id = v_student_id
        )
      )
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_your_session');
  END IF;

  IF v_session.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'session_cancelled');
  END IF;

  SELECT state INTO v_state
  FROM public.attendance_records
  WHERE session_id = p_session_id AND student_id = v_student_id;

  -- Enforced here rather than only in the browser: the RPC is granted to anon,
  -- so a hidden button is not a rule.
  IF v_state IN ('present', 'late') THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_present');
  END IF;

  IF v_state IN ('excused', 'exempted') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_an_absence');
  END IF;

  SELECT status INTO v_status
  FROM public.flagged
  WHERE student_id = v_student_id AND session_id = p_session_id;

  IF v_status = 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'denied');
  END IF;
  IF v_status IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_pending');
  END IF;

  INSERT INTO public.flagged (student_id, session_date, status, session_id, class_id)
  VALUES (v_student_id, v_session.session_date, 'flagged', p_session_id, v_session.class_id)
  ON CONFLICT (student_id, session_id) WHERE session_id IS NOT NULL DO NOTHING;

  RETURN jsonb_build_object(
    'success', true, 'session_id', p_session_id, 'class_id', v_session.class_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.flag_attendance(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.flag_attendance(text, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.flag_attendance(text, uuid) IS
  'A student disputes being marked absent at one session of their cohort — one '
  'they had joined by, or one they were marked on (042). Refuses a session they '
  'were marked present or late at, and one they were excused or exempted from.';
