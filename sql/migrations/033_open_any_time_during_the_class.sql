-- ============================================================================
-- 033 — a session may open itself at any point during the class
--
-- WHAT 031 GOT WRONG
--
-- open_due_sessions would only open a session while
--
--   starts_at - early_open_minutes  <=  now  <=  starts_at + auto_close_minutes
--
-- The upper bound was meant to stop a sweep after downtime minting live PINs
-- for lectures that finished days ago. It does do that. But auto_close_minutes
-- is the length of the CHECK-IN window, not the length of the class, so on the
-- defaults it gave a twenty-minute chance around the start and then gave up —
-- for a class that runs an hour.
--
-- In practice that meant a TA who reached the dashboard twenty minutes into
-- their own lecture found a session that had never opened and never would, with
-- no indication why. Opening by hand worked, which made it look as though
-- auto-open was simply broken rather than expired.
--
-- THE RULE NOW
--
--   starts_at - early_open_minutes  <=  now  <=  starts_at + duration_minutes
--
-- Any time from the early-open allowance until the class is over. The guard
-- against reopening the past survives, because a class that ended yesterday
-- ended yesterday.
--
-- This does not lengthen anybody's check-in window. 028 already anchors the
-- window on whichever is later, the class starting or the session opening, so a
-- session opened forty minutes in still gets its full auto_close_minutes from
-- that moment — which is exactly what 006 intended for a session opened late.
--
-- WHAT IT DOES CHANGE
--
-- A class where the TA never appeared now opens by itself and stays open for
-- its window, rather than never opening at all. That is the behaviour the
-- schedule describes. If a class should not admit late check-ins at all, the
-- setting for that is auto_close_minutes, which is unaffected here.
--
-- Run AFTER 032. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.open_due_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id     uuid;
  v_opened integer := 0;
BEGIN
  FOR v_id IN
    SELECT s.id
    FROM public.class_sessions s
    WHERE s.status = 'scheduled'
      -- The allowance 028 defined: the point from which opening costs nothing.
      AND now() >= s.starts_at
                   - make_interval(mins => COALESCE(s.early_open_minutes, 0))
      -- Until the class is over. Not until the check-in window would have shut
      -- — that is a different and much shorter thing, and using it meant a
      -- lecture in progress could no longer open itself.
      --
      -- COALESCE because duration_minutes is NOT NULL with a default of 60, and
      -- a future migration relaxing that must not silently turn this into
      -- "opens only at the exact start time".
      AND now() <= s.starts_at
                   + make_interval(mins => COALESCE(s.duration_minutes, 60))
    ORDER BY s.starts_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.mint_session_pin(v_id);
    v_opened := v_opened + 1;
  END LOOP;

  RETURN v_opened;
END;
$fn$;

COMMENT ON FUNCTION public.open_due_sessions() IS
  'Opens every scheduled session between its early-open allowance and the end '
  'of the class. Opening late still gives a full check-in window, because 028 '
  'anchors that on whichever is later, the class start or the opening.';
