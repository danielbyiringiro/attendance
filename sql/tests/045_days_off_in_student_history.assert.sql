-- ============================================================================
-- Migration 045 — days off, with reasons, in a student's own history
--
-- One class, two cohorts, three days off, and a second class with its own:
--
--   whole class, nothing held       "Public holiday"        both students
--   cohort A only                   "Cohort A field trip"   A only
--   cohort B only, counted, after
--   a session was held              "Cohort B lab credit"   B only
--   the other class                 "Not your class"        neither
--
-- The cohort scope is the part that matters: a day off for one cohort must not
-- appear on another cohort's record, and another class's must never appear at
-- all. The existing keys are checked too, because the history screen reads them.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class uuid;
  v_a     uuid;
  v_b     uuid;
  v_other uuid;
BEGIN
  v_class := (public.create_class('ASSERT-045', 'Days Off',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 2) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "S045A", "name": "In A"}]'::jsonb);
  PERFORM public.upsert_enrolments(v_b, '[{"student_id": "S045B", "name": "In B"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id IN (v_a, v_b);

  PERFORM public.set_no_class_day(v_class, CURRENT_DATE + 10, 'exempt', 'Public holiday');
  PERFORM public.set_no_class_day(v_class, CURRENT_DATE + 11, 'exempt', 'Cohort A field trip', v_a);

  -- Held, then declared as counting: the session is kept and everybody present.
  PERFORM set_config('t045.cohort_b',
    public.create_ad_hoc_session(v_b, CURRENT_DATE - 2, TIME '09:00') ->> 'session_id', true);
  PERFORM public.set_no_class_day(v_class, CURRENT_DATE - 2, 'present', 'Cohort B lab credit', v_b);

  -- A mark the cohort A student has on a cohort B session, as a student who
  -- moved from B to A would. The TA's record of them shows it.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (current_setting('t045.cohort_b')::uuid, v_class, 'S045A', 'late', now(), 'staff');

  v_other := (public.create_class('ASSERT-045B', 'Elsewhere',
                CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  PERFORM public.set_no_class_day(v_other, CURRENT_DATE + 12, 'exempt', 'Not your class');

  -- Two scheduled sessions for cohort A: a register taken early on one, nothing
  -- on the other. The TA's log keeps the first and not the second.
  PERFORM set_config('t045.marked',
    public.create_ad_hoc_session(v_a, CURRENT_DATE + 3, TIME '09:00') ->> 'session_id', true);
  PERFORM set_config('t045.unmarked',
    public.create_ad_hoc_session(v_a, CURRENT_DATE + 4, TIME '09:00') ->> 'session_id', true);
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (current_setting('t045.marked')::uuid, v_class, 'S045A', 'present', now(), 'staff');
END;
$setup$;

RESET ROLE;
SET ROLE anon;

DO $days_off$
DECLARE
  a         jsonb := public.get_student_attendance('S045A');
  b         jsonb := public.get_student_attendance('S045B');
  nobody    jsonb := public.get_student_attendance('NOBODY-045');
  a_reasons text;
  b_reasons text;
BEGIN
  SELECT string_agg(d ->> 'reason', '|' ORDER BY d ->> 'reason') INTO a_reasons
  FROM jsonb_array_elements(a -> 'days_off') AS d;
  IF a_reasons IS DISTINCT FROM 'Cohort A field trip|Public holiday' THEN
    RAISE EXCEPTION '045: a cohort A student sees days off [%], expected the whole class''s and their own cohort''s',
      a_reasons;
  END IF;

  SELECT string_agg(d ->> 'reason', '|' ORDER BY d ->> 'reason') INTO b_reasons
  FROM jsonb_array_elements(b -> 'days_off') AS d;
  IF b_reasons IS DISTINCT FROM 'Cohort B lab credit|Public holiday' THEN
    RAISE EXCEPTION '045: a cohort B student sees days off [%], expected the whole class''s and their own cohort''s',
      b_reasons;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(b -> 'days_off') AS d
    WHERE d ->> 'reason' = 'Cohort B lab credit'
      AND d ->> 'mode' = 'present'
      AND d ->> 'class_code' = 'ASSERT-045'
      AND d ->> 'cohort' = 'B'
      AND (d ->> 'date')::date = CURRENT_DATE - 2
  ) THEN
    RAISE EXCEPTION '045: the counted day off came back without its date, mode, class or cohort: %',
      b -> 'days_off';
  END IF;

  IF position('Not your class' IN a::text) > 0 OR position('Not your class' IN b::text) > 0 THEN
    RAISE EXCEPTION '045: another class''s day off appeared in a student''s history';
  END IF;

  IF jsonb_array_length(nobody -> 'days_off') <> 0 THEN
    RAISE EXCEPTION '045: an ID nobody has returned days off: %', nobody -> 'days_off';
  END IF;

  IF NOT (a ? 'sessions' AND a ? 'flagged') THEN
    RAISE EXCEPTION '045: the history lost a key the screen reads: %', a;
  END IF;

  RAISE NOTICE '045 ok: each student sees their class''s and cohort''s days off with reasons, and nobody else''s';
END;
$days_off$;

DO $early_register$
DECLARE
  a jsonb := public.get_student_attendance('S045A');
BEGIN
  IF position(current_setting('t045.marked') IN (a -> 'sessions')::text) = 0 THEN
    RAISE EXCEPTION '045: a register taken early is on the TA''s record of this student but missing from their own history';
  END IF;

  IF position(current_setting('t045.unmarked') IN (a -> 'sessions')::text) > 0 THEN
    RAISE EXCEPTION '045: an unmarked session that has not happened yet appeared in the history';
  END IF;

  IF position(current_setting('t045.cohort_b') IN (a -> 'sessions')::text) = 0 THEN
    RAISE EXCEPTION '045: a mark from another cohort of the class is on the TA''s record of this student but missing from their own history';
  END IF;

  IF jsonb_array_length(a -> 'sessions') <> (
       SELECT count(DISTINCT x ->> 'session_id') FROM jsonb_array_elements(a -> 'sessions') AS x) THEN
    RAISE EXCEPTION '045: a session appears twice in the history: %', a -> 'sessions';
  END IF;

  RAISE NOTICE '045 ok: an early register and a mark from another cohort show in the student''s history, an unmarked future session does not';
END;
$early_register$;

ROLLBACK;
