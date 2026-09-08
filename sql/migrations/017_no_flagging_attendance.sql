-- ============================================================================
-- 017 — you cannot dispute a session you were marked present at
--
-- flag_attendance accepted a dispute against any session the student was
-- enrolled in, whatever was recorded. Nothing stopped somebody flagging a day
-- they had been marked present or late for, which is a dispute with no content:
-- the record already says they were there.
--
-- Worse than useless, it costs a TA the review. Every flag lands on the Review
-- Flags screen and has to be read, decided and resolved by hand, so a queue
-- full of "I was present" against records that already say present is time
-- taken from the disputes that mean something.
--
-- `excused` and `exempted` are also refused: both are decisions a TA made
-- deliberately, and neither is a claim that the student was absent. What
-- remains flaggable is what a dispute is actually for — `unexcused`, and a
-- session with no record at all.
--
-- Run AFTER 016. Idempotent.
-- ============================================================================

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

  -- Only a session of a cohort they are actually in. Without this the endpoint
  -- would accept a flag against any session id somebody cared to send.
  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = v_student_id
      AND e.cohort_id = v_session.cohort_id
      AND e.enrolled_on <= v_session.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date)
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
  'A student disputes being marked absent at one session. Refuses a session '
  'they were marked present or late at — there is nothing to dispute — and one '
  'they were excused or exempted from, which a TA decided deliberately.';
