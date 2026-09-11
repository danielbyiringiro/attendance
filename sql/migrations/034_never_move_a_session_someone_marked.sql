-- ============================================================================
-- 034 — a schedule edit leaves any session that has attendance against it
--
-- THE ASSUMPTION THAT WAS WRONG
--
-- apply_schedule_to_future fences itself on status = 'scheduled', on the
-- reasoning that a session carrying attendance is open, closed or cancelled and
-- therefore out of reach.
--
-- It is not. setAttendanceState writes straight to attendance_records with no
-- check on session status, and the dashboard offers "Mark manually" on a
-- session that has not been opened — taking the register before starting
-- check-in is a normal thing to do. So a scheduled session can carry marks, and
-- both of the destructive steps could reach it.
--
-- Step 1 moves a session's start time. Mild: the records are keyed on
-- session_id and survive, the date cannot change, and the session simply claims
-- a different time of day.
--
-- Step 2 DELETES a scheduled session on a day the cohort no longer meets. That
-- one is not mild. attendance_records.session_id is ON DELETE CASCADE, so
-- dropping a weekday from a schedule would take every mark on those sessions
-- with it, without a word. A TA who took the register by hand and then tidied
-- the timetable would lose the register.
--
-- THE FIX
--
-- Fence on what is actually meant — "somebody has recorded something against
-- this" — rather than on a status that was standing in for it. Two NOT EXISTS
-- clauses, one on the update and one on the delete.
--
-- This can only ever narrow what the function touches. It adds no column, no
-- constraint and no data change, and a session with no marks behaves exactly as
-- before. A session with marks is now skipped and reported in neither `moved`
-- nor `removed`, which is the honest count: it was not.
--
-- WHAT IS DELIBERATELY NOT FIXED HERE
--
-- Step 1 matches on (cohort_id, session_date), which is ambiguous the moment a
-- cohort has two schedule slots on one weekday — the schema allows that, since
-- class_sessions is unique on (cohort_id, starts_at), the instant rather than
-- the date. Each session on that date matches both wanted rows and Postgres
-- picks one arbitrarily.
--
-- That is dormant: nothing today creates two slots on a weekday, and there is
-- no screen to. It belongs with whatever branch builds multiple sessions per
-- day, where it can be tested against the case it is for, rather than designed
-- against a use case that does not exist yet.
--
-- Run AFTER 033. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_schedule_to_future(
  p_class_id  uuid,
  p_cohort_ids uuid[] DEFAULT NULL,
  p_from      date    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class   public.classes%ROWTYPE;
  v_from    date;
  v_moved   integer := 0;
  v_removed integer := 0;
  v_created integer := 0;
  v_kept    integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  v_from := GREATEST(COALESCE(p_from, CURRENT_DATE), CURRENT_DATE);

  DROP TABLE IF EXISTS tmp_wanted;
  CREATE TEMP TABLE tmp_wanted ON COMMIT DROP AS
  SELECT
    s.id AS schedule_id,
    s.cohort_id,
    d::date AS on_date,
    ((d::date + s.start_time) AT TIME ZONE v_class.timezone) AS starts_at,
    COALESCE(s.duration_minutes,    v_class.default_duration_minutes)    AS duration_minutes,
    COALESCE(s.delivery_mode,       v_class.default_delivery_mode)       AS delivery_mode,
    COALESCE(s.auto_close_minutes,  v_class.default_auto_close_minutes)  AS auto_close_minutes,
    COALESCE(s.late_window_minutes, v_class.default_late_window_minutes) AS late_window_minutes,
    COALESCE(s.early_open_minutes,  v_class.default_early_open_minutes)  AS early_open_minutes
  FROM public.cohort_schedules s
  CROSS JOIN LATERAL generate_series(v_from, v_class.term_ends_on, INTERVAL '1 day') AS d
  WHERE s.class_id = p_class_id
    AND (p_cohort_ids IS NULL OR s.cohort_id = ANY (p_cohort_ids))
    AND EXTRACT(DOW FROM d)::smallint = s.weekday
    AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
    AND (s.effective_until IS NULL OR d::date <= s.effective_until);

  -- How many were left alone because somebody had already marked them. Counted
  -- and returned so the screen can say so, rather than a TA seeing "moved 11"
  -- where they expected 12 and having no way to find out which one stayed.
  SELECT count(*) INTO v_kept
  FROM public.class_sessions s
  WHERE s.class_id      = p_class_id
    AND s.status        = 'scheduled'
    AND s.session_date >= v_from
    AND (p_cohort_ids IS NULL OR s.cohort_id = ANY (p_cohort_ids))
    AND EXISTS (
      SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
    );

  -- 1. A session whose weekday is still scheduled: bring its time and windows
  --    into line. Matched on (cohort, date) rather than on schedule_id,
  --    because set_cohort_schedules replaces the slot rows wholesale.
  --
  --    Note this fires when only a window changed, not just the time — a
  --    sign-up window edit has to reach the sessions it governs.
  WITH moved AS (
    UPDATE public.class_sessions s
       SET starts_at           = w.starts_at,
           duration_minutes    = w.duration_minutes,
           delivery_mode       = w.delivery_mode,
           auto_close_minutes  = w.auto_close_minutes,
           late_window_minutes = w.late_window_minutes,
           early_open_minutes  = w.early_open_minutes,
           schedule_id         = w.schedule_id
      FROM tmp_wanted w
     WHERE s.cohort_id    = w.cohort_id
       AND s.session_date = w.on_date
       AND s.status       = 'scheduled'
       AND NOT s.moved_manually
       AND (s.starts_at           <> w.starts_at
         OR s.duration_minutes    <> w.duration_minutes
         OR s.auto_close_minutes  <> w.auto_close_minutes
         OR s.late_window_minutes <> w.late_window_minutes
         -- Without this an early-open change never reaches the sessions it
         -- governs: nothing else about them differs, so the row is skipped.
         OR s.early_open_minutes  IS DISTINCT FROM w.early_open_minutes)
       -- Never collide with a session that is already at the target time.
       AND NOT EXISTS (
         SELECT 1 FROM public.class_sessions o
         WHERE o.cohort_id = w.cohort_id
           AND o.starts_at = w.starts_at
           AND o.id <> s.id
       )
       -- 034: and never move one somebody has already marked. The register was
       -- taken for a class at a particular time; silently restamping it with a
       -- different one makes the record say something nobody asserted.
       AND NOT EXISTS (
         SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_moved FROM moved;

  -- 2. Drop a scheduled session on a day the cohort no longer meets.
  WITH removed AS (
    DELETE FROM public.class_sessions s
     WHERE s.class_id      = p_class_id
       AND s.status        = 'scheduled'
       AND NOT s.moved_manually
       AND s.session_date >= v_from
       AND (p_cohort_ids IS NULL OR s.cohort_id = ANY (p_cohort_ids))
       AND NOT EXISTS (
         SELECT 1 FROM tmp_wanted w
         WHERE w.cohort_id = s.cohort_id
           AND w.on_date   = s.session_date
       )
       -- 034: and never delete one with attendance against it.
       -- attendance_records.session_id is ON DELETE CASCADE, so without this a
       -- TA who took the register by hand and then tidied the timetable would
       -- lose the register, with nothing said and nothing to recover from.
       AND NOT EXISTS (
         SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_removed FROM removed;

  -- 3. Create anything the pattern wants that does not exist yet.
  WITH created AS (
    INSERT INTO public.class_sessions (
      class_id, cohort_id, schedule_id, starts_at, session_date,
      duration_minutes, delivery_mode, status, method,
      late_window_minutes, auto_close_minutes, early_open_minutes
    )
    SELECT
      p_class_id, w.cohort_id, w.schedule_id, w.starts_at, w.on_date,
      w.duration_minutes, w.delivery_mode, 'scheduled', v_class.default_method,
      w.late_window_minutes,
      w.auto_close_minutes,
      w.early_open_minutes
    FROM tmp_wanted w
    -- A day that already has a session for this cohort keeps it, whatever its
    -- status: a cancelled Wednesday must not come back as a new session.
    WHERE NOT EXISTS (
      SELECT 1 FROM public.class_sessions s
      WHERE s.cohort_id = w.cohort_id AND s.session_date = w.on_date
    )
    ON CONFLICT (cohort_id, starts_at) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM created;

  DROP TABLE IF EXISTS tmp_wanted;

  RETURN jsonb_build_object(
    'from',    v_from,
    'moved',   v_moved,
    'removed', v_removed,
    'created', v_created,
    -- New in 034. Absent from older callers, which read the three they know.
    'kept',    v_kept
  );
END;
$fn$;

COMMENT ON FUNCTION public.apply_schedule_to_future(uuid, uuid[], date) IS
  'Push a schedule change onto future sessions: move those whose time changed, '
  'drop those on days the cohort no longer meets, create the missing ones. '
  'Never touches a session that already has attendance recorded against it, '
  'whatever its status; those are counted in "kept".';
