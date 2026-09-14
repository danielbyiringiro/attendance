-- ============================================================================
-- 040 — set the check-in timing for a cohort, or the whole class, in one place
--
-- WHAT WAS MISSING
--
-- How long sign-up stays open and how early check-in may open are stored in
-- three places: the class defaults, each weekly slot (011 and 029), and every
-- generated session, which copies its values at creation. The only ways to
-- change them were a slot at a time in the Schedule editor, or a session at a
-- time in the edit dialog. Changing the sign-up window for a cohort meant
-- editing every slot and then every already-generated session by hand.
--
-- And the class default for early open could not be changed at all.
-- update_class accepts default_auto_close_minutes but has no parameter for
-- default_early_open_minutes, so it has sat at its initial value since 001.
--
-- WHAT THIS CHANGES, AND WHAT IT LEAVES
--
-- For one cohort, or every cohort when p_cohort_id is NULL:
--
--   the weekly slots                    so future generation matches
--   upcoming sessions still scheduled   so this term matches
--   the class defaults (all cohorts)    so new cohorts and hand-added dates match
--
-- It does NOT touch a session that is open, closed, cancelled, dated before
-- today in the class's own timezone, or has any attendance recorded against it.
-- A running window changing length under students is worse than the old value,
-- and a session with marks already has history — the same rule 034 applies to
-- schedule edits. Those are counted and returned as `kept`, so the screen can
-- say why the number is smaller than expected.
--
-- Either value may be NULL to leave it as it is. Both NULL is refused.
--
-- Run AFTER 039. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_session_windows(
  p_class_id           uuid,
  p_cohort_id          uuid    DEFAULT NULL,
  p_auto_close_minutes integer DEFAULT NULL,
  p_early_open_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_today    date;
  v_slots    integer := 0;
  v_sessions integer := 0;
  v_kept     integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that class does not exist';
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_auto_close_minutes IS NULL AND p_early_open_minutes IS NULL THEN
    RAISE EXCEPTION 'nothing to change: give a sign-up window, an early-open time, or both';
  END IF;

  -- Upper bounds catch a slipped digit. A 900-minute sign-up window is almost
  -- certainly a typo for 90, and it would leave check-in open all day.
  IF p_auto_close_minutes IS NOT NULL
     AND (p_auto_close_minutes < 1 OR p_auto_close_minutes > 600) THEN
    RAISE EXCEPTION 'the sign-up window must be between 1 and 600 minutes, not %',
      p_auto_close_minutes;
  END IF;

  IF p_early_open_minutes IS NOT NULL
     AND (p_early_open_minutes < 0 OR p_early_open_minutes > 600) THEN
    RAISE EXCEPTION 'opening early must be between 0 and 600 minutes, not %',
      p_early_open_minutes;
  END IF;

  IF p_cohort_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cohorts
    WHERE id = p_cohort_id AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'that cohort is not part of this class';
  END IF;

  -- Today in the class's timezone, not the server's. A class in Accra and a
  -- server in UTC disagree about the date for part of every day.
  v_today := (now() AT TIME ZONE v_class.timezone)::date;

  -- Class defaults, only when the whole class was chosen. A setting for one
  -- cohort must not become what every other cohort inherits.
  IF p_cohort_id IS NULL THEN
    UPDATE public.classes
       SET default_auto_close_minutes =
             COALESCE(p_auto_close_minutes, default_auto_close_minutes),
           default_early_open_minutes =
             COALESCE(p_early_open_minutes, default_early_open_minutes)
     WHERE id = p_class_id;
  END IF;

  UPDATE public.cohort_schedules
     SET auto_close_minutes = COALESCE(p_auto_close_minutes, auto_close_minutes),
         early_open_minutes = COALESCE(p_early_open_minutes, early_open_minutes)
   WHERE class_id = p_class_id
     AND (p_cohort_id IS NULL OR cohort_id = p_cohort_id);
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  -- Counted before the update, so `kept` describes exactly the sessions the
  -- update is about to skip.
  SELECT count(*) INTO v_kept
  FROM public.class_sessions s
  WHERE s.class_id = p_class_id
    AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
    AND s.status = 'scheduled'
    AND s.session_date >= v_today
    AND EXISTS (SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id);

  UPDATE public.class_sessions s
     SET auto_close_minutes = COALESCE(p_auto_close_minutes, s.auto_close_minutes),
         early_open_minutes = COALESCE(p_early_open_minutes, s.early_open_minutes)
   WHERE s.class_id = p_class_id
     AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
     AND s.status = 'scheduled'
     AND s.session_date >= v_today
     AND NOT EXISTS (
       SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
     );
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN jsonb_build_object(
    'slots',            v_slots,
    'sessions',         v_sessions,
    'kept',             v_kept,
    'defaults_updated', p_cohort_id IS NULL
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_session_windows(uuid, uuid, integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.set_session_windows(uuid, uuid, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.set_session_windows(uuid, uuid, integer, integer) IS
  'Set the sign-up window and early-open time for one cohort, or the whole '
  'class when cohort is NULL: its weekly slots, its upcoming scheduled sessions '
  'with nothing recorded, and (whole class only) the class defaults. Never '
  'touches a session that is open, closed, past, or already marked.';
