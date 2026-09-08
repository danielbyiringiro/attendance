-- ============================================================================
-- 011 — the sign-up window belongs to the slot, not just the class
--
-- Two different lengths were collapsed into one settable number.
--
--   duration_minutes    how long the class runs
--   auto_close_minutes  how long check-in stays open after the TA opens it
--   late_window_minutes how long after opening a mark still counts as present
--                       rather than late
--
-- Only the first could vary per meeting. The other two came from the class
-- defaults at generation time, so a three-hour lab and a fifty-minute seminar
-- in the same class were stuck with the same sign-up window — and the schedule
-- editor showed a single "min" box that looked like it governed both.
--
-- Both are nullable here and inherit the class default when unset, which is
-- what every existing row does. Applying this changes no behaviour on its own.
--
-- Run AFTER 010. Idempotent.
-- ============================================================================

ALTER TABLE public.cohort_schedules
  ADD COLUMN IF NOT EXISTS auto_close_minutes  integer,
  ADD COLUMN IF NOT EXISTS late_window_minutes integer;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cohort_schedules_windows_nonnegative'
  ) THEN
    ALTER TABLE public.cohort_schedules
      ADD CONSTRAINT cohort_schedules_windows_nonnegative CHECK (
        (auto_close_minutes  IS NULL OR auto_close_minutes  >= 0) AND
        (late_window_minutes IS NULL OR late_window_minutes >= 0)
      );
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.cohort_schedules.duration_minutes IS
  'How long the class runs. NULL inherits classes.default_duration_minutes.';
COMMENT ON COLUMN public.cohort_schedules.auto_close_minutes IS
  'How long check-in stays open after the session is opened. NULL inherits '
  'classes.default_auto_close_minutes.';
COMMENT ON COLUMN public.cohort_schedules.late_window_minutes IS
  'How long after opening a mark still counts as present rather than late. '
  'NULL inherits classes.default_late_window_minutes.';

-- ----------------------------------------------------------------------------
-- set_cohort_schedules — same signature, two more optional keys per slot
--
-- A slot that omits them behaves exactly as before, so a caller that has not
-- been updated keeps working.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_cohort_schedules(
  p_cohort_ids uuid[],
  p_slots      jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class_ids uuid[];
  v_class_id  uuid;
  v_created   integer := 0;
  v_added     integer;
BEGIN
  IF p_cohort_ids IS NULL OR array_length(p_cohort_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no cohorts given';
  END IF;

  SELECT array_agg(DISTINCT class_id) INTO v_class_ids
  FROM public.cohorts WHERE id = ANY (p_cohort_ids);

  IF v_class_ids IS NULL THEN
    RAISE EXCEPTION 'none of those cohorts exist';
  END IF;

  IF array_length(v_class_ids, 1) > 1 THEN
    RAISE EXCEPTION 'those cohorts belong to different classes';
  END IF;

  v_class_id := v_class_ids[1];
  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF (SELECT count(*) FROM public.cohorts
      WHERE id = ANY (p_cohort_ids) AND class_id = v_class_id)
     <> array_length(p_cohort_ids, 1)
  THEN
    RAISE EXCEPTION 'one of those cohorts does not exist';
  END IF;

  -- Validate before deleting anything, so a bad slot cannot wipe a schedule
  -- and then fail.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'weekday') IS NULL
       OR (sl ->> 'weekday')::int NOT BETWEEN 0 AND 6
       OR NULLIF(btrim(COALESCE(sl ->> 'start_time', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION
      'every slot needs a weekday between 0 (Sunday) and 6 (Saturday) and a start time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'duration_minutes') IS NOT NULL
      AND (sl ->> 'duration_minutes')::int <= 0
  ) THEN
    RAISE EXCEPTION 'a slot duration must be greater than zero';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'auto_close_minutes') IS NOT NULL
      AND (sl ->> 'auto_close_minutes')::int <= 0
  ) THEN
    RAISE EXCEPTION
      'a sign-up window must be greater than zero — a zero-minute window can never be used';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'late_window_minutes') IS NOT NULL
      AND (sl ->> 'late_window_minutes')::int < 0
  ) THEN
    RAISE EXCEPTION 'a late window cannot be negative';
  END IF;

  -- A late window past the end of the sign-up window is unreachable: check-in
  -- has already closed, so nobody can ever be marked late.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'late_window_minutes') IS NOT NULL
      AND (sl ->> 'auto_close_minutes') IS NOT NULL
      AND (sl ->> 'late_window_minutes')::int > (sl ->> 'auto_close_minutes')::int
  ) THEN
    RAISE EXCEPTION
      'the late window cannot be longer than the sign-up window — check-in would already have closed';
  END IF;

  DELETE FROM public.cohort_schedules WHERE cohort_id = ANY (p_cohort_ids);

  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time,
    duration_minutes, auto_close_minutes, late_window_minutes)
  SELECT
    v_class_id,
    c.cohort_id,
    (sl ->> 'weekday')::smallint,
    (sl ->> 'start_time')::time,
    NULLIF(sl ->> 'duration_minutes', '')::integer,
    NULLIF(sl ->> 'auto_close_minutes', '')::integer,
    NULLIF(sl ->> 'late_window_minutes', '')::integer
  FROM unnest(p_cohort_ids) AS c(cohort_id)
  CROSS JOIN jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
  ON CONFLICT (cohort_id, weekday, start_time) DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_created := v_added;

  RETURN v_created;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) TO authenticated;

COMMENT ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) IS
  'Replace the meeting pattern for one or more cohorts of a single class. Each '
  'slot carries its own start time, class length, sign-up window and late '
  'window; omitted values inherit the class defaults.';

-- ----------------------------------------------------------------------------
-- generate_sessions — carry the slot's windows onto the sessions it creates
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_sessions(
  p_class_id  uuid,
  p_cohort_id uuid DEFAULT NULL,
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class   public.classes%ROWTYPE;
  v_from    date;
  v_to      date;
  v_created integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  v_from := COALESCE(p_from, v_class.term_starts_on);
  v_to   := COALESCE(p_to,   v_class.term_ends_on);

  IF v_to < v_from THEN
    RAISE EXCEPTION 'generate_sessions: % is before %', v_to, v_from;
  END IF;

  WITH candidate AS (
    SELECT
      s.id   AS schedule_id,
      s.cohort_id,
      d::date AS on_date,
      -- Build the instant from the class's own wall clock, not the server's.
      ((d::date + s.start_time) AT TIME ZONE v_class.timezone) AS starts_at,
      COALESCE(s.duration_minutes,    v_class.default_duration_minutes)    AS duration_minutes,
      COALESCE(s.delivery_mode,       v_class.default_delivery_mode)       AS delivery_mode,
      COALESCE(s.auto_close_minutes,  v_class.default_auto_close_minutes)  AS auto_close_minutes,
      COALESCE(s.late_window_minutes, v_class.default_late_window_minutes) AS late_window_minutes
    FROM public.cohort_schedules s
    CROSS JOIN LATERAL generate_series(v_from, v_to, INTERVAL '1 day') AS d
    WHERE s.class_id = p_class_id
      AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
      AND EXTRACT(DOW FROM d)::smallint = s.weekday
      AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
      AND (s.effective_until IS NULL OR d::date <= s.effective_until)
  ),
  inserted AS (
    INSERT INTO public.class_sessions (
      class_id, cohort_id, schedule_id, starts_at, session_date,
      duration_minutes, delivery_mode, status, method,
      late_window_minutes, auto_close_minutes, early_open_minutes
    )
    SELECT
      p_class_id, c.cohort_id, c.schedule_id, c.starts_at, c.on_date,
      c.duration_minutes, c.delivery_mode, 'scheduled', v_class.default_method,
      c.late_window_minutes,
      c.auto_close_minutes,
      v_class.default_early_open_minutes
    FROM candidate c
    ON CONFLICT (cohort_id, starts_at) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$fn$;

REVOKE ALL ON FUNCTION public.generate_sessions(uuid, uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_sessions(uuid, uuid, date, date) TO authenticated;

-- ----------------------------------------------------------------------------
-- apply_schedule_to_future — carry the windows too
--
-- Same rules as 010: only `scheduled` sessions move, the past is never
-- touched, and a session cancelled or moved by hand is left alone.
-- ----------------------------------------------------------------------------

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
    COALESCE(s.late_window_minutes, v_class.default_late_window_minutes) AS late_window_minutes
  FROM public.cohort_schedules s
  CROSS JOIN LATERAL generate_series(v_from, v_class.term_ends_on, INTERVAL '1 day') AS d
  WHERE s.class_id = p_class_id
    AND (p_cohort_ids IS NULL OR s.cohort_id = ANY (p_cohort_ids))
    AND EXTRACT(DOW FROM d)::smallint = s.weekday
    AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
    AND (s.effective_until IS NULL OR d::date <= s.effective_until);

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
           schedule_id         = w.schedule_id
      FROM tmp_wanted w
     WHERE s.cohort_id    = w.cohort_id
       AND s.session_date = w.on_date
       AND s.status       = 'scheduled'
       AND NOT s.moved_manually
       AND (s.starts_at           <> w.starts_at
         OR s.duration_minutes    <> w.duration_minutes
         OR s.auto_close_minutes  <> w.auto_close_minutes
         OR s.late_window_minutes <> w.late_window_minutes)
       -- Never collide with a session that is already at the target time.
       AND NOT EXISTS (
         SELECT 1 FROM public.class_sessions o
         WHERE o.cohort_id = w.cohort_id
           AND o.starts_at = w.starts_at
           AND o.id <> s.id
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
      v_class.default_early_open_minutes
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
    'created', v_created
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_schedule_to_future(uuid, uuid[], date) FROM public;
GRANT EXECUTE ON FUNCTION public.apply_schedule_to_future(uuid, uuid[], date) TO authenticated;

-- ----------------------------------------------------------------------------
-- update_session — the sign-up window is editable per session too
--
-- Extends 010's signature with two optional arguments. Same rule: only a
-- session that has not run yet.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_session(
  p_session_id         uuid,
  p_date               date    DEFAULT NULL,
  p_start_time         time    DEFAULT NULL,
  p_duration_minutes   integer DEFAULT NULL,
  p_notes              text    DEFAULT NULL,
  p_auto_close_minutes integer DEFAULT NULL,
  p_late_window_minutes integer DEFAULT NULL
)
RETURNS public.class_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_class   public.classes%ROWTYPE;
  v_date    date;
  v_time    time;
  v_starts  timestamptz;
  v_close   integer;
  v_late    integer;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_session.class_id;

  IF NOT public.can_manage_class(v_session.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF v_session.status <> 'scheduled' THEN
    RAISE EXCEPTION
      'this session is %, so its time cannot be changed — only sessions that have not run yet can be moved',
      v_session.status;
  END IF;

  v_date := COALESCE(p_date, v_session.session_date);
  v_time := COALESCE(
    p_start_time,
    (v_session.starts_at AT TIME ZONE v_class.timezone)::time
  );
  v_starts := (v_date + v_time) AT TIME ZONE v_class.timezone;

  v_close := COALESCE(p_auto_close_minutes,  v_session.auto_close_minutes);
  v_late  := COALESCE(p_late_window_minutes, v_session.late_window_minutes);

  IF v_close <= 0 THEN
    RAISE EXCEPTION
      'a sign-up window must be greater than zero — a zero-minute window can never be used';
  END IF;

  IF v_late > v_close THEN
    RAISE EXCEPTION
      'the late window cannot be longer than the sign-up window — check-in would already have closed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.class_sessions s
    WHERE s.cohort_id = v_session.cohort_id
      AND s.starts_at = v_starts
      AND s.id <> v_session.id
  ) THEN
    RAISE EXCEPTION
      'that cohort already has a session at % on %', v_time, v_date;
  END IF;

  UPDATE public.class_sessions
     SET starts_at           = v_starts,
         session_date        = v_date,
         duration_minutes    = COALESCE(p_duration_minutes, duration_minutes),
         auto_close_minutes  = v_close,
         late_window_minutes = v_late,
         notes               = COALESCE(p_notes, notes),
         moved_manually      = true
   WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$fn$;

-- 010's five-argument version would still resolve for callers that pass five
-- positional arguments, leaving two functions that drift apart. There is one
-- caller and it is in this repo.
DROP FUNCTION IF EXISTS public.update_session(uuid, date, time, integer, text);

REVOKE ALL ON FUNCTION
  public.update_session(uuid, date, time, integer, text, integer, integer)
  FROM public;
GRANT EXECUTE ON FUNCTION
  public.update_session(uuid, date, time, integer, text, integer, integer)
  TO authenticated;
