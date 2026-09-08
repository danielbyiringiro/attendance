-- ============================================================================
-- Migration 010 — moving sessions, and only the ones that have not happened
--
-- The interesting half is what these functions REFUSE to do. A schedule change
-- that quietly rewrote a closed session would move attendance already recorded
-- against it onto a different day, and nothing downstream would notice.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- ----------------------------------------------------------------------------
-- A class meeting Tuesday 09:00 and Thursday 09:00, with a term that runs from
-- well before today to well after it, so "future" and "past" both exist.
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class(
                'ASSERT-010', 'Editing sessions',
                CURRENT_DATE - 60, CURRENT_DATE + 60,
                'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    '[{"weekday": 2, "start_time": "09:00", "duration_minutes": 60},
       {"weekday": 4, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);

  PERFORM public.generate_sessions(v_class);

  CREATE TEMP TABLE t_ctx ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- update_session moves a future session
-- ----------------------------------------------------------------------------

DO $move$
DECLARE
  v_session uuid;
  v_before  timestamptz;
  v_after   timestamptz;
  v_date    date;
BEGIN
  SELECT id, starts_at, session_date INTO v_session, v_before, v_date
  FROM public.class_sessions
  WHERE class_id = (SELECT class_id FROM t_ctx)
    AND session_date > CURRENT_DATE
  ORDER BY session_date
  LIMIT 1;

  PERFORM public.update_session(v_session, NULL, TIME '14:30', 90);

  SELECT starts_at INTO v_after
  FROM public.class_sessions WHERE id = v_session;

  IF v_after = v_before THEN
    RAISE EXCEPTION 'update_session did not move the session';
  END IF;

  IF (SELECT (starts_at AT TIME ZONE 'Africa/Accra')::time
      FROM public.class_sessions WHERE id = v_session) <> TIME '14:30' THEN
    RAISE EXCEPTION 'update_session resolved the wrong wall-clock time';
  END IF;

  IF (SELECT duration_minutes FROM public.class_sessions WHERE id = v_session) <> 90 THEN
    RAISE EXCEPTION 'update_session did not change the duration';
  END IF;

  -- session_date is maintained by the trigger, in the class's timezone.
  IF (SELECT session_date FROM public.class_sessions WHERE id = v_session) <> v_date THEN
    RAISE EXCEPTION 'update_session changed the date when it was not asked to';
  END IF;

  -- Hand-moved: a later apply_schedule_to_future must leave it alone.
  IF NOT (SELECT moved_manually FROM public.class_sessions WHERE id = v_session) THEN
    RAISE EXCEPTION 'update_session did not flag the session as hand-moved';
  END IF;
END
$move$;

-- ----------------------------------------------------------------------------
-- ...and refuses to move one that has already run
-- ----------------------------------------------------------------------------

DO $closed$
DECLARE
  v_session uuid;
  v_msg     text;
BEGIN
  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE class_id = (SELECT class_id FROM t_ctx)
    AND session_date < CURRENT_DATE
  ORDER BY session_date
  LIMIT 1;

  UPDATE public.class_sessions SET status = 'closed' WHERE id = v_session;

  BEGIN
    PERFORM public.update_session(v_session, NULL, TIME '16:00');
    RAISE EXCEPTION 'update_session moved a CLOSED session';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'update_session moved a CLOSED session' THEN
      RAISE;
    END IF;
  END;
END
$closed$;

-- ----------------------------------------------------------------------------
-- ...and refuses to put two sessions of one cohort at the same instant
-- ----------------------------------------------------------------------------

DO $collide$
DECLARE
  v_a    uuid;
  v_b    uuid;
  v_when timestamptz;
  v_msg  text;
BEGIN
  SELECT id, starts_at INTO v_a, v_when
  FROM public.class_sessions
  WHERE class_id = (SELECT class_id FROM t_ctx)
    AND status = 'scheduled'
    AND session_date > CURRENT_DATE
  ORDER BY session_date LIMIT 1;

  SELECT id INTO v_b
  FROM public.class_sessions
  WHERE class_id = (SELECT class_id FROM t_ctx)
    AND status = 'scheduled'
    AND session_date > CURRENT_DATE
    AND id <> v_a
  ORDER BY session_date LIMIT 1;

  BEGIN
    PERFORM public.update_session(
      v_b,
      (v_when AT TIME ZONE 'Africa/Accra')::date,
      (v_when AT TIME ZONE 'Africa/Accra')::time);
    RAISE EXCEPTION 'update_session created a duplicate session';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'update_session created a duplicate session' THEN
      RAISE;
    END IF;
  END;
END
$collide$;

-- ----------------------------------------------------------------------------
-- apply_schedule_to_future: the whole point — the past is untouched
-- ----------------------------------------------------------------------------

DO $future$
DECLARE
  v_class   uuid := (SELECT class_id FROM t_ctx);
  v_cohort  uuid := (SELECT cohort_id FROM t_ctx);
  v_past    integer;
  v_past_9  integer;
  v_fut_9   integer;
  v_fut_14  integer;
  v_result  jsonb;
BEGIN
  SELECT count(*) INTO v_past
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date < CURRENT_DATE;

  SELECT count(*) INTO v_past_9
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date < CURRENT_DATE
    AND (starts_at AT TIME ZONE 'Africa/Accra')::time = TIME '09:00';

  -- Tuesday moves to 14:00; Thursday is dropped entirely.
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    '[{"weekday": 2, "start_time": "14:00", "duration_minutes": 120}]'::jsonb);

  v_result := public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  -- 1. Nothing before today changed, in count or in time.
  IF (SELECT count(*) FROM public.class_sessions
      WHERE class_id = v_class AND session_date < CURRENT_DATE) <> v_past THEN
    RAISE EXCEPTION 'apply_schedule_to_future changed the number of past sessions';
  END IF;

  IF (SELECT count(*) FROM public.class_sessions
      WHERE class_id = v_class AND session_date < CURRENT_DATE
        AND (starts_at AT TIME ZONE 'Africa/Accra')::time = TIME '09:00') <> v_past_9 THEN
    RAISE EXCEPTION 'apply_schedule_to_future moved a past session';
  END IF;

  -- 2. Future Tuesdays are at 14:00, and none is left at 09:00.
  SELECT count(*) INTO v_fut_9
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date > CURRENT_DATE
    AND status = 'scheduled'
    AND NOT moved_manually
    AND (starts_at AT TIME ZONE 'Africa/Accra')::time = TIME '09:00';

  SELECT count(*) INTO v_fut_14
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date > CURRENT_DATE
    AND (starts_at AT TIME ZONE 'Africa/Accra')::time = TIME '14:00';

  IF v_fut_9 <> 0 THEN
    RAISE EXCEPTION
      '% future sessions still sit at the old 09:00 time', v_fut_9;
  END IF;

  IF v_fut_14 = 0 THEN
    RAISE EXCEPTION 'no future session was moved to the new 14:00 time';
  END IF;

  -- 3. Thursday is gone from the future and still present in the past.
  --    Except one: the session hand-moved further up is deliberately kept,
  --    which is the point of moved_manually. A TA who scheduled a one-off
  --    makeup must not lose it by later editing the weekly pattern.
  IF EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE class_id = v_class
      AND session_date >= CURRENT_DATE
      AND status = 'scheduled'
      AND NOT moved_manually
      AND EXTRACT(DOW FROM session_date) = 4
  ) THEN
    RAISE EXCEPTION 'a Thursday survived a schedule that no longer has one';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE class_id = v_class
      AND session_date < CURRENT_DATE
      AND EXTRACT(DOW FROM session_date) = 4
  ) THEN
    RAISE EXCEPTION 'past Thursdays were deleted';
  END IF;

  -- 4. It reports what it did.
  IF (v_result ->> 'moved')::int = 0 AND (v_result ->> 'created')::int = 0 THEN
    RAISE EXCEPTION 'apply_schedule_to_future reported no work: %', v_result;
  END IF;
  IF (v_result ->> 'removed')::int = 0 THEN
    RAISE EXCEPTION 'apply_schedule_to_future reported no removals: %', v_result;
  END IF;
END
$future$;

-- ----------------------------------------------------------------------------
-- A session that was cancelled, or edited by hand, is left where it is
-- ----------------------------------------------------------------------------

DO $respect$
DECLARE
  v_class     uuid := (SELECT class_id FROM t_ctx);
  v_cohort    uuid := (SELECT cohort_id FROM t_ctx);
  v_cancelled uuid;
  v_hand      uuid;
  v_hand_at   timestamptz;
BEGIN
  SELECT id INTO v_cancelled
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date > CURRENT_DATE + 7
  ORDER BY session_date LIMIT 1;

  PERFORM public.cancel_session(v_cancelled, 'Public holiday');

  SELECT id INTO v_hand
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date > CURRENT_DATE + 14
    AND status = 'scheduled'
  ORDER BY session_date LIMIT 1;

  PERFORM public.update_session(v_hand, NULL, TIME '18:45');
  SELECT starts_at INTO v_hand_at FROM public.class_sessions WHERE id = v_hand;

  -- Re-apply the same pattern. Neither of those two should move.
  PERFORM public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  IF (SELECT status FROM public.class_sessions WHERE id = v_cancelled)
     <> 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled session was revived';
  END IF;

  IF (SELECT starts_at FROM public.class_sessions WHERE id = v_hand)
     <> v_hand_at THEN
    RAISE EXCEPTION 'a hand-edited session was dragged back to the pattern';
  END IF;

  -- And the cancelled day did not gain a second, scheduled session alongside it.
  IF (SELECT count(*) FROM public.class_sessions s
      WHERE s.cohort_id = v_cohort
        AND s.session_date = (SELECT session_date FROM public.class_sessions
                              WHERE id = v_cancelled)) <> 1 THEN
    RAISE EXCEPTION 'a cancelled day gained a duplicate session';
  END IF;
END
$respect$;

ROLLBACK;
