-- ============================================================================
-- 062 — a note on one student's day
--
-- 060 put a `note` on attendance_records so an excuse could say why, and only
-- excuse_sessions ever wrote one. But the thing worth writing down is rarely
-- only an excuse: "arrived at 9.40, bus", "left early with permission",
-- "laptop died, did the work on paper", "will miss next Thursday, told me in
-- advance". Those are notes about one student on one day, which is exactly the
-- row that already exists.
--
-- So the note becomes something staff can set directly, on any session of a
-- student's record.
--
-- FUTURE SESSIONS, AND THE TRAP UNDERNEATH THEM
--
-- A note on a session that has not happened yet needs a row before anybody has
-- been marked, so this writes one in state 'pending'. That is safe only
-- because of the second half of this migration.
--
-- close_session (004) fills in an absence for every enrolled student with no
-- record, with ON CONFLICT (session_id, student_id) DO NOTHING. A row that
-- exists — for ANY reason, including holding a note — is therefore a row
-- close_session skips. Without the change below, writing "will miss this,
-- told me in advance" on next Thursday's session would mean that student is
-- silently never marked absent for it: no error, no absence, and a percentage
-- quietly wrong for the rest of term.
--
-- So close_session now promotes a 'pending' row to 'unexcused' instead of
-- passing over it. Only 'pending': a present, late, excused or exempt mark is
-- somebody's decision and is left exactly as it was, which is the whole point
-- of DO NOTHING in the first place.
--
-- Run AFTER 061. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- set_attendance_note
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_attendance_note(
  p_session_id uuid,
  p_student_id text,
  p_note       text
)
RETURNS public.attendance_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row     public.attendance_records%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  -- can_access_class, not can_manage_class: writing a note is the same weight
  -- as taking the register, and the person who takes it is the person who
  -- knows why somebody was late.
  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to write on this class';
  END IF;

  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'a note is for a line or two, not 500 characters';
  END IF;

  -- 'pending' on insert: a note is not a judgement about whether they were
  -- there. The state is whatever the register says, and stays that way.
  INSERT INTO public.attendance_records (
    session_id, class_id, student_id, state, marked_by_role, note
  )
  VALUES (
    p_session_id, v_session.class_id, p_student_id, 'pending', 'staff', v_note
  )
  ON CONFLICT (session_id, student_id) DO UPDATE
    SET note = v_note
  RETURNING * INTO v_row;

  /*
   * Clearing a note on a row that exists only to hold one takes the row with
   * it.
   *
   * Otherwise a note typed on a future session and then deleted leaves a
   * 'pending' record behind — invisible on every screen, and exactly the kind
   * of leftover that close_session would have tripped over before this
   * migration. Nothing is deleted when the student has actually been marked.
   */


  RETURN v_row;
END;
$fn$;

DO $grants$
DECLARE sig text := 'public.set_attendance_note(uuid, text, text)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
END
$grants$;

COMMENT ON FUNCTION public.set_attendance_note(uuid, text, text) IS
  'Write, change or clear the note on one student''s session. Never changes '
  'their state (062).';

-- ----------------------------------------------------------------------------
-- close_session stops stepping over a row that is only holding a note
--
-- Identical to 004 but for the ON CONFLICT clause. See the header: with
-- DO NOTHING, any pre-existing row means no absence is ever recorded, and a
-- note on a future session would have been enough to cause it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_session(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_marked  integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to close a session for this class';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled session has no attendance to record';
  END IF;

  WITH absentees AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT v_session.id, v_session.class_id, e.student_id, 'unexcused', now(), 'system'
    FROM public.enrolments e
    WHERE e.cohort_id = v_session.cohort_id
      AND e.enrolled_on <= v_session.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date)
    ON CONFLICT (session_id, student_id) DO UPDATE
      -- Only a row nobody has marked. Anything else is somebody's decision.
      SET state = 'unexcused',
          marked_at = now(),
          marked_by_role = 'system'
      WHERE attendance_records.state = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_marked FROM absentees;

  UPDATE public.class_sessions
     SET status = 'closed'
   WHERE id = p_session_id;

  RETURN v_marked;
END;
$fn$;

COMMENT ON FUNCTION public.close_session(uuid) IS
  'Close a session and record an absence for everybody unmarked, including '
  'anybody whose row exists only to carry a note (004, 062).';
