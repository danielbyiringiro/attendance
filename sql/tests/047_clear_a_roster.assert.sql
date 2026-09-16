-- ============================================================================
-- Migration 047 — clearing a roster, keeping or erasing what was recorded
--
-- One class, ASSERT-047, two cohorts:
--
--   S047A    cohort A, one attendance record, this class only
--   S047A2   cohort A, this class only
--   S047B    cohort B, one attendance record, this class only
--   S047X    cohort A here, and also enrolled in a second class
--
-- What is checked:
--
--   the preview counts what is in scope, class-wide and per cohort
--   a wrong confirmation code changes nothing
--   KEEP drops every enrolment and deletes no attendance
--   ERASE on one cohort takes that cohort only, and leaves the other alone
--   a student in another class survives as a person, losing only this class
--   a student left in no class at all is deleted, with their flag
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class uuid;
  v_other uuid;
  v_a     uuid;
  v_b     uuid;
  v_oa    uuid;
  v_sess  uuid;
BEGIN
  v_class := (public.create_class('ASSERT-047', 'Clearing',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 2) ->> 'class_id')::uuid;
  PERFORM set_config('t047.class', v_class::text, true);

  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';
  PERFORM set_config('t047.cohort_a', v_a::text, true);

  PERFORM public.upsert_enrolments(v_a,
    '[{"student_id": "S047A",  "name": "In A"},
      {"student_id": "S047A2", "name": "Also in A"},
      {"student_id": "S047X",  "name": "Takes two"}]'::jsonb);
  PERFORM public.upsert_enrolments(v_b, '[{"student_id": "S047B", "name": "In B"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id IN (v_a, v_b);

  -- A second class, so S047X is not left in nothing when this one is cleared.
  v_other := (public.create_class('ASSERT-047B', 'Elsewhere',
                CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  SELECT id INTO v_oa FROM public.cohorts WHERE class_id = v_other AND label = 'A';
  PERFORM public.upsert_enrolments(v_oa, '[{"student_id": "S047X", "name": "Takes two"}]'::jsonb);

  -- Attendance in this class: one session per cohort, one mark each.
  v_sess := (public.create_ad_hoc_session(v_a, CURRENT_DATE - 2, TIME '09:00') ->> 'session_id')::uuid;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_sess, v_class, 'S047A', 'present', now(), 'staff'),
         (v_sess, v_class, 'S047X', 'unexcused', now(), 'staff');

  v_sess := (public.create_ad_hoc_session(v_b, CURRENT_DATE - 2, TIME '14:00') ->> 'session_id')::uuid;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_sess, v_class, 'S047B', 'present', now(), 'staff');

  -- A flag of S047A2's, so an erase has one to clear.
  INSERT INTO public.flagged (student_id, session_date, status, class_id)
  VALUES ('S047A2', CURRENT_DATE - 2, 'flagged', v_class);
END;
$setup$;

DO $preview$
DECLARE
  whole  jsonb := public.preview_roster_clearing(current_setting('t047.class')::uuid);
  cohort jsonb := public.preview_roster_clearing(
                    current_setting('t047.class')::uuid,
                    current_setting('t047.cohort_a')::uuid);
BEGIN
  IF (whole ->> 'scope') <> 'class' OR (whole ->> 'students')::int <> 4 THEN
    RAISE EXCEPTION '047: the class-wide preview says scope=% students=%, expected class and 4',
      whole ->> 'scope', whole ->> 'students';
  END IF;

  IF (whole ->> 'attendance_records')::int <> 3 THEN
    RAISE EXCEPTION '047: the preview counted % attendance records, expected 3',
      whole ->> 'attendance_records';
  END IF;

  -- S047X takes another class, so only the other three would be left with none.
  IF (whole ->> 'students_also_deleted')::int <> 3 THEN
    RAISE EXCEPTION '047: the preview says % students would be left in no class, expected 3 (S047X takes another)',
      whole ->> 'students_also_deleted';
  END IF;

  IF (cohort ->> 'scope') <> 'cohort'
     OR (cohort ->> 'cohort_label') <> 'A'
     OR (cohort ->> 'students')::int <> 3 THEN
    RAISE EXCEPTION '047: the cohort preview says scope=% label=% students=%, expected cohort A and 3',
      cohort ->> 'scope', cohort ->> 'cohort_label', cohort ->> 'students';
  END IF;

  -- Cohort A holds two of the three marks, and its flag.
  IF (cohort ->> 'attendance_records')::int <> 2 OR (cohort ->> 'flags')::int <> 1 THEN
    RAISE EXCEPTION '047: the cohort preview counted % records and % flags, expected 2 and 1',
      cohort ->> 'attendance_records', cohort ->> 'flags';
  END IF;

  RAISE NOTICE '047 ok: the preview counts what is in scope, class-wide and per cohort';
END;
$preview$;

DO $refusals$
DECLARE
  ok boolean;
BEGIN
  BEGIN
    PERFORM public.clear_roster(current_setting('t047.class')::uuid, 'not-the-code');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '047: a roster was cleared without the class code being typed';
  END IF;

  IF (SELECT count(*) FROM public.enrolments
       WHERE class_id = current_setting('t047.class')::uuid) <> 4 THEN
    RAISE EXCEPTION '047: the refused call changed the roster anyway';
  END IF;

  BEGIN
    PERFORM public.preview_roster_clearing(
      current_setting('t047.class')::uuid,
      (SELECT id FROM public.cohorts
        WHERE class_id <> current_setting('t047.class')::uuid LIMIT 1));
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '047: a cohort of another class was accepted as a scope';
  END IF;

  RAISE NOTICE '047 ok: the wrong code and a cohort from elsewhere are both refused';
END;
$refusals$;

DO $keep$
DECLARE
  result jsonb;
BEGIN
  result := public.clear_roster(
    p_class_id     := current_setting('t047.class')::uuid,
    p_confirm_code := 'assert-047',   -- case and spacing are forgiven
    p_cohort_id    := NULL,
    p_erase        := false);

  IF (result ->> 'erased')::boolean OR (result ->> 'removed')::int <> 4 THEN
    RAISE EXCEPTION '047: keeping removed=% erased=%, expected 4 and false',
      result ->> 'removed', result ->> 'erased';
  END IF;

  IF EXISTS (SELECT 1 FROM public.enrolments
              WHERE class_id = current_setting('t047.class')::uuid
                AND dropped_on IS NULL) THEN
    RAISE EXCEPTION '047: somebody is still on the roster after it was cleared';
  END IF;

  IF (SELECT count(*) FROM public.attendance_records
       WHERE class_id = current_setting('t047.class')::uuid) <> 3 THEN
    RAISE EXCEPTION '047: keeping the records deleted some of them';
  END IF;

  IF (SELECT count(*) FROM public.enrolments
       WHERE class_id = current_setting('t047.class')::uuid) <> 4 THEN
    RAISE EXCEPTION '047: keeping the records deleted the enrolments';
  END IF;

  RAISE NOTICE '047 ok: keeping drops everyone and deletes nothing';
END;
$keep$;

DO $erase_cohort$
DECLARE
  result jsonb;
BEGIN
  result := public.clear_roster(
    p_class_id     := current_setting('t047.class')::uuid,
    p_confirm_code := 'ASSERT-047',
    p_cohort_id    := current_setting('t047.cohort_a')::uuid,
    p_erase        := true);

  IF NOT (result ->> 'erased')::boolean OR (result ->> 'removed')::int <> 3 THEN
    RAISE EXCEPTION '047: erasing cohort A removed=% erased=%, expected 3 and true',
      result ->> 'removed', result ->> 'erased';
  END IF;

  -- Cohort B is untouched: its student, its enrolment and its mark.
  IF (SELECT count(*) FROM public.enrolments
       WHERE class_id = current_setting('t047.class')::uuid) <> 1 THEN
    RAISE EXCEPTION '047: erasing one cohort took the other cohort''s enrolments';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'S047B')
     OR NOT EXISTS (SELECT 1 FROM public.attendance_records
                     WHERE class_id = current_setting('t047.class')::uuid
                       AND student_id = 'S047B') THEN
    RAISE EXCEPTION '047: erasing cohort A took cohort B''s student or their attendance';
  END IF;

  -- Cohort A's attendance and flag are gone.
  IF EXISTS (SELECT 1 FROM public.attendance_records
              WHERE class_id = current_setting('t047.class')::uuid
                AND student_id IN ('S047A', 'S047X')) THEN
    RAISE EXCEPTION '047: an erased student still has attendance in this class';
  END IF;

  IF EXISTS (SELECT 1 FROM public.flagged
              WHERE class_id = current_setting('t047.class')::uuid) THEN
    RAISE EXCEPTION '047: an erased student still has a flag in this class';
  END IF;

  -- The two who took nothing else are gone as people; the one who takes a
  -- second class is kept, with that class's enrolment intact.
  IF EXISTS (SELECT 1 FROM public.students WHERE student_id IN ('S047A', 'S047A2')) THEN
    RAISE EXCEPTION '047: a student left in no class at all was kept in the registry';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'S047X')
     OR NOT EXISTS (SELECT 1 FROM public.enrolments WHERE student_id = 'S047X') THEN
    RAISE EXCEPTION '047: a student who takes another class was deleted with this one';
  END IF;

  IF (result ->> 'students_deleted')::int <> 2 THEN
    RAISE EXCEPTION '047: reported % students deleted, expected 2',
      result ->> 'students_deleted';
  END IF;

  RAISE NOTICE '047 ok: erasing one cohort takes only its side of the record, and only the people left with nothing';
END;
$erase_cohort$;

ROLLBACK;
