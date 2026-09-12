-- ============================================================================
-- Migration 035 — a date added by hand survives the pattern
--
-- Creating the session is the easy half. The half worth asserting is that it
-- then survives apply_schedule_to_future, which both moves sessions onto new
-- times and DELETES ones the pattern no longer wants. A hand-added Saturday is
-- by definition a day the pattern does not want, so it sits squarely in the
-- path of step 2 — and attendance_records.session_id is ON DELETE CASCADE, so
-- a deletion would take the register with it.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class('ASSERT-035', 'Ad Hoc',
                CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S035A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- The pattern meets on Mondays. Everything added below is on a Saturday, so
  -- the pattern actively does not want it.
  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    '[{"weekday": 1, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);
  PERFORM public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  CREATE TEMP TABLE t035 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id,
         -- The next Saturday, whenever the suite happens to run.
         (CURRENT_DATE + ((6 - EXTRACT(DOW FROM CURRENT_DATE)::int + 7) % 7 + 7))::date
           AS saturday;
END;
$setup$;

-- ------------------------------------------------------------- creating it --
DO $creating$
DECLARE
  t          record;
  v_result   jsonb;
  v_session  public.class_sessions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM t035;

  v_result := public.create_ad_hoc_session(t.cohort_id, t.saturday, TIME '14:00', 90);

  SELECT * INTO v_session
  FROM public.class_sessions WHERE id = (v_result ->> 'session_id')::uuid;

  IF v_session.session_date <> t.saturday THEN
    RAISE EXCEPTION
      '035: asked for % and got % — the date was not taken at face value',
      t.saturday, v_session.session_date;
  END IF;

  IF v_session.duration_minutes <> 90 THEN
    RAISE EXCEPTION
      '035: duration came back as %, not the 90 that was asked for',
      v_session.duration_minutes;
  END IF;

  IF v_session.schedule_id IS NOT NULL THEN
    RAISE EXCEPTION
      '035: the session was tied to a schedule slot, so a pattern change would move it';
  END IF;

  IF NOT v_session.moved_manually THEN
    RAISE EXCEPTION
      '035: moved_manually is false — the next schedule save would delete this session';
  END IF;

  -- Windows inherited from the class rather than left at zero, or the session
  -- would open and shut in the same instant.
  IF v_session.auto_close_minutes IS NULL OR v_session.auto_close_minutes <= 0 THEN
    RAISE EXCEPTION
      '035: auto_close_minutes came out as %, so check-in would never be live',
      v_session.auto_close_minutes;
  END IF;

  RAISE NOTICE '035 ok: a Saturday session exists, unattached to any slot';
END;
$creating$;

-- ------------------------------------------------------- and it survives --
DO $surviving$
DECLARE
  t         record;
  v_id      uuid;
  v_before  timestamptz;
  v_after   timestamptz;
  v_still   integer;
  v_records integer;
BEGIN
  SELECT * INTO t FROM t035;

  SELECT id, starts_at INTO v_id, v_before
  FROM public.class_sessions
  WHERE cohort_id = t.cohort_id AND session_date = t.saturday;

  -- Somebody takes the register at the catch-up class.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_id, t.class_id, 'S035A', 'present', now(), 'staff');

  -- Now the weekly pattern changes completely: Mondays become Thursdays. Step 2
  -- of apply_schedule_to_future deletes future scheduled sessions the pattern
  -- does not want, and a Saturday is emphatically one of those.
  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id],
    '[{"weekday": 4, "start_time": "11:00", "duration_minutes": 60}]'::jsonb);
  PERFORM public.apply_schedule_to_future(t.class_id, ARRAY[t.cohort_id]);

  SELECT count(*) INTO v_still FROM public.class_sessions WHERE id = v_id;
  IF v_still <> 1 THEN
    RAISE EXCEPTION
      '035: the hand-added session was deleted by a schedule change — which is exactly what adding it by hand is supposed to prevent';
  END IF;

  SELECT starts_at INTO v_after FROM public.class_sessions WHERE id = v_id;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      '035: the hand-added session was restamped from % to % by the pattern',
      v_before, v_after;
  END IF;

  SELECT count(*) INTO v_records
  FROM public.attendance_records WHERE session_id = v_id;
  IF v_records <> 1 THEN
    RAISE EXCEPTION
      '035: the register against it is gone (% rows) — ON DELETE CASCADE followed the session',
      v_records;
  END IF;

  RAISE NOTICE '035 ok: it survived a full pattern change, with its register';
END;
$surviving$;

-- --------------------------------------------------------- and refuses a clash --
DO $clashing$
DECLARE
  t      record;
  failed boolean := false;
BEGIN
  SELECT * INTO t FROM t035;

  BEGIN
    PERFORM public.create_ad_hoc_session(t.cohort_id, t.saturday, TIME '14:00', 60);
  EXCEPTION WHEN OTHERS THEN
    failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      '035: a second session was created at the same time for the same cohort';
  END IF;

  -- A different time on the same day is fine: the schema is unique on
  -- (cohort_id, starts_at), the instant, not the date. Two sessions in a day is
  -- allowed by construction even though nothing generates them yet.
  PERFORM public.create_ad_hoc_session(t.cohort_id, t.saturday, TIME '16:00', 60);

  RAISE NOTICE '035 ok: same instant refused, a different hour on the same day allowed';
END;
$clashing$;

ROLLBACK;
