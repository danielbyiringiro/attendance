-- ============================================================================
-- Migration 011 — class length and sign-up window are two different numbers
--
-- The point of this migration is that a slot can say "this lab runs 3 hours
-- but check-in closes after 10 minutes". So the assertions are mostly that the
-- two numbers travel independently, and that an unset one still inherits.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class(
                'ASSERT-011', 'Sign-up windows',
                CURRENT_DATE - 30, CURRENT_DATE + 30,
                'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  CREATE TEMP TABLE t011 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- A long class with a short sign-up window, and a short class with a long one
-- ----------------------------------------------------------------------------

DO $independent$
DECLARE
  v_class  uuid := (SELECT class_id  FROM t011);
  v_cohort uuid := (SELECT cohort_id FROM t011);
  v_lab    public.class_sessions%ROWTYPE;
  v_sem    public.class_sessions%ROWTYPE;
BEGIN
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    '[{"weekday": 2, "start_time": "09:00",
       "duration_minutes": 180, "auto_close_minutes": 10,
       "late_window_minutes": 5},
      {"weekday": 4, "start_time": "14:00",
       "duration_minutes": 50, "auto_close_minutes": 45}]'::jsonb);

  PERFORM public.generate_sessions(v_class);

  SELECT * INTO v_lab
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND EXTRACT(DOW FROM session_date) = 2
  LIMIT 1;

  SELECT * INTO v_sem
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND EXTRACT(DOW FROM session_date) = 4
  LIMIT 1;

  IF v_lab.duration_minutes <> 180 THEN
    RAISE EXCEPTION 'the lab lost its 3-hour length: %', v_lab.duration_minutes;
  END IF;
  IF v_lab.auto_close_minutes <> 10 THEN
    RAISE EXCEPTION
      'the lab did not get its 10-minute sign-up window: %', v_lab.auto_close_minutes;
  END IF;
  IF v_lab.late_window_minutes <> 5 THEN
    RAISE EXCEPTION 'the lab did not get its late window: %', v_lab.late_window_minutes;
  END IF;

  IF v_sem.duration_minutes <> 50 THEN
    RAISE EXCEPTION 'the seminar lost its length: %', v_sem.duration_minutes;
  END IF;
  IF v_sem.auto_close_minutes <> 45 THEN
    RAISE EXCEPTION
      'the seminar did not get its 45-minute sign-up window: %', v_sem.auto_close_minutes;
  END IF;

  -- Unset on that slot, so it must fall back to the class default rather than
  -- to the other slot's value or to zero.
  IF v_sem.late_window_minutes <>
     (SELECT default_late_window_minutes FROM public.classes WHERE id = v_class)
  THEN
    RAISE EXCEPTION
      'an unset late window did not inherit the class default: %',
      v_sem.late_window_minutes;
  END IF;
END
$independent$;

-- ----------------------------------------------------------------------------
-- Changing only the sign-up window still reaches the future sessions
--
-- The move step used to fire on `starts_at <> starts_at` alone, so a window
-- edit would have been saved to the pattern and silently never applied.
-- ----------------------------------------------------------------------------

DO $window_only$
DECLARE
  v_class  uuid := (SELECT class_id  FROM t011);
  v_cohort uuid := (SELECT cohort_id FROM t011);
  v_result jsonb;
  v_stale  integer;
BEGIN
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    '[{"weekday": 2, "start_time": "09:00",
       "duration_minutes": 180, "auto_close_minutes": 25,
       "late_window_minutes": 5},
      {"weekday": 4, "start_time": "14:00",
       "duration_minutes": 50, "auto_close_minutes": 45}]'::jsonb);

  v_result := public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  IF (v_result ->> 'moved')::int = 0 THEN
    RAISE EXCEPTION
      'a sign-up window change moved nothing: %', v_result;
  END IF;

  SELECT count(*) INTO v_stale
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
    AND session_date >= CURRENT_DATE
    AND status = 'scheduled'
    AND EXTRACT(DOW FROM session_date) = 2
    AND auto_close_minutes <> 25;

  IF v_stale > 0 THEN
    RAISE EXCEPTION
      '% future Tuesday sessions kept the old sign-up window', v_stale;
  END IF;

  -- And the past kept its old window: those sessions already happened.
  IF EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE cohort_id = v_cohort
      AND session_date < CURRENT_DATE
      AND EXTRACT(DOW FROM session_date) = 2
      AND auto_close_minutes = 25
  ) THEN
    RAISE EXCEPTION 'a past session had its sign-up window rewritten';
  END IF;
END
$window_only$;

-- ----------------------------------------------------------------------------
-- Nonsense windows are refused
-- ----------------------------------------------------------------------------

DO $refusals$
DECLARE
  v_cohort uuid := (SELECT cohort_id FROM t011);
  v_msg    text;
BEGIN
  -- A late window past the end of check-in can never fire.
  BEGIN
    PERFORM public.set_cohort_schedules(
      ARRAY[v_cohort],
      '[{"weekday": 2, "start_time": "09:00",
         "auto_close_minutes": 10, "late_window_minutes": 30}]'::jsonb);
    RAISE EXCEPTION 'accepted a late window longer than the sign-up window';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'accepted a late window longer than the sign-up window' THEN
      RAISE;
    END IF;
  END;

  -- A zero-minute sign-up window closes before anyone can use it.
  BEGIN
    PERFORM public.set_cohort_schedules(
      ARRAY[v_cohort],
      '[{"weekday": 2, "start_time": "09:00", "auto_close_minutes": 0}]'::jsonb);
    RAISE EXCEPTION 'accepted a zero-minute sign-up window';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'accepted a zero-minute sign-up window' THEN
      RAISE;
    END IF;
  END;
END
$refusals$;

-- ----------------------------------------------------------------------------
-- update_session sets the window on one session, and holds the same rule
-- ----------------------------------------------------------------------------

DO $per_session$
DECLARE
  v_cohort  uuid := (SELECT cohort_id FROM t011);
  v_session uuid;
  v_msg     text;
BEGIN
  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
    AND session_date > CURRENT_DATE
    AND status = 'scheduled'
  ORDER BY session_date LIMIT 1;

  PERFORM public.update_session(
    v_session, NULL, NULL, NULL, NULL,
    p_auto_close_minutes  => 60,
    p_late_window_minutes => 15);

  IF (SELECT auto_close_minutes FROM public.class_sessions WHERE id = v_session) <> 60 THEN
    RAISE EXCEPTION 'update_session did not set the sign-up window';
  END IF;
  IF (SELECT late_window_minutes FROM public.class_sessions WHERE id = v_session) <> 15 THEN
    RAISE EXCEPTION 'update_session did not set the late window';
  END IF;

  -- The class length was not passed, so it must be untouched.
  IF (SELECT duration_minutes FROM public.class_sessions WHERE id = v_session) NOT IN (180, 50) THEN
    RAISE EXCEPTION 'update_session changed the class length when it was not asked to';
  END IF;

  BEGIN
    PERFORM public.update_session(
      v_session, NULL, NULL, NULL, NULL,
      p_auto_close_minutes  => 5,
      p_late_window_minutes => 30);
    RAISE EXCEPTION 'update_session accepted a late window past the sign-up window';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'update_session accepted a late window past the sign-up window' THEN
      RAISE;
    END IF;
  END;
END
$per_session$;

DO $done$ BEGIN RAISE NOTICE '011 sign-up window assertions passed'; END $done$;

ROLLBACK;
