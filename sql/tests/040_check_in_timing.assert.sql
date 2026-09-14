-- ============================================================================
-- Migration 040 — check-in timing for a cohort, or the whole class
--
-- The cases that matter are the ones the function must NOT touch. Changing the
-- window length on a session that is already running changes it under students
-- mid-check-in, and a session with marks already has history. Both would look
-- entirely plausible in the data afterwards, so they are asserted rather than
-- trusted.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_a      uuid;
  v_b      uuid;
  v_future date := CURRENT_DATE + 7;
BEGIN
  v_class := (public.create_class('ASSERT-040', 'Timing',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 2) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "S040A", "name": "A"}]'::jsonb);
  PERFORM public.upsert_enrolments(v_b, '[{"student_id": "S040B", "name": "B"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id IN (v_a, v_b);

  PERFORM public.set_cohort_schedules(ARRAY[v_a],
    '[{"weekday": 1, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);
  PERFORM public.set_cohort_schedules(ARRAY[v_b],
    '[{"weekday": 2, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);

  CREATE TEMP TABLE t040 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_a AS cohort_a, v_b AS cohort_b,
    -- upcoming, untouched: must change
    (public.create_ad_hoc_session(v_a, v_future, TIME '09:00') ->> 'session_id')::uuid AS a_upcoming,
    -- upcoming, but a register was taken early: must not change
    (public.create_ad_hoc_session(v_a, v_future + 1, TIME '09:00') ->> 'session_id')::uuid AS a_marked,
    -- in the past, still scheduled: must not change
    (public.create_ad_hoc_session(v_a, CURRENT_DATE - 3, TIME '09:00') ->> 'session_id')::uuid AS a_past,
    -- the other cohort, upcoming: must change only for a whole-class call
    (public.create_ad_hoc_session(v_b, v_future, TIME '09:00') ->> 'session_id')::uuid AS b_upcoming;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  SELECT a_marked, class_id, 'S040A', 'present', now(), 'staff' FROM t040;

  -- An upcoming session that is already open: its window is running.
  ALTER TABLE t040 ADD COLUMN a_open uuid;
  UPDATE t040 SET a_open =
    (public.create_ad_hoc_session(cohort_a, CURRENT_DATE + 9, TIME '09:00') ->> 'session_id')::uuid;
  UPDATE public.class_sessions
     SET status = 'open', opened_at = now(), pin = 'T0400'
   WHERE id = (SELECT a_open FROM t040);
END;
$setup$;

-- ------------------------------------------------------------ one cohort --
DO $one_cohort$
DECLARE
  t        record;
  r        jsonb;
  v_before public.classes%ROWTYPE;
  v_after  public.classes%ROWTYPE;
  v_close  integer;
  v_early  integer;
BEGIN
  SELECT * INTO t FROM t040;
  SELECT * INTO v_before FROM public.classes WHERE id = t.class_id;

  r := public.set_session_windows(t.class_id, t.cohort_a, 25, 12);

  SELECT auto_close_minutes, early_open_minutes INTO v_close, v_early
  FROM public.class_sessions WHERE id = t.a_upcoming;
  IF v_close <> 25 OR v_early <> 12 THEN
    RAISE EXCEPTION '040: the upcoming session came out %/% instead of 25/12', v_close, v_early;
  END IF;

  -- The session with a register taken early keeps its timing.
  SELECT auto_close_minutes INTO v_close FROM public.class_sessions WHERE id = t.a_marked;
  IF v_close = 25 THEN
    RAISE EXCEPTION '040: a session with attendance already recorded was retimed';
  END IF;

  -- A past session keeps its timing.
  SELECT auto_close_minutes INTO v_close FROM public.class_sessions WHERE id = t.a_past;
  IF v_close = 25 THEN
    RAISE EXCEPTION '040: a session dated before today was retimed';
  END IF;

  -- An open session keeps its timing: its window is running.
  SELECT auto_close_minutes INTO v_close FROM public.class_sessions WHERE id = t.a_open;
  IF v_close = 25 THEN
    RAISE EXCEPTION '040: an open session had its window changed while running';
  END IF;

  -- The other cohort is untouched.
  SELECT auto_close_minutes INTO v_close FROM public.class_sessions WHERE id = t.b_upcoming;
  IF v_close = 25 THEN
    RAISE EXCEPTION '040: a one-cohort change reached the other cohort';
  END IF;

  -- Its weekly slot changed; the other cohort's did not.
  SELECT auto_close_minutes INTO v_close FROM public.cohort_schedules WHERE cohort_id = t.cohort_a;
  IF v_close IS DISTINCT FROM 25 THEN
    RAISE EXCEPTION '040: cohort A''s weekly slot was not updated (%)', v_close;
  END IF;
  SELECT auto_close_minutes INTO v_close FROM public.cohort_schedules WHERE cohort_id = t.cohort_b;
  IF v_close IS NOT DISTINCT FROM 25 THEN
    RAISE EXCEPTION '040: cohort B''s weekly slot changed on a cohort A call';
  END IF;

  -- Class defaults are not what one cohort chose.
  SELECT * INTO v_after FROM public.classes WHERE id = t.class_id;
  IF v_after.default_auto_close_minutes <> v_before.default_auto_close_minutes
     OR v_after.default_early_open_minutes <> v_before.default_early_open_minutes THEN
    RAISE EXCEPTION '040: a one-cohort change rewrote the class defaults';
  END IF;

  IF (r ->> 'kept')::integer <> 1 THEN
    RAISE EXCEPTION '040: kept reported %, expected the one marked session', r ->> 'kept';
  END IF;

  RAISE NOTICE '040 ok: one cohort retimed, and only what should be';
END;
$one_cohort$;

-- ---------------------------------------------------------- whole class --
DO $whole_class$
DECLARE
  t       record;
  r       jsonb;
  v_class public.classes%ROWTYPE;
  v_close integer;
  v_early integer;
BEGIN
  SELECT * INTO t FROM t040;

  -- Only the early-open time: the sign-up window must be left as it is.
  r := public.set_session_windows(t.class_id, NULL, NULL, 7);

  SELECT auto_close_minutes, early_open_minutes INTO v_close, v_early
  FROM public.class_sessions WHERE id = t.b_upcoming;
  IF v_early <> 7 THEN
    RAISE EXCEPTION '040: the whole-class call did not reach cohort B (early %)', v_early;
  END IF;

  SELECT auto_close_minutes INTO v_close FROM public.class_sessions WHERE id = t.a_upcoming;
  IF v_close <> 25 THEN
    RAISE EXCEPTION '040: a NULL sign-up window overwrote the existing one (now %)', v_close;
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = t.class_id;
  IF v_class.default_early_open_minutes <> 7 THEN
    RAISE EXCEPTION '040: the class default for early open was not updated (%)',
      v_class.default_early_open_minutes;
  END IF;

  IF NOT (r ->> 'defaults_updated')::boolean THEN
    RAISE EXCEPTION '040: defaults_updated should be true for a whole-class call';
  END IF;

  RAISE NOTICE '040 ok: whole class reached every cohort and the defaults';
END;
$whole_class$;

-- ------------------------------------------------------------- refusals --
DO $refusals$
DECLARE
  t      record;
  v_other uuid;
  refused integer := 0;
BEGIN
  SELECT * INTO t FROM t040;

  BEGIN PERFORM public.set_session_windows(t.class_id, NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN refused := refused + 1; END;

  BEGIN PERFORM public.set_session_windows(t.class_id, NULL, 0, NULL);
  EXCEPTION WHEN OTHERS THEN refused := refused + 1; END;

  BEGIN PERFORM public.set_session_windows(t.class_id, NULL, NULL, -5);
  EXCEPTION WHEN OTHERS THEN refused := refused + 1; END;

  BEGIN PERFORM public.set_session_windows(t.class_id, NULL, 900, NULL);
  EXCEPTION WHEN OTHERS THEN refused := refused + 1; END;

  v_other := (public.create_class('ASSERT-040B', 'Other',
                CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  BEGIN
    PERFORM public.set_session_windows(
      t.class_id,
      (SELECT id FROM public.cohorts WHERE class_id = v_other LIMIT 1),
      30, NULL);
  EXCEPTION WHEN OTHERS THEN refused := refused + 1; END;

  IF refused <> 5 THEN
    RAISE EXCEPTION '040: refused % of 5 invalid calls', refused;
  END IF;

  RAISE NOTICE '040 ok: nothing, zero, negative, over-long and a foreign cohort all refused';
END;
$refusals$;

ROLLBACK;
