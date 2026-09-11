-- ============================================================================
-- Migration 034 — a schedule edit leaves anything already marked alone
--
-- The delete is the case that matters. attendance_records.session_id is
-- ON DELETE CASCADE, so before 034 a TA who took the register by hand on a
-- Wednesday and then dropped Wednesday from the timetable lost the register —
-- no error, no warning, and nothing to recover from. The count even said
-- "removed 4", which is true and tells you nothing about what went with them.
--
-- The move is milder and asserted too: the records survive a restamped
-- starts_at, but the register was taken for a class at a particular time and
-- silently giving it another makes the row say something nobody asserted.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class    uuid;
  v_cohort   uuid;
  v_marked   uuid;
  v_unmarked uuid;
  v_next_wed date;
BEGIN
  v_class := (public.create_class('ASSERT-034', 'Schedule Edits',
                CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S034A", "name": "Marked"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- A Wednesday slot at 09:00, so the pattern wants Wednesdays.
  -- set_cohort_schedules, plural: 009 dropped the singular one, and this is
  -- what the Schedule screen calls.
  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    '[{"weekday": 3, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);
  PERFORM public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  -- Two future Wednesdays: one with a hand-taken register, one without.
  SELECT min(session_date) INTO v_next_wed
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND session_date > CURRENT_DATE;

  SELECT id INTO v_marked
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND session_date = v_next_wed;

  SELECT id INTO v_unmarked
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND session_date > v_next_wed
  ORDER BY session_date LIMIT 1;

  IF v_marked IS NULL OR v_unmarked IS NULL THEN
    RAISE EXCEPTION '034: the fixture did not produce two future sessions to test with';
  END IF;

  -- The register, taken by hand BEFORE the session was ever opened. This is the
  -- case 034 exists for: the session is still 'scheduled' and yet carries marks.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_marked, v_class, 'S034A', 'present', now(), 'staff');

  CREATE TEMP TABLE t034 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id,
         v_marked AS marked_id, v_unmarked AS unmarked_id;
END;
$setup$;

-- ------------------------------------------------------- moving the pattern --
DO $moving$
DECLARE
  t        record;
  v_before timestamptz;
  v_after  timestamptz;
  v_other  timestamptz;
  v_result jsonb;
BEGIN
  SELECT * INTO t FROM t034;
  SELECT starts_at INTO v_before FROM public.class_sessions WHERE id = t.marked_id;
  SELECT starts_at INTO v_other  FROM public.class_sessions WHERE id = t.unmarked_id;

  -- Same weekday, different time. Step 1 territory.
  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id],
    '[{"weekday": 3, "start_time": "14:00", "duration_minutes": 60}]'::jsonb);
  v_result := public.apply_schedule_to_future(t.class_id, ARRAY[t.cohort_id]);

  SELECT starts_at INTO v_after FROM public.class_sessions WHERE id = t.marked_id;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      '034: a session with a register against it was restamped from % to %',
      v_before, v_after;
  END IF;

  -- The unmarked one must still move, or the fence has broken the feature
  -- rather than protected it.
  SELECT starts_at INTO v_after FROM public.class_sessions WHERE id = t.unmarked_id;
  IF v_after = v_other THEN
    RAISE EXCEPTION
      '034: an unmarked session did not move — the fence is catching everything';
  END IF;

  IF (v_result ->> 'kept')::integer < 1 THEN
    RAISE EXCEPTION
      '034: kept reported %, so the screen cannot tell a TA why one stayed put',
      v_result ->> 'kept';
  END IF;

  RAISE NOTICE '034 ok: the marked session held its time, the unmarked one moved';
END;
$moving$;

-- ------------------------------------------------------ dropping the weekday --
DO $dropping$
DECLARE
  t         record;
  v_result  jsonb;
  v_still   integer;
  v_records integer;
BEGIN
  SELECT * INTO t FROM t034;

  -- Move the pattern to Monday, so every future Wednesday is now unwanted and
  -- step 2 wants to delete the lot.
  -- set_cohort_schedules replaces every slot for the cohort, so moving to
  -- Monday is itself what drops Wednesday.
  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id],
    '[{"weekday": 1, "start_time": "09:00", "duration_minutes": 60}]'::jsonb);

  v_result := public.apply_schedule_to_future(t.class_id, ARRAY[t.cohort_id]);

  SELECT count(*) INTO v_still
  FROM public.class_sessions WHERE id = t.marked_id;

  IF v_still <> 1 THEN
    RAISE EXCEPTION
      '034: the session carrying a register was deleted by a schedule edit';
  END IF;

  -- And the cascade did not fire, which is the whole point.
  SELECT count(*) INTO v_records
  FROM public.attendance_records WHERE session_id = t.marked_id;

  IF v_records <> 1 THEN
    RAISE EXCEPTION
      '034: the register is gone (% rows) — ON DELETE CASCADE took it with the session',
      v_records;
  END IF;

  -- The unmarked Wednesday should have gone, or nothing is being cleaned up.
  SELECT count(*) INTO v_still
  FROM public.class_sessions WHERE id = t.unmarked_id;

  IF v_still <> 0 THEN
    RAISE EXCEPTION
      '034: an unmarked session on a dropped weekday survived — the fence is too wide';
  END IF;

  RAISE NOTICE
    '034 ok: removed % unmarked, kept % with attendance, register intact',
    v_result ->> 'removed', v_result ->> 'kept';
END;
$dropping$;

ROLLBACK;
