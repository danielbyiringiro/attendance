-- ============================================================================
-- Migration 046 — a class requires a percentage, or allows a number of absences
--
-- What is checked:
--
--   a new class is on the old rule            'percentage', so nothing about an
--                                             existing class changes
--   update_class sets the rule and the number
--   switching the rule keeps the other number a class that goes to 'absences'
--                                             and back still requires 80%
--   the columns refuse nonsense               an unknown rule, a negative
--                                             allowance
--   a student's history carries the rule      so their own page can say what
--                                             their class actually requires
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
BEGIN
  v_class := (public.create_class('ASSERT-046', 'Rules',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  PERFORM set_config('t046.class', v_class::text, true);

  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "S046", "name": "Rule Reader"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30 WHERE cohort_id = v_a;

  PERFORM set_config('t046.session',
    public.create_ad_hoc_session(v_a, CURRENT_DATE - 2, TIME '09:00') ->> 'session_id', true);
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (current_setting('t046.session')::uuid, v_class, 'S046', 'unexcused', now(), 'staff');
END;
$setup$;

DO $defaults$
DECLARE
  k public.classes%ROWTYPE;
BEGIN
  SELECT * INTO k FROM public.classes WHERE id = current_setting('t046.class')::uuid;

  IF k.attendance_rule <> 'percentage' THEN
    RAISE EXCEPTION '046: a new class is on rule [%], expected percentage — every existing class must keep the behaviour it had',
      k.attendance_rule;
  END IF;

  IF k.max_absences IS NULL THEN
    RAISE EXCEPTION '046: max_absences came back null; it is meant to always hold a value';
  END IF;

  RAISE NOTICE '046 ok: a class starts on the percentage rule, with an allowance already set';
END;
$defaults$;

DO $updates$
DECLARE
  k public.classes%ROWTYPE;
BEGIN
  PERFORM public.update_class(
    p_class_id                  := current_setting('t046.class')::uuid,
    p_min_attendance_percentage := 80,
    p_attendance_rule           := 'absences',
    p_max_absences              := 3);

  SELECT * INTO k FROM public.classes WHERE id = current_setting('t046.class')::uuid;
  IF k.attendance_rule <> 'absences' OR k.max_absences <> 3 THEN
    RAISE EXCEPTION '046: update_class did not set the rule and the allowance: % / %',
      k.attendance_rule, k.max_absences;
  END IF;

  -- Back to the percentage rule, naming only the rule.
  PERFORM public.update_class(
    p_class_id        := current_setting('t046.class')::uuid,
    p_attendance_rule := 'percentage');

  SELECT * INTO k FROM public.classes WHERE id = current_setting('t046.class')::uuid;
  IF k.min_attendance_percentage <> 80 OR k.max_absences <> 3 THEN
    RAISE EXCEPTION '046: switching the rule lost the other number: % / %',
      k.min_attendance_percentage, k.max_absences;
  END IF;

  RAISE NOTICE '046 ok: the rule and both numbers are set independently, and a switch keeps what the other rule uses';
END;
$updates$;

DO $refusals$
DECLARE
  ok boolean;
BEGIN
  BEGIN
    PERFORM public.update_class(
      p_class_id        := current_setting('t046.class')::uuid,
      p_attendance_rule := 'vibes');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '046: update_class accepted a rule that is neither percentage nor absences';
  END IF;

  BEGIN
    UPDATE public.classes SET max_absences = -1
     WHERE id = current_setting('t046.class')::uuid;
    ok := false;
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '046: a negative allowance was stored';
  END IF;

  RAISE NOTICE '046 ok: an unknown rule and a negative allowance are both refused';
END;
$refusals$;

RESET ROLE;
SET ROLE anon;

DO $history$
DECLARE
  s jsonb;
BEGIN
  SELECT x INTO s
  FROM jsonb_array_elements(public.get_student_attendance('S046') -> 'sessions') AS x
  WHERE x ->> 'session_id' = current_setting('t046.session')
  LIMIT 1;

  IF s IS NULL THEN
    RAISE EXCEPTION '046: the student''s own session is missing from their history';
  END IF;

  IF (s ->> 'attendance_rule') IS NULL OR (s ->> 'max_absences') IS NULL THEN
    RAISE EXCEPTION '046: the history does not carry the class''s rule, so the student''s page cannot say what is required: %', s;
  END IF;

  IF NOT (s ? 'min_attendance' AND s ? 'state' AND s ? 'status') THEN
    RAISE EXCEPTION '046: the history lost a key the screen reads: %', s;
  END IF;

  RAISE NOTICE '046 ok: a student''s history carries the rule their class is run by';
END;
$history$;

ROLLBACK;
