-- ============================================================================
-- 013 — mark everyone present for one session
--
-- The room was full, the projector died, the PIN never went up, attendance went
-- round on paper. Without this the only route is one student at a time through
-- the correction control, which for a cohort of sixty is sixty round trips and
-- sixty rows in attendance_corrections.
--
-- What it deliberately does NOT do by default is overwrite a state somebody
-- chose:
--
--   unexcused, pending, no record  ->  present   (the point of the button)
--   present, late                  ->  left      (already accounted for, and
--                                                 late is the more specific
--                                                 truth)
--   excused, exempted              ->  left      (a decision a TA made, often
--                                                 with a reason attached)
--
-- p_overwrite => true takes everything except exempted, for the case where the
-- roll really is the record and whatever is stored is wrong. Exempted is never
-- touched: it means the session does not apply to that student at all, so
-- "everyone was here" cannot be a statement about them.
--
-- A `scheduled` session is closed as part of this, because a session that never
-- opened is excluded from every count — marking everyone present on one and
-- leaving it scheduled would look like nothing happened.
--
-- Every change goes through attendance_records, so the correction trigger from
-- 004 logs each overwritten state with who did it. Nothing here bypasses it.
--
-- Run AFTER 012. Idempotent.
-- ============================================================================

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

  -- Enrolled on the day, and not dropped before it: the same rule
  -- close_session uses, so the two cannot disagree about who was on the roster.
  DROP TABLE IF EXISTS tmp_roll;
  CREATE TEMP TABLE tmp_roll ON COMMIT DROP AS
  SELECT e.student_id
  FROM public.enrolments e
  WHERE e.cohort_id = v_session.cohort_id
    AND e.enrolled_on <= v_session.session_date
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
    -- protected. Derived from the roll so the three always sum to it — counting
    -- it separately missed anyone already marked present.
    'left_alone', v_roll - v_filled - v_changed
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.mark_all_present(uuid, public.attendance_state, boolean) FROM public;
GRANT EXECUTE ON FUNCTION
  public.mark_all_present(uuid, public.attendance_state, boolean) TO authenticated;

COMMENT ON FUNCTION public.mark_all_present(uuid, public.attendance_state, boolean) IS
  'Record one state for everyone enrolled in a session. By default only fills '
  'in students with no record or marked unexcused/pending; excused, exempted, '
  'present and late are left alone. p_overwrite takes everything but exempted. '
  'Closes the session if it was not already closed.';
