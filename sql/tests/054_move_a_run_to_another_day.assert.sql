-- ============================================================================
-- Migration 054 — move a session to another day, or move its run
--
-- The assertion that justifies the design is the resurrection check: after a
-- run is moved, filling in sessions must not bring the old weekday back. That
-- is what moving the sessions alone got wrong, and what splitting the pattern
-- at the date is for. Close behind it: a pattern save after a move must keep
-- the split, because set_cohort_schedules used to drop the dates on the floor.
--
-- What is checked:
--
--   a pattern save carries each meeting's from and until dates through
--   a meeting that ends before it starts is refused
--   a single session cannot be moved onto a declared day off
--   a dry run of a move predicts exactly, and writes nothing
--   moving a run splits the pattern at the date
--   a register stays where it was taken; a day-off landing is dropped
--   a fill after the move does not bring the old day back
--   a pattern save after the move keeps the split
--   a same-weekday run move, a colliding one, and a run with no pattern behind
--   it are all refused, each saying what to do instead
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
  -- Two weeks run, six to go: enough future weeks for a run to have a head,
  -- a register in the middle, a day off to land on, and a tail.
  v_class := (public.create_class('ASSERT-054', 'Moving',
                CURRENT_DATE - 14, CURRENT_DATE + 42, 'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S054A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 14
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    jsonb_build_array(jsonb_build_object(
      'weekday', EXTRACT(DOW FROM CURRENT_DATE)::int,
      'start_time', '09:00')));
  PERFORM public.fill_sessions(v_class, NULL, NULL, true, false);

  CREATE TEMP TABLE t054 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id,
         EXTRACT(DOW FROM CURRENT_DATE)::smallint AS old_dow;
END;
$setup$;

-- ------------------------------------------- a save keeps a meeting's dates --
DO $round_trip$
DECLARE
  t       record;
  v_row   record;
  ok      boolean;
BEGIN
  SELECT * INTO t FROM t054;

  -- A second meeting that only runs for a fortnight, saved alongside the
  -- first the way the pattern editor saves: the whole list at once.
  PERFORM public.set_cohort_schedules(
    ARRAY[t.cohort_id],
    jsonb_build_array(
      jsonb_build_object('weekday', t.old_dow, 'start_time', '09:00'),
      jsonb_build_object('weekday', (t.old_dow + 3) % 7, 'start_time', '15:00',
                         'effective_from',  CURRENT_DATE + 7,
                         'effective_until', CURRENT_DATE + 20)));

  SELECT effective_from, effective_until INTO v_row
    FROM public.cohort_schedules
   WHERE cohort_id = t.cohort_id AND start_time = TIME '15:00';
  IF v_row.effective_from IS DISTINCT FROM CURRENT_DATE + 7
     OR v_row.effective_until IS DISTINCT FROM CURRENT_DATE + 20 THEN
    RAISE EXCEPTION '054: a save kept the meeting as % to %, not the dates sent',
      v_row.effective_from, v_row.effective_until;
  END IF;

  BEGIN
    PERFORM public.set_cohort_schedules(
      ARRAY[t.cohort_id],
      jsonb_build_array(jsonb_build_object(
        'weekday', t.old_dow, 'start_time', '09:00',
        'effective_from', CURRENT_DATE + 10, 'effective_until', CURRENT_DATE + 3)));
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '054: a meeting that ends before it starts was accepted';
  END IF;

  -- Back to the one weekly meeting the rest of this file expects.
  PERFORM public.set_cohort_schedules(
    ARRAY[t.cohort_id],
    jsonb_build_array(jsonb_build_object('weekday', t.old_dow, 'start_time', '09:00')));

  RAISE NOTICE '054 ok: a pattern save keeps each meeting''s dates, and refuses a backwards one';
END;
$round_trip$;

-- ------------------------------------------ one session, not onto a day off --
DO $one_day_off$
DECLARE
  t       record;
  v_sess  uuid;
  v_date  date;
  ok      boolean;
  v_why   text;
BEGIN
  SELECT * INTO t FROM t054;

  SELECT id, session_date INTO v_sess, v_date FROM public.class_sessions
   WHERE cohort_id = t.cohort_id AND session_date > CURRENT_DATE + 30
     AND status = 'scheduled'
   ORDER BY session_date LIMIT 1;

  PERFORM public.set_no_class_day(t.class_id, v_date + 1, 'exempt', 'Staff training');

  BEGIN
    PERFORM public.update_session(v_sess, v_date + 1);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
    v_why := SQLERRM;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '054: a session was moved onto a declared day off';
  END IF;
  IF v_why NOT LIKE '%day off%' THEN
    RAISE EXCEPTION '054: refused a day-off move without saying so: %', v_why;
  END IF;

  -- The same refusal from the drag path, for one session.
  BEGIN
    PERFORM public.move_session_to(v_sess, v_date + 1, 'one');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '054: a drop onto a day off was accepted';
  END IF;

  PERFORM public.clear_no_class_day(t.class_id, v_date + 1);

  RAISE NOTICE '054 ok: a session cannot be moved onto a declared day off';
END;
$one_day_off$;

-- --------------------------------------------------- moving the whole run --
DO $run$
DECLARE
  t         record;
  v_anchor  record;
  v_marked  record;
  v_doomed  record;
  v_new     date;
  v_plan    jsonb;
  v_real    jsonb;
  v_before  integer;
  v_after   integer;
  v_slots   integer;
  v_until   date;
  v_new_dow smallint;
  v_class   public.classes%ROWTYPE;
BEGIN
  SELECT * INTO t FROM t054;
  SELECT * INTO v_class FROM public.classes WHERE id = t.class_id;

  -- The head of the run, a register two weeks on, and a week further on a
  -- session whose new date will be declared off.
  SELECT id, session_date INTO v_anchor FROM public.class_sessions
   WHERE cohort_id = t.cohort_id AND session_date > CURRENT_DATE
     AND status = 'scheduled'
   ORDER BY session_date LIMIT 1;

  v_new     := v_anchor.session_date + 2;
  v_new_dow := EXTRACT(DOW FROM v_new)::smallint;

  SELECT id, session_date INTO v_marked FROM public.class_sessions
   WHERE cohort_id = t.cohort_id AND session_date = v_anchor.session_date + 7;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_marked.id, t.class_id, 'S054A', 'excused', now(), 'staff');

  SELECT id, session_date INTO v_doomed FROM public.class_sessions
   WHERE cohort_id = t.cohort_id AND session_date = v_anchor.session_date + 14;
  PERFORM public.set_no_class_day(t.class_id, v_doomed.session_date + 2,
                                  'exempt', 'Sports day');

  -- ---- the preview
  SELECT count(*) INTO v_before FROM public.class_sessions WHERE class_id = t.class_id;
  SELECT count(*) INTO v_slots FROM public.cohort_schedules WHERE cohort_id = t.cohort_id;

  v_plan := public.move_session_to(v_anchor.id, v_new, 'future', true);

  IF (v_plan ->> 'moved')::integer < 2 THEN
    RAISE EXCEPTION '054: the preview moves %, too few to prove a run moved', v_plan ->> 'moved';
  END IF;
  IF (SELECT session_date FROM public.class_sessions WHERE id = v_anchor.id)
     <> v_anchor.session_date THEN
    RAISE EXCEPTION '054: a dry run moved the session';
  END IF;
  IF (SELECT count(*) FROM public.cohort_schedules WHERE cohort_id = t.cohort_id)
     <> v_slots THEN
    RAISE EXCEPTION '054: a dry run changed the weekly pattern';
  END IF;
  SELECT count(*) INTO v_after FROM public.class_sessions WHERE class_id = t.class_id;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '054: a dry run changed the number of sessions';
  END IF;

  -- ---- the move, which must do exactly what the preview said
  v_real := public.move_session_to(v_anchor.id, v_new, 'future', false);
  IF v_real - 'dry_run' <> v_plan - 'dry_run' THEN
    RAISE EXCEPTION '054: the preview said % and the move did %', v_plan, v_real;
  END IF;

  -- The pattern split at the date.
  SELECT effective_until INTO v_until FROM public.cohort_schedules
   WHERE cohort_id = t.cohort_id AND weekday = t.old_dow;
  IF v_until IS DISTINCT FROM v_anchor.session_date - 1 THEN
    RAISE EXCEPTION '054: the old day ends % — it should end the day before the move', v_until;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cohort_schedules
                  WHERE cohort_id = t.cohort_id AND weekday = v_new_dow
                    AND effective_from = v_new) THEN
    RAISE EXCEPTION '054: no meeting on the new day, starting on the new date';
  END IF;

  -- The head moved; the register did not; the day-off landing is gone.
  IF (SELECT session_date FROM public.class_sessions WHERE id = v_anchor.id) <> v_new THEN
    RAISE EXCEPTION '054: the dragged session is not on its new date';
  END IF;
  IF (SELECT session_date FROM public.class_sessions WHERE id = v_marked.id)
     <> v_marked.session_date THEN
    RAISE EXCEPTION '054: a register was moved to a day it was not taken on';
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_doomed.id) THEN
    RAISE EXCEPTION '054: a session was left to land on a declared day off';
  END IF;
  IF (v_real -> 'kept' ->> 'marked')::integer <> 1
     OR (v_real -> 'dropped' ->> 'day_off')::integer <> 1 THEN
    RAISE EXCEPTION '054: counted kept %, dropped % — expected one of each',
      v_real -> 'kept', v_real -> 'dropped';
  END IF;

  -- ---- the reason for all of it: a fill does not bring the old day back
  PERFORM public.fill_sessions(t.class_id, CURRENT_DATE, NULL, true, false);

  IF EXISTS (
    SELECT 1 FROM public.class_sessions s
     WHERE s.cohort_id = t.cohort_id
       AND EXTRACT(DOW FROM s.session_date)::smallint = t.old_dow
       AND s.session_date >= v_anchor.session_date
       AND s.status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM public.attendance_records a
                        WHERE a.session_id = s.id)
  ) THEN
    RAISE EXCEPTION '054: a fill after the move brought the old weekday back';
  END IF;

  RAISE NOTICE '054 ok: a run moves by splitting the pattern, and a fill does not undo it';
END;
$run$;

-- -------------------------------------- a pattern save keeps the split intact --
DO $save_after$
DECLARE
  t       record;
  v_slots jsonb;
  v_plan  jsonb;
BEGIN
  SELECT * INTO t FROM t054;

  -- Exactly what the editor sends back: every slot, with its dates.
  SELECT jsonb_agg(jsonb_build_object(
           'weekday', s.weekday,
           'start_time', to_char(s.start_time, 'HH24:MI'),
           'effective_from', s.effective_from,
           'effective_until', s.effective_until))
    INTO v_slots
    FROM public.cohort_schedules s WHERE s.cohort_id = t.cohort_id;

  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id], v_slots);

  IF NOT EXISTS (SELECT 1 FROM public.cohort_schedules
                  WHERE cohort_id = t.cohort_id AND weekday = t.old_dow
                    AND effective_until IS NOT NULL) THEN
    RAISE EXCEPTION '054: a pattern save after the move lost the old day''s end date';
  END IF;

  -- And the term already matches it: nothing to add, nothing to take away.
  v_plan := public.fill_sessions(t.class_id, CURRENT_DATE, NULL, true, true);
  IF (v_plan ->> 'created')::integer <> 0 OR (v_plan ->> 'removed')::integer <> 0 THEN
    RAISE EXCEPTION '054: after a save the term would change — created %, removed %',
      v_plan ->> 'created', v_plan ->> 'removed';
  END IF;

  RAISE NOTICE '054 ok: a pattern save after a move keeps the split';
END;
$save_after$;

-- ------------------------------------------------------------ the refusals --
DO $refusals$
DECLARE
  t       record;
  v_class public.classes%ROWTYPE;
  v_sess  record;
  v_hand  uuid;
  ok      boolean;
  v_why   text;
BEGIN
  SELECT * INTO t FROM t054;
  SELECT * INTO v_class FROM public.classes WHERE id = t.class_id;

  SELECT id, session_date INTO v_sess FROM public.class_sessions s
   WHERE s.cohort_id = t.cohort_id AND s.session_date > CURRENT_DATE
     AND s.status = 'scheduled' AND NOT s.moved_manually
     AND NOT EXISTS (SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id)
   ORDER BY s.session_date LIMIT 1;

  -- Same weekday: the run would not change day.
  BEGIN
    PERFORM public.move_session_to(v_sess.id, v_sess.session_date + 7, 'future');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true; v_why := SQLERRM;
  END;
  IF NOT ok OR v_why NOT LIKE '%just this session%' THEN
    RAISE EXCEPTION '054: a same-weekday run move was not refused helpfully: %', v_why;
  END IF;

  -- Onto a day the cohort already meets at that time.
  PERFORM public.set_cohort_schedules(
    ARRAY[t.cohort_id],
    (SELECT jsonb_agg(jsonb_build_object(
              'weekday', s.weekday, 'start_time', to_char(s.start_time, 'HH24:MI'),
              'effective_from', s.effective_from, 'effective_until', s.effective_until))
       FROM public.cohort_schedules s WHERE s.cohort_id = t.cohort_id)
    || jsonb_build_array(jsonb_build_object(
         'weekday', (EXTRACT(DOW FROM v_sess.session_date)::int + 1) % 7,
         'start_time', '09:00')));
  BEGIN
    PERFORM public.move_session_to(v_sess.id, v_sess.session_date + 1, 'future');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true; v_why := SQLERRM;
  END;
  IF NOT ok OR v_why NOT LIKE '%collide%' THEN
    RAISE EXCEPTION '054: a run moved onto a day it already meets: %', v_why;
  END IF;

  -- A session nobody's pattern made has no run to move.
  v_hand := (public.create_ad_hoc_session(t.cohort_id, CURRENT_DATE + 3, TIME '15:00')
             ->> 'session_id')::uuid;
  BEGIN
    PERFORM public.move_session_to(v_hand, CURRENT_DATE + 4, 'future');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true; v_why := SQLERRM;
  END;
  IF NOT ok OR v_why NOT LIKE '%not part of the weekly pattern%' THEN
    RAISE EXCEPTION '054: a hand-added session moved as a run: %', v_why;
  END IF;

  -- But it can always move on its own.
  PERFORM public.move_session_to(v_hand, CURRENT_DATE + 4, 'one');
  IF (SELECT session_date FROM public.class_sessions WHERE id = v_hand)
     <> CURRENT_DATE + 4 THEN
    RAISE EXCEPTION '054: moving one hand-added session did nothing';
  END IF;

  RAISE NOTICE '054 ok: the three run refusals each say what to do instead';
END;
$refusals$;

ROLLBACK;
