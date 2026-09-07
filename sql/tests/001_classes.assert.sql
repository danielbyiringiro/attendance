-- ============================================================================
-- Migration 001 — classes, cohorts, enrolments
--
-- Asserts behaviour, not just that the tables exist. The constraints here are
-- the whole point of the migration: without them "how many cohorts" is still a
-- convention rather than a fact, and the PIN check-in in 005 has no guarantee
-- to stand on.
--
-- Creates its own rows under code 'ASSERT-001' and removes them at the end, so
-- it does not interfere with the backfill's data in 004.
-- ============================================================================

DO $assert$
DECLARE
  v_class    uuid;
  v_class_b  uuid;
  v_cohort_a uuid;
  v_cohort_b uuid;
  n          bigint;
  failed     boolean;
BEGIN
  -- ==========================================================================
  -- Enums exist with the states the brief specifies
  -- ==========================================================================
  SELECT count(*) INTO n
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'attendance_state';
  IF n <> 6 THEN
    RAISE EXCEPTION 'attendance_state should have 6 values, has %', n;
  END IF;

  -- 'unexcused' is what close_session materialises in 003. Absence stops being
  -- derived only if there is a state to store it in.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'attendance_state' AND e.enumlabel = 'unexcused')
  THEN
    RAISE EXCEPTION 'attendance_state is missing "unexcused"';
  END IF;

  SELECT count(*) INTO n
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'session_status';
  IF n <> 4 THEN
    RAISE EXCEPTION 'session_status should have 4 values, has %', n;
  END IF;

  -- ==========================================================================
  -- A class can be created and carries its own settings
  -- ==========================================================================
  INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
  VALUES ('ASSERT-001', 'Assertion Class', DATE '2026-05-18', DATE '2026-08-28')
  RETURNING id INTO v_class;

  SELECT count(*) INTO n
  FROM public.classes
  WHERE id = v_class
    AND timezone = 'Africa/Accra'
    AND default_duration_minutes = 60
    AND default_late_window_minutes = 10;
  IF n <> 1 THEN
    RAISE EXCEPTION 'class defaults did not apply';
  END IF;

  -- A term that ends before it starts is rejected.
  failed := false;
  BEGIN
    INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
    VALUES ('ASSERT-001-BAD', 'Backwards', DATE '2026-08-28', DATE '2026-05-18');
  EXCEPTION WHEN check_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a class whose term ends before it starts was accepted';
  END IF;

  -- Class codes are unique case-insensitively, or asking the TA to type the
  -- code back to confirm a delete would be ambiguous.
  failed := false;
  BEGIN
    INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
    VALUES ('assert-001', 'Same code, lower case', DATE '2026-05-18', DATE '2026-08-28');
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'class code uniqueness is case-sensitive; it must not be';
  END IF;

  -- ==========================================================================
  -- Cohorts: the count is data, and labels are scoped to their class
  -- ==========================================================================
  INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'A')
  RETURNING id INTO v_cohort_a;
  INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'B')
  RETURNING id INTO v_cohort_b;

  -- Free-text labels: a class is not forced into letters.
  INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'Evening');

  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 cohorts on the class, found %', n;
  END IF;

  failed := false;
  BEGIN
    INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'a');
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'two cohorts labelled A and a were allowed in one class';
  END IF;

  -- But a DIFFERENT class may absolutely have its own Cohort A. This is what
  -- report_settings.cohort-as-primary-key makes impossible today.
  INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
  VALUES ('ASSERT-001-B', 'Second Class', DATE '2026-05-18', DATE '2026-08-28')
  RETURNING id INTO v_class_b;

  INSERT INTO public.cohorts (class_id, label) VALUES (v_class_b, 'A');

  SELECT count(*) INTO n FROM public.cohorts WHERE upper(btrim(label)) = 'A'
    AND class_id IN (v_class, v_class_b);
  IF n <> 2 THEN
    RAISE EXCEPTION 'two classes should each be able to have a Cohort A, found %', n;
  END IF;

  -- ==========================================================================
  -- Enrolments: a student is a person, not a row in one group
  -- ==========================================================================
  INSERT INTO public.enrolments (class_id, cohort_id, student_id)
  VALUES (v_class, v_cohort_a, 'S001');

  -- The same student in a DIFFERENT class. This is the whole point of decision
  -- 3, and the thing students.cohort cannot express.
  INSERT INTO public.enrolments (class_id, cohort_id, student_id)
  SELECT v_class_b, id, 'S001' FROM public.cohorts WHERE class_id = v_class_b LIMIT 1;

  SELECT count(*) INTO n FROM public.enrolments WHERE student_id = 'S001';
  IF n <> 2 THEN
    RAISE EXCEPTION 'a student should be enrollable in two classes, found % enrolments', n;
  END IF;

  SELECT count(*) INTO n FROM public.students WHERE student_id = 'S001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the student must still be exactly one row, found %', n;
  END IF;

  -- ...but NOT twice within one class, even in different cohorts. Without this,
  -- an open PIN could match two of the student's own sessions at once.
  failed := false;
  BEGIN
    INSERT INTO public.enrolments (class_id, cohort_id, student_id)
    VALUES (v_class, v_cohort_b, 'S001');
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a student was enrolled in two cohorts of the same class';
  END IF;

  -- The denormalised class_id cannot disagree with the cohort it points at.
  failed := false;
  BEGIN
    INSERT INTO public.enrolments (class_id, cohort_id, student_id)
    VALUES (v_class_b, v_cohort_b, 'S002');   -- cohort_b belongs to v_class
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'an enrolment with a mismatched class_id was accepted';
  END IF;

  -- Enrolment requires a real student: no orphans, unlike present_students.
  failed := false;
  BEGIN
    INSERT INTO public.enrolments (class_id, cohort_id, student_id)
    VALUES (v_class, v_cohort_b, 'S999');
  EXCEPTION WHEN foreign_key_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'an enrolment for a non-existent student was accepted';
  END IF;

  -- ==========================================================================
  -- Deleting a class takes its cohorts and enrolments, never its students
  -- ==========================================================================
  DELETE FROM public.classes WHERE id = v_class_b;

  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class_b;
  IF n <> 0 THEN
    RAISE EXCEPTION 'cohorts survived their class being deleted';
  END IF;

  SELECT count(*) INTO n FROM public.enrolments WHERE class_id = v_class_b;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolments survived their class being deleted';
  END IF;

  SELECT count(*) INTO n FROM public.students WHERE student_id = 'S001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'deleting a class deleted a student; students are global';
  END IF;

  -- ==========================================================================
  -- The legacy column is deprecated but still present for the bridge
  -- ==========================================================================
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'cohort')
  THEN
    RAISE EXCEPTION 'students.cohort was dropped too early; the bridge still reads it';
  END IF;

  -- ==========================================================================
  -- RLS
  -- ==========================================================================
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public'
    AND c.relname IN ('classes', 'cohorts', 'enrolments')
    AND c.relrowsecurity;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected RLS enabled on all 3 new tables, got %', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('classes', 'cohorts', 'enrolments')
    AND policyname LIKE '%_auth_all';
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected the 3 _auth_all policies, got %', n;
  END IF;

  -- anon must not reach these tables directly.
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('classes', 'cohorts', 'enrolments')
    AND grantee = 'anon';
  IF n <> 0 THEN
    RAISE EXCEPTION 'anon holds % grants on the new tables; it should hold none', n;
  END IF;

  -- ==========================================================================
  -- Clean up
  -- ==========================================================================
  DELETE FROM public.classes WHERE code LIKE 'ASSERT-001%';

  SELECT count(*) INTO n FROM public.classes WHERE code LIKE 'ASSERT-001%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'assertion rows were left behind';
  END IF;

  RAISE NOTICE '001 assertions passed';
END
$assert$;
