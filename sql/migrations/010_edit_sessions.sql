-- ============================================================================
-- 010 — editing sessions, and pushing a schedule change onto future ones
--
-- Two gaps left by 002 and 009.
--
-- A session's time and date could not be changed at all. generate_sessions is
-- ON CONFLICT DO NOTHING, so moving a cohort from Tuesday 09:00 to Tuesday
-- 14:00 in the schedule and regenerating did not move anything: it left every
-- 09:00 session in place and added a second one at 14:00, giving the cohort two
-- sessions a day and doubling everyone's denominator.
--
-- Both functions here refuse to touch a session that has already run. A closed
-- session has attendance recorded against it, an open one has students marking
-- into it right now, and a cancelled one is a decision somebody made. Rewriting
-- any of those changes what happened rather than what is going to happen — so
-- the rule throughout is that only `scheduled` sessions move.
--
-- Run AFTER 009. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- moved_manually — "somebody moved this one on purpose"
--
-- schedule_id cannot carry this. It is ON DELETE SET NULL, and
-- set_cohort_schedules replaces the slot rows wholesale, so every session in
-- the class loses its schedule_id the moment a pattern is edited — which is
-- precisely when apply_schedule_to_future needs to tell a hand-moved session
-- from one that simply came from the old pattern.
-- ----------------------------------------------------------------------------

ALTER TABLE public.class_sessions
  ADD COLUMN IF NOT EXISTS moved_manually boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.class_sessions.moved_manually IS
  'Set by update_session. apply_schedule_to_future leaves these alone.';

-- ----------------------------------------------------------------------------
-- update_session — change one session's date, time, length or notes
--
-- The caller passes a wall-clock date and time; this resolves the instant in
-- the class's own timezone, the same way generate_sessions and the
-- set_session_class_and_date trigger do. A browser must never send an instant
-- it computed itself — that is how the four disagreeing getDay() encodings the
-- session model replaced came about in the first place.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_session(
  p_session_id       uuid,
  p_date             date    DEFAULT NULL,
  p_start_time       time    DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL,
  p_notes            text    DEFAULT NULL
)
RETURNS public.class_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session  public.class_sessions%ROWTYPE;
  v_class    public.classes%ROWTYPE;
  v_date     date;
  v_time     time;
  v_starts   timestamptz;
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

  -- The cohort cannot be in two places at once, and idx_sessions_open_pin is
  -- not the only uniqueness that matters: (cohort_id, starts_at) is what stops
  -- a duplicate session, so say why rather than surfacing a constraint name.
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
     SET starts_at        = v_starts,
         session_date     = v_date,
         duration_minutes = COALESCE(p_duration_minutes, duration_minutes),
         notes            = COALESCE(p_notes, notes),
         -- It no longer matches the pattern it came from, and a later
         -- apply_schedule_to_future must not silently drag it back.
         moved_manually   = true
   WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_session(uuid, date, time, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.update_session(uuid, date, time, integer, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- apply_schedule_to_future — make future sessions match the current pattern
--
-- Called after set_cohort_schedules. Everything from p_from onward that has not
-- run yet is brought into line:
--
--   moved    a scheduled session on a weekday the cohort still meets, whose
--            time no longer matches the slot
--   removed  a scheduled session on a weekday the cohort no longer meets
--   created  a slot with no session yet
--
-- p_from defaults to today, so the past is never touched even when the caller
-- forgets to say so. Sessions edited by hand (moved_manually) are left alone:
-- someone moved that one deliberately.
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

  -- What the pattern says each future day should look like.
  CREATE TEMP TABLE tmp_wanted ON COMMIT DROP AS
  SELECT
    s.id AS schedule_id,
    s.cohort_id,
    d::date AS on_date,
    ((d::date + s.start_time) AT TIME ZONE v_class.timezone) AS starts_at,
    COALESCE(s.duration_minutes, v_class.default_duration_minutes) AS duration_minutes,
    COALESCE(s.delivery_mode,    v_class.default_delivery_mode)    AS delivery_mode
  FROM public.cohort_schedules s
  CROSS JOIN LATERAL generate_series(v_from, v_class.term_ends_on, INTERVAL '1 day') AS d
  WHERE s.class_id = p_class_id
    AND (p_cohort_ids IS NULL OR s.cohort_id = ANY (p_cohort_ids))
    AND EXTRACT(DOW FROM d)::smallint = s.weekday
    AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
    AND (s.effective_until IS NULL OR d::date <= s.effective_until);

  -- 1. Move a session whose weekday is still scheduled but whose time changed.
  --    Matched on (cohort, date) rather than on schedule_id, because the slot
  --    row is replaced wholesale by set_cohort_schedules and the old id is gone.
  WITH moved AS (
    UPDATE public.class_sessions s
       SET starts_at        = w.starts_at,
           duration_minutes = w.duration_minutes,
           delivery_mode    = w.delivery_mode,
           schedule_id      = w.schedule_id
      FROM tmp_wanted w
     WHERE s.cohort_id    = w.cohort_id
       AND s.session_date = w.on_date
       AND s.status       = 'scheduled'
       AND NOT s.moved_manually
       AND s.starts_at   <> w.starts_at
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
      v_class.default_late_window_minutes,
      v_class.default_auto_close_minutes,
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
