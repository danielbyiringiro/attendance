-- ============================================================================
-- 035 — add one session on one date, outside the weekly pattern
--
-- WHAT IS MISSING
--
-- Every session in the database was produced by the weekly pattern. Both
-- INSERTs into class_sessions live inside generate_sessions and
-- apply_schedule_to_future, so a catch-up class, a lecture moved to a Saturday
-- or an extra lab simply cannot be recorded. The nearest thing a TA can do is
-- move an existing session onto that date, which is only possible if there
-- happens to be a spare one.
--
-- NO NEW SCHEMA IS NEEDED, AND THAT IS NOT A COINCIDENCE
--
-- class_sessions.schedule_id is nullable and moved_manually already exists, so
--
--   schedule_id IS NULL AND moved_manually = true
--
-- already means exactly "a date somebody added by hand". 010 added
-- moved_manually for the neighbouring problem — telling a hand-moved session
-- from a generated one, because set_cohort_schedules replaces slot rows
-- wholesale and schedule_id is ON DELETE SET NULL — and the flag turns out to
-- describe this case too.
--
-- The consequence that matters is already implemented: apply_schedule_to_future
-- skips anything flagged, both when moving sessions and when deleting ones the
-- pattern no longer wants. So a date added by hand survives a schedule change,
-- which is the whole point of adding it by hand. That is asserted rather than
-- assumed.
--
-- WHY IT IS NOT BOUND TO THE TERM
--
-- generate_sessions refuses to work outside term_starts_on..term_ends_on,
-- correctly: a pattern expanded past the end of term would invent sessions
-- nobody asked for. A hand-added date is the opposite — somebody asked for this
-- one specifically — and a make-up class in the week after teaching ends is a
-- normal reason to want it. The date is checked for sanity, not for membership
-- of the term.
--
-- Run AFTER 034. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_ad_hoc_session(
  p_cohort_id        uuid,
  p_date             date,
  p_start_time       time,
  p_duration_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_cohort   public.cohorts%ROWTYPE;
  v_starts   timestamptz;
  v_id       uuid;
  v_clash    timestamptz;
BEGIN
  SELECT * INTO v_cohort FROM public.cohorts WHERE id = p_cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that cohort does not exist';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_cohort.class_id;

  IF NOT public.can_manage_class(v_class.id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_date IS NULL OR p_start_time IS NULL THEN
    RAISE EXCEPTION 'a date and a start time are both required';
  END IF;

  IF COALESCE(p_duration_minutes, v_class.default_duration_minutes) <= 0 THEN
    RAISE EXCEPTION 'a session has to last longer than zero minutes';
  END IF;

  -- Built from the class's own wall clock, exactly as generate_sessions does.
  -- Taking the server's timezone here would put a 09:00 class at 09:00 UTC and
  -- the session_date could land on the wrong day either side of midnight.
  v_starts := ((p_date + p_start_time) AT TIME ZONE v_class.timezone);

  -- A friendly refusal rather than a unique-violation from the constraint. The
  -- TA picked this time; telling them what is already there is more use than
  -- telling them the insert failed.
  SELECT starts_at INTO v_clash
  FROM public.class_sessions
  WHERE cohort_id = p_cohort_id AND starts_at = v_starts;

  IF FOUND THEN
    RAISE EXCEPTION
      'this cohort already has a session at that time on %', p_date;
  END IF;

  INSERT INTO public.class_sessions (
    class_id, cohort_id, schedule_id, starts_at, session_date,
    duration_minutes, delivery_mode, status, method,
    late_window_minutes, auto_close_minutes, early_open_minutes,
    moved_manually
  )
  VALUES (
    v_class.id, p_cohort_id, NULL, v_starts, p_date,
    COALESCE(p_duration_minutes, v_class.default_duration_minutes),
    v_class.default_delivery_mode, 'scheduled', v_class.default_method,
    v_class.default_late_window_minutes,
    v_class.default_auto_close_minutes,
    v_class.default_early_open_minutes,
    -- The flag IS the feature. Without it the next schedule save deletes this
    -- session, because the pattern does not want that day and step 2 of
    -- apply_schedule_to_future removes exactly those.
    true
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'session_id',   v_id,
    'starts_at',    v_starts,
    'session_date', p_date,
    'cohort',       v_cohort.label,
    -- Said back so the screen can warn without doing its own date arithmetic.
    -- A session outside the term is allowed on purpose, and is still worth
    -- mentioning: it will not appear in a term-wide report.
    'outside_term', p_date < v_class.term_starts_on
                 OR p_date > v_class.term_ends_on
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_ad_hoc_session(uuid, date, time, integer)
  FROM public;
GRANT EXECUTE ON FUNCTION public.create_ad_hoc_session(uuid, date, time, integer)
  TO authenticated;

COMMENT ON FUNCTION public.create_ad_hoc_session(uuid, date, time, integer) IS
  'One session on one date, outside the weekly pattern — a catch-up class, a '
  'moved lecture, an extra lab. Flagged moved_manually so a later schedule '
  'change neither moves it nor deletes it. Not restricted to the term.';
