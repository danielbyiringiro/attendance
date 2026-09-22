-- ============================================================================
-- Migration 053 — see what filling would do, before it does it
--
-- The assertion that justifies the whole design is "a dry run changes nothing
-- and predicts exactly": the counts a preview reports are compared against
-- what the real call then does, on the same state. A preview written as its
-- own counting query could pass every other check here and still drift from
-- the action the first time a guard is added to one and not the other.
--
-- What is checked:
--
--   a dry run reports what would happen and writes nothing at all
--   the real call then does exactly what the dry run said
--   pruning never reaches behind today
--   a session with attendance is left standing, and counted as left alone
--   so is a hand-moved one, and a cancelled one
--   the three are counted separately, and never twice
--   a backwards range is refused
--   "this and every later one" stops at a register, and does not reach back
--   "all of them" moves the whole run
--   changing a date over a run is refused, and says to use the weekly pattern
--   an unknown scope is refused rather than quietly meaning "one"
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
  -- A term that has been running a fortnight and has a fortnight to go, so
  -- "behind today" and "ahead of today" are both real halves of it.
  v_class := (public.create_class('ASSERT-053', 'Filling',
                CURRENT_DATE - 14, CURRENT_DATE + 28, 'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S053A", "name": "One"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 14
   WHERE cohort_id = v_cohort;

  -- Meets on the weekday today falls on, so every week of the term has one.
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    jsonb_build_array(jsonb_build_object(
      'weekday', EXTRACT(DOW FROM CURRENT_DATE)::int,
      'start_time', '09:00'))
  );

  CREATE TEMP TABLE t053 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id;
END;
$setup$;

-- ------------------------------------ a dry run predicts, and writes nothing --
DO $dry$
DECLARE
  t        record;
  v_plan   jsonb;
  v_real   jsonb;
  v_before integer;
  v_after  integer;
BEGIN
  SELECT * INTO t FROM t053;

  SELECT count(*) INTO v_before FROM public.class_sessions
   WHERE class_id = t.class_id;

  v_plan := public.fill_sessions(t.class_id, NULL, NULL, true, true);

  IF NOT (v_plan ->> 'dry_run')::boolean THEN
    RAISE EXCEPTION '053: a dry run did not say it was one';
  END IF;
  IF (v_plan ->> 'created')::integer = 0 THEN
    RAISE EXCEPTION '053: the fixture had nothing to create, so this proves nothing';
  END IF;

  SELECT count(*) INTO v_after FROM public.class_sessions
   WHERE class_id = t.class_id;
  IF v_after <> v_before THEN
    RAISE EXCEPTION '053: a dry run created % sessions', v_after - v_before;
  END IF;

  -- The same call for real, on the same state the preview saw.
  v_real := public.fill_sessions(t.class_id, NULL, NULL, true, false);

  IF (v_real ->> 'created') <> (v_plan ->> 'created')
     OR (v_real ->> 'removed') <> (v_plan ->> 'removed') THEN
    RAISE EXCEPTION
      '053: the preview said created %, removed % — the call did created %, removed %',
      v_plan ->> 'created', v_plan ->> 'removed',
      v_real ->> 'created', v_real ->> 'removed';
  END IF;

  SELECT count(*) INTO v_after FROM public.class_sessions
   WHERE class_id = t.class_id;
  IF v_after - v_before <> (v_plan ->> 'created')::integer THEN
    RAISE EXCEPTION '053: the preview promised % but % appeared',
      v_plan ->> 'created', v_after - v_before;
  END IF;

  RAISE NOTICE '053 ok: a dry run writes nothing and predicts exactly';
END;
$dry$;

-- ------------------------------- pruning stops at today, and spares the rest --
-- The pattern is emptied, so EVERY session it made is now unwanted. What
-- survives is the whole point: the past, and three kinds of session ahead.
DO $prune$
DECLARE
  t          record;
  v_marked   uuid;
  v_byhand   uuid;
  v_cancel   uuid;
  v_plan     jsonb;
  v_past     integer;
  v_kept     jsonb;
BEGIN
  SELECT * INTO t FROM t053;

  -- Three future sessions that must survive, each for a different reason.
  SELECT id INTO v_marked FROM public.class_sessions
   WHERE class_id = t.class_id AND session_date > CURRENT_DATE
   ORDER BY session_date LIMIT 1;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_marked, t.class_id, 'S053A', 'present', now(), 'staff');

  SELECT id INTO v_byhand FROM public.class_sessions
   WHERE class_id = t.class_id AND session_date > CURRENT_DATE
     AND id <> v_marked
   ORDER BY session_date LIMIT 1;
  UPDATE public.class_sessions SET moved_manually = true WHERE id = v_byhand;

  SELECT id INTO v_cancel FROM public.class_sessions
   WHERE class_id = t.class_id AND session_date > CURRENT_DATE
     AND id NOT IN (v_marked, v_byhand)
   ORDER BY session_date LIMIT 1;
  PERFORM public.cancel_session(v_cancel, 'Called off');

  SELECT count(*) INTO v_past FROM public.class_sessions
   WHERE class_id = t.class_id AND session_date < CURRENT_DATE;
  IF v_past = 0 THEN
    RAISE EXCEPTION '053: no past sessions, so "pruning stops at today" proves nothing';
  END IF;

  -- Nothing is wanted any more.
  PERFORM public.set_cohort_schedules(ARRAY[t.cohort_id], '[]'::jsonb);

  v_plan := public.fill_sessions(t.class_id, NULL, NULL, true, false);
  v_kept := v_plan -> 'kept';

  IF (v_kept ->> 'marked')::integer <> 1 THEN
    RAISE EXCEPTION '053: % counted as marked, expected 1', v_kept ->> 'marked';
  END IF;
  IF (v_kept ->> 'by_hand')::integer <> 1 THEN
    RAISE EXCEPTION '053: % counted as moved by hand, expected 1', v_kept ->> 'by_hand';
  END IF;
  IF (v_kept ->> 'cancelled')::integer <> 1 THEN
    RAISE EXCEPTION '053: % counted as cancelled, expected 1', v_kept ->> 'cancelled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_marked) THEN
    RAISE EXCEPTION '053: a session with attendance against it was removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_byhand) THEN
    RAISE EXCEPTION '053: a hand-moved session was removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_cancel) THEN
    RAISE EXCEPTION '053: a cancelled session was removed';
  END IF;

  IF (SELECT count(*) FROM public.class_sessions
       WHERE class_id = t.class_id AND session_date < CURRENT_DATE) <> v_past THEN
    RAISE EXCEPTION '053: pruning reached behind today';
  END IF;

  RAISE NOTICE '053 ok: pruning stops at today and spares marked, moved and cancelled';
END;
$prune$;

-- ------------------------------------------------ a backwards range is refused --
DO $backwards$
DECLARE
  t  record;
  ok boolean;
BEGIN
  SELECT * INTO t FROM t053;

  BEGIN
    PERFORM public.fill_sessions(
      t.class_id, CURRENT_DATE + 10, CURRENT_DATE + 1, true, true);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: a range that runs backwards was accepted';
  END IF;

  RAISE NOTICE '053 ok: a range that runs backwards is refused';
END;
$backwards$;


-- ------------------------------------ editing one session, or its whole run --
-- The three scopes a calendar app offers. What makes them worth testing is not
-- the arithmetic but the refusals: a bulk edit must not restamp a register,
-- and must not pretend to move a weekday the weekly pattern still owns.
DO $series$
DECLARE
  t         record;
  v_first   uuid;
  v_middle  uuid;
  v_marked  uuid;
  v_counts  jsonb;
  v_out     jsonb;
  v_time    time;
  v_class   public.classes%ROWTYPE;
  ok        boolean;
  v_why     text;
  n         integer;
  v_expect  integer;
BEGIN
  SELECT * INTO t FROM t053;
  SELECT * INTO v_class FROM public.classes WHERE id = t.class_id;

  -- A fresh run: every week of the term, one cohort, one time.
  PERFORM public.set_cohort_schedules(
    ARRAY[t.cohort_id],
    jsonb_build_array(jsonb_build_object(
      'weekday', EXTRACT(DOW FROM CURRENT_DATE)::int,
      'start_time', '09:00'))
  );
  PERFORM public.fill_sessions(t.class_id, NULL, NULL, true, false);

  SELECT count(*) INTO n FROM public.class_sessions
   WHERE cohort_id = t.cohort_id
     AND (starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00';
  IF n < 4 THEN
    RAISE EXCEPTION '053: only % sessions in the run, too few to tell the scopes apart', n;
  END IF;

  SELECT id INTO v_first FROM public.class_sessions
   WHERE cohort_id = t.cohort_id
     AND (starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
   ORDER BY session_date LIMIT 1;

  -- Unmarked on purpose. An earlier block in this file leaves a register on
  -- one of the future sessions, and anchoring on that one would test nothing:
  -- it is correctly skipped, so it would keep its old time and the assertion
  -- below would read as a bug in the rule rather than a bug in the fixture.
  SELECT id INTO v_middle FROM public.class_sessions s
   WHERE s.cohort_id = t.cohort_id
     AND (s.starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
     AND s.session_date > CURRENT_DATE
     AND s.status = 'scheduled'
     AND NOT EXISTS (SELECT 1 FROM public.attendance_records a
                      WHERE a.session_id = s.id)
   ORDER BY s.session_date LIMIT 1;

  -- The counts the dialog shows before anything is chosen.
  v_counts := public.count_session_series(v_middle);
  IF (v_counts ->> 'series')::integer <> n THEN
    RAISE EXCEPTION '053: the run has % sessions, counted %', n, v_counts ->> 'series';
  END IF;
  IF (v_counts ->> 'future')::integer >= (v_counts ->> 'series')::integer THEN
    RAISE EXCEPTION
      '053: "this and later" counted % of a run of % — it should be fewer',
      v_counts ->> 'future', v_counts ->> 'series';
  END IF;

  -- A register on one of the later ones. It must survive every bulk edit.
  -- Scheduled and unmarked to begin with: an earlier block cancelled one of
  -- these, and putting the register on that would prove nothing, because a
  -- cancelled session is skipped for its status before the register is ever
  -- looked at.
  SELECT id INTO v_marked FROM public.class_sessions s
   WHERE s.cohort_id = t.cohort_id
     AND (s.starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
     AND s.status = 'scheduled'
     AND s.session_date > (SELECT session_date FROM public.class_sessions
                            WHERE id = v_middle)
     AND NOT EXISTS (SELECT 1 FROM public.attendance_records a
                      WHERE a.session_id = s.id)
   ORDER BY s.session_date LIMIT 1;
  IF v_marked IS NULL THEN
    RAISE EXCEPTION '053: no clean session after the anchor to put a register on';
  END IF;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_marked, t.class_id, 'S053A', 'present', now(), 'staff');

  -- How many of the run from here on already carry a register. Counted from
  -- the data rather than assumed to be the one just written: earlier blocks in
  -- this file mark sessions too, and a hard-coded 1 made this assertion pass
  -- or fail on which tests ran before it rather than on the rule.
  SELECT count(*) INTO v_expect
    FROM public.class_sessions s
   WHERE s.cohort_id = t.cohort_id
     AND (s.starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
     AND s.session_date >= (SELECT session_date FROM public.class_sessions
                             WHERE id = v_middle)
     AND s.status = 'scheduled'
     AND EXISTS (SELECT 1 FROM public.attendance_records a
                  WHERE a.session_id = s.id);
  IF v_expect = 0 THEN
    RAISE EXCEPTION '053: nothing in the run is marked, so the next check proves nothing';
  END IF;

  -- ---- this and every later one
  v_out := public.update_session_series(
    v_middle, 'future', NULL, TIME '11:00');

  IF (v_out ->> 'skipped_marked')::integer <> v_expect THEN
    RAISE EXCEPTION '053: % marked sessions skipped, expected %',
      v_out ->> 'skipped_marked', v_expect;
  END IF;
  IF (v_out ->> 'updated')::integer = 0 THEN
    RAISE EXCEPTION '053: "this and later" changed nothing';
  END IF;

  SELECT (starts_at AT TIME ZONE v_class.timezone)::time INTO v_time
    FROM public.class_sessions WHERE id = v_marked;
  IF v_time <> TIME '09:00' THEN
    RAISE EXCEPTION '053: the register was restamped to %', v_time;
  END IF;

  SELECT (starts_at AT TIME ZONE v_class.timezone)::time INTO v_time
    FROM public.class_sessions WHERE id = v_middle;
  IF v_time <> TIME '11:00' THEN
    RAISE EXCEPTION '053: the session edited from reads %', v_time;
  END IF;

  -- The earlier ones are untouched: "future" means from here on.
  SELECT (starts_at AT TIME ZONE v_class.timezone)::time INTO v_time
    FROM public.class_sessions WHERE id = v_first;
  IF v_time <> TIME '09:00' THEN
    RAISE EXCEPTION '053: "this and later" reached backwards and made the first %', v_time;
  END IF;

  RAISE NOTICE '053 ok: "this and every later one" stops at the register and at today''s edge';
END;
$series$;

-- ---------------------------------------- a whole run, and the two refusals --
DO $series_all$
DECLARE
  t       record;
  v_any   uuid;
  v_class public.classes%ROWTYPE;
  v_out   jsonb;
  v_left  integer;
  ok      boolean;
  v_why   text;
BEGIN
  SELECT * INTO t FROM t053;
  SELECT * INTO v_class FROM public.classes WHERE id = t.class_id;

  SELECT id INTO v_any FROM public.class_sessions
   WHERE cohort_id = t.cohort_id
     AND (starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
   ORDER BY session_date LIMIT 1;

  -- Everything still at 09:00, whenever it is, including behind today.
  v_out := public.update_session_series(v_any, 'series', NULL, TIME '08:00');

  SELECT count(*) INTO v_left FROM public.class_sessions
   WHERE cohort_id = t.cohort_id
     AND (starts_at AT TIME ZONE v_class.timezone)::time = TIME '09:00'
     AND status = 'scheduled'
     AND NOT EXISTS (SELECT 1 FROM public.attendance_records a
                      WHERE a.session_id = class_sessions.id);
  IF v_left <> 0 THEN
    RAISE EXCEPTION '053: "all of them" left % scheduled sessions behind', v_left;
  END IF;

  -- A date change is a single-session act, and says why.
  BEGIN
    PERFORM public.update_session_series(
      v_any, 'future', CURRENT_DATE + 3, NULL);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
    v_why := SQLERRM;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: a whole run was moved to another date';
  END IF;
  IF v_why NOT LIKE '%weekly pattern%' THEN
    RAISE EXCEPTION '053: refused a date change without saying why: %', v_why;
  END IF;

  -- An unknown scope is refused rather than quietly meaning "one".
  BEGIN
    PERFORM public.update_session_series(v_any, 'everything', NULL, TIME '10:00');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '053: an unknown scope was accepted';
  END IF;

  RAISE NOTICE '053 ok: a whole run moves, and a date change over one is refused';
END;
$series_all$;

ROLLBACK;
