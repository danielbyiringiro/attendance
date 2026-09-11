-- ============================================================================
-- 032 — cancelling a class removes the attendance, all of it
--
-- WHAT IT DID
--
-- cancel_session deleted the 'unexcused' and 'pending' rows and kept everything
-- else. The reasoning at the time was that a student who had already marked
-- should not lose the fact that they turned up.
--
-- That is the wrong way round. If the class was cancelled, it did not happen,
-- and "present at a class that did not happen" is not a fact about a student —
-- it is a record of them having typed a PIN into a room that then emptied. The
-- rate already ignores cancelled sessions, so the row changed no percentage; it
-- just sat in the student's own history saying they attended something that was
-- called off, which is what prompted this.
--
-- The rule after this migration is the simple one, and it is the same rule the
-- rest of the schema already follows: a cancelled session has no attendance
-- facts, because there was nothing to attend.
--
-- WHAT THIS COSTS
--
-- Cancelling is now destructive, and uncancelling does not bring the marks
-- back. Before, an accidental cancel-then-uncancel lost only the absences,
-- which close_session would rewrite. Now it loses the check-ins too, and those
-- can only be restored by the students marking again or a TA taking the
-- register by hand.
--
-- That is a real trade and worth stating out loud rather than discovering. It
-- is accepted because the alternative is keeping data that asserts something
-- untrue, and because cancelling is a deliberate act with a confirmation in
-- front of it.
--
-- The return value is unchanged in meaning — how many rows were removed — but
-- it will now be larger, since it counts the check-ins as well.
--
-- Run AFTER 031. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_session(
  p_session_id uuid,
  p_reason     text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_removed integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to cancel a session for this class';
  END IF;

  -- Every state, not a list of them. A list is a place to forget one: 'late'
  -- and 'exempted' were already missing from the old filter, so a student who
  -- arrived late to a class that was then cancelled kept a 'late' record of it.
  WITH removed AS (
    DELETE FROM public.attendance_records
    WHERE session_id = p_session_id
    RETURNING 1
  )
  SELECT count(*) INTO v_removed FROM removed;

  UPDATE public.class_sessions
     SET status = 'cancelled',
         cancellation_reason = COALESCE(p_reason, cancellation_reason)
   WHERE id = p_session_id;

  RETURN v_removed;
END;
$fn$;

COMMENT ON FUNCTION public.cancel_session(uuid, text) IS
  'Cancel a session and delete every attendance record against it — a class '
  'that did not happen has no attendance. Destructive: uncancelling does not '
  'bring the check-ins back. Returns how many records were removed.';
