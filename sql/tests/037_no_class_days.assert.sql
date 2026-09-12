-- ============================================================================
-- Migration 036 — a day the class does not meet
--
-- The assertion that justifies the table is the last one: declaring a holiday
-- and then regenerating must NOT bring the day back. Everything else here could
-- be done with cancel_session in a loop; remembering is what cannot.
--
-- The two modes are checked for the thing that makes them different — what they
-- do to a rate — rather than for the state string, because a mode written to
-- the wrong column would still store a plausible-looking row.
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
  v_other  uuid;
BEGIN
  v_class := (public.create_class('ASSERT-036', 'Holidays',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 2) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_other  FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S036A", "name": "One"},
      {"student_id": "S036B", "name": "Two"}]'::jsonb);
  PERFORM public.upsert_enrolments(v_other,
    '[{"student_id": "S036C", "name": "Three"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id IN (v_cohort, v_other);

  CREATE TEMP TABLE t036 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_other AS other_id,
         (CURRENT_DATE + 14)::date AS holiday;
END;
$setup$;

-- --------------------------------------------------- exempt: nobody counts --
DO $exempt$
DECLARE
  t          record;
  v_a        uuid;
  v_b        uuid;
  v_result   jsonb;
  v_states   text[];
  v_status   public.session_status;
BEGIN
  SELECT * INTO t FROM t036;

  -- One session per cohort on the holiday, and a check-in against one of them,
  -- so the overwrite is exercised rather than assumed.
  v_a := (public.create_ad_hoc_session(t.cohort_id, t.holiday, TIME '09:00') ->> 'session_id')::uuid;
  v_b := (public.create_ad_hoc_session(t.other_id,  t.holiday, TIME '14:00') ->> 'session_id')::uuid;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_a, t.class_id, 'S036A', 'present', now(), 'student');

  v_result := public.set_no_class_day(
    t.class_id, t.holiday, 'exempt', 'Public holiday');

  -- Cohort A's session had a check-in, so it is kept and marked. Cohort B's
  -- had nothing at all, so 037 removes it rather than leaving a closed session
  -- with a full register of exemptions on a date in the future.
  IF (v_result ->> 'sessions')::integer <> 1 THEN
    RAISE EXCEPTION
      '036: kept % session(s), expected the one that had a check-in against it',
      v_result ->> 'sessions';
  END IF;

  IF (v_result ->> 'removed')::integer <> 1 THEN
    RAISE EXCEPTION
      '037: removed % session(s), expected the untouched one — a placeholder on a holiday should simply not exist',
      v_result ->> 'removed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_b) THEN
    RAISE EXCEPTION
      '037: a scheduled session with nothing recorded against it survived a holiday';
  END IF;

  SELECT array_agg(DISTINCT state::text) INTO v_states
  FROM public.attendance_records WHERE session_id = v_a;

  IF v_states <> ARRAY['exempted'] THEN
    RAISE EXCEPTION
      '036: states after an exempt day are %, expected only exempted — a check-in on a declared holiday is not evidence the class ran',
      array_to_string(v_states, ', ');
  END IF;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = v_a;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION '036: the session was left % rather than closed', v_status;
  END IF;

  RAISE NOTICE '036 ok: the marked session was exempted, the untouched one removed';
END;
$exempt$;

-- ------------------------------------------ the day leaves the percentage --
DO $rate$
DECLARE
  t       record;
  v_graded integer;
BEGIN
  SELECT * INTO t FROM t036;

  -- The point of `exempted`: it is in neither half of a rate. If these rows
  -- counted as absences, declaring a holiday would punish the whole class.
  SELECT count(*) INTO v_graded
  FROM public.attendance_records a
  JOIN public.class_sessions s ON s.id = a.session_id
  WHERE s.class_id = t.class_id
    AND s.session_date = t.holiday
    AND a.state IN ('present', 'late', 'unexcused');

  IF v_graded <> 0 THEN
    RAISE EXCEPTION
      '036: % row(s) on the holiday still count toward a rate', v_graded;
  END IF;

  RAISE NOTICE '036 ok: nothing on the exempt day counts either way';
END;
$rate$;

-- ------------------------------------------------- and it is remembered --
DO $remembered$
DECLARE
  t       record;
  v_count integer;
BEGIN
  SELECT * INTO t FROM t036;

  -- THE assertion. cancel_session in a loop could do everything above; what it
  -- cannot do is survive this. The pattern still wants that weekday, so without
  -- the table the holiday comes straight back.
  DELETE FROM public.class_sessions
   WHERE class_id = t.class_id AND session_date = t.holiday;

  BEGIN
    PERFORM public.create_ad_hoc_session(t.cohort_id, t.holiday, TIME '09:00');
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- refusal is fine; silence is not
  END;

  SELECT count(*) INTO v_count
  FROM public.class_sessions
  WHERE class_id = t.class_id AND session_date = t.holiday;

  IF v_count <> 0 THEN
    RAISE EXCEPTION
      '036: % session(s) reappeared on a declared holiday — the declaration is not remembered',
      v_count;
  END IF;

  RAISE NOTICE '036 ok: sessions cannot be created on a declared day';
END;
$remembered$;

-- ------------------------------------------- present: the day does count --
DO $present$
DECLARE
  t        record;
  v_day    date;
  v_id     uuid;
  v_result jsonb;
  v_states text[];
BEGIN
  SELECT * INTO t FROM t036;
  v_day := t.holiday + 1;

  v_id := (public.create_ad_hoc_session(t.cohort_id, v_day, TIME '09:00') ->> 'session_id')::uuid;

  v_result := public.set_no_class_day(
    t.class_id, v_day, 'present', 'Online quiz, no room booked', t.cohort_id);

  SELECT array_agg(DISTINCT state::text) INTO v_states
  FROM public.attendance_records WHERE session_id = v_id;

  IF v_states <> ARRAY['present'] THEN
    RAISE EXCEPTION
      '036: a present day stored %, expected present for everyone',
      array_to_string(v_states, ', ');
  END IF;

  -- The session must NOT have been deleted. 037 removes empty placeholders on
  -- a holiday, and under 'present' that would be exactly wrong: the session is
  -- what carries the credit, so removing it leaves a day that helps nobody.
  IF (v_result ->> 'removed')::integer <> 0 THEN
    RAISE EXCEPTION
      '037: a present day deleted % session(s) — there is then nothing to credit',
      v_result ->> 'removed';
  END IF;

  -- Two students enrolled in that cohort, so two rows. A mode that credited
  -- only the people who had already marked would be worse than useless.
  IF (v_result ->> 'students')::integer <> 2 THEN
    RAISE EXCEPTION
      '036: credited % student(s), expected the whole cohort',
      v_result ->> 'students';
  END IF;

  -- Scoped to one cohort, so the other must be untouched on that date.
  IF EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE cohort_id = t.other_id AND session_date = v_day
  ) THEN
    RAISE EXCEPTION '036: the fixture unexpectedly gave cohort B a session that day';
  END IF;

  RAISE NOTICE '036 ok: present credited the whole cohort, and only that cohort';
END;
$present$;

-- ------------------------------------------------------------ reversible --
DO $clearing$
DECLARE
  t       record;
  v_left  integer;
  v_days  integer;
BEGIN
  SELECT * INTO t FROM t036;

  PERFORM public.clear_no_class_day(t.class_id, t.holiday);

  SELECT count(*) INTO v_days
  FROM public.no_class_days
  WHERE class_id = t.class_id AND on_date = t.holiday;

  IF v_days <> 0 THEN
    RAISE EXCEPTION '036: the declaration survived being cleared';
  END IF;

  -- And a session can be created on that date again.
  PERFORM public.create_ad_hoc_session(t.cohort_id, t.holiday, TIME '09:00');

  SELECT count(*) INTO v_left
  FROM public.class_sessions
  WHERE class_id = t.class_id AND session_date = t.holiday;

  IF v_left <> 1 THEN
    RAISE EXCEPTION
      '036: after clearing, creating a session on that date gave % rows', v_left;
  END IF;

  RAISE NOTICE '036 ok: clearing releases the date';
END;
$clearing$;

ROLLBACK;
