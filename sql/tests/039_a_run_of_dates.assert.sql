-- ============================================================================
-- Migration 039 — one date, or the same weekday over a range
--
-- Three things worth pinning, in order of how badly they would go unnoticed.
--
-- WEEKLY, not daily. "Tuesday the 14th, to the end of term" means Tuesdays. A
-- daily reading produces sixty sessions instead of eleven, all of them
-- plausible-looking rows, and the TA finds out when the term's attendance is
-- divided by the wrong denominator.
--
-- STILL INSTANCES. Every session it creates must be moved_manually with no
-- schedule_id, or the weekly pattern will delete the series the next time
-- somebody saves a schedule.
--
-- AND IT SAYS WHAT IT SKIPPED. Days off and existing sessions both silently
-- reduce the count, and both are correct; "created 9 of 11" with no reason
-- reads as a bug.
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
  v_start  date;
BEGIN
  v_class := (public.create_class('ASSERT-039', 'A Run Of Dates',
                CURRENT_DATE - 30, CURRENT_DATE + 120) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S039A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- A fixed weekday, whenever the suite runs: the next Tuesday.
  v_start := (CURRENT_DATE + ((2 - EXTRACT(DOW FROM CURRENT_DATE)::int + 7) % 7 + 7))::date;

  CREATE TEMP TABLE t039 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_start AS first_tuesday;
END;
$setup$;

-- ----------------------------------------------------------------- a single --
DO $single$
DECLARE
  t        record;
  v_result jsonb;
BEGIN
  SELECT * INTO t FROM t039;

  -- No end date is the single-date case, which is what 035 did.
  v_result := public.create_ad_hoc_sessions(t.cohort_id, t.first_tuesday, TIME '09:00');

  IF (v_result ->> 'created')::integer <> 1 THEN
    RAISE EXCEPTION
      '039: one date created % sessions', v_result ->> 'created';
  END IF;

  RAISE NOTICE '039 ok: no end date means exactly one session';
END;
$single$;

-- ------------------------------------------------------- weekly, not daily --
DO $weekly$
DECLARE
  t         record;
  v_result  jsonb;
  v_count   integer;
  v_weekday integer;
  v_bad     integer;
BEGIN
  SELECT * INTO t FROM t039;

  -- Four weeks at a different time, so it does not collide with the single one.
  v_result := public.create_ad_hoc_sessions(
    t.cohort_id, t.first_tuesday, TIME '15:00', t.first_tuesday + 21);

  IF (v_result ->> 'created')::integer <> 4 THEN
    RAISE EXCEPTION
      '039: three weeks of Tuesdays created % sessions, expected 4 — a daily reading would give 22',
      v_result ->> 'created';
  END IF;

  -- Every one on the same weekday as the first. This is the assertion that
  -- separates "weekly" from "daily" beyond the count alone.
  SELECT EXTRACT(DOW FROM t.first_tuesday)::int INTO v_weekday;

  SELECT count(*) INTO v_bad
  FROM public.class_sessions
  WHERE cohort_id = t.cohort_id
    AND session_date >= t.first_tuesday
    AND EXTRACT(DOW FROM session_date)::int <> v_weekday;

  IF v_bad <> 0 THEN
    RAISE EXCEPTION
      '039: % session(s) landed on a different weekday than the one chosen', v_bad;
  END IF;

  -- Seven days apart, not one.
  SELECT count(*) INTO v_count
  FROM public.class_sessions
  WHERE cohort_id = t.cohort_id
    AND session_date IN (t.first_tuesday + 7, t.first_tuesday + 14, t.first_tuesday + 21);

  IF v_count <> 3 THEN
    RAISE EXCEPTION
      '039: the following weeks are not where they should be (% of 3)', v_count;
  END IF;

  RAISE NOTICE '039 ok: weekly on the chosen weekday, not every day in the range';
END;
$weekly$;

-- --------------------------------------------- and the pattern leaves it be --
DO $survives$
DECLARE
  t        record;
  v_before integer;
  v_after  integer;
BEGIN
  SELECT * INTO t FROM t039;

  SELECT count(*) INTO v_before
  FROM public.class_sessions
  WHERE cohort_id = t.cohort_id AND moved_manually;

  IF v_before < 5 THEN
    RAISE EXCEPTION
      '039: only % of the created sessions are flagged moved_manually — the pattern will delete the rest',
      v_before;
  END IF;

  -- A pattern that wants Thursdays, and a schedule save. Step 2 of
  -- apply_schedule_to_future deletes future scheduled sessions the pattern does
  -- not want, which is every one of these.
  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id],
    '[{"weekday": 4, "start_time": "11:00", "duration_minutes": 60}]'::jsonb);
  PERFORM public.apply_schedule_to_future(t.class_id, ARRAY[t.cohort_id]);

  SELECT count(*) INTO v_after
  FROM public.class_sessions
  WHERE cohort_id = t.cohort_id AND moved_manually;

  IF v_after <> v_before THEN
    RAISE EXCEPTION
      '039: a schedule save removed % hand-added session(s)', v_before - v_after;
  END IF;

  RAISE NOTICE '039 ok: % hand-added sessions survived a full pattern change', v_after;
END;
$survives$;

-- ------------------------------------------------- and it says what it skipped --
DO $skipping$
DECLARE
  t        record;
  v_result jsonb;
BEGIN
  SELECT * INTO t FROM t039;

  -- Declare the third Tuesday off, then ask for the same four weeks again at
  -- the same time. Two reasons to skip, one of each kind.
  PERFORM public.set_no_class_day(
    t.class_id, t.first_tuesday + 14, 'exempt', 'Reading week');

  v_result := public.create_ad_hoc_sessions(
    t.cohort_id, t.first_tuesday, TIME '15:00', t.first_tuesday + 21);

  IF (v_result ->> 'skipped_days_off')::integer <> 1 THEN
    RAISE EXCEPTION
      '039: reported % day(s) off skipped, expected 1',
      v_result ->> 'skipped_days_off';
  END IF;

  -- The other three already exist from the weekly block above. The one on the
  -- declared day was deleted by set_no_class_day, since nothing was recorded
  -- against it.
  IF (v_result ->> 'skipped_existing')::integer <> 3 THEN
    RAISE EXCEPTION
      '039: reported % already existing, expected 3',
      v_result ->> 'skipped_existing';
  END IF;

  IF (v_result ->> 'created')::integer <> 0 THEN
    RAISE EXCEPTION
      '039: created % session(s) when every date was already taken or off',
      v_result ->> 'created';
  END IF;

  RAISE NOTICE '039 ok: skips are counted separately by reason';
END;
$skipping$;

ROLLBACK;
