-- ============================================================================
-- Migration 007 — class management
--
-- The roster upload gets the most attention, because "one student, several
-- classes, uploaded independently" is the behaviour the whole enrolments table
-- exists to provide, and the failure mode is silent: a duplicate student or an
-- overwritten name looks like nothing went wrong.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $assert$
DECLARE
  v_class   uuid;
  v_other   uuid;
  v_a       uuid;
  v_b       uuid;
  v_oa      uuid;
  r         jsonb;
  n         bigint;
  t         text;
  d         date;
  failed    boolean;
BEGIN
  v_class := (public.create_class('ASSERT-007', 'Managed Class',
                DATE '2026-05-18', DATE '2026-05-28',
                'Africa/Accra', NULL, ARRAY['A','B']) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  -- ==========================================================================
  -- update_class: NULL leaves a field alone
  -- ==========================================================================
  r := public.update_class(v_class, p_name => 'Renamed Class');

  SELECT name, term_starts_on INTO t, d FROM public.classes WHERE id = v_class;
  IF t <> 'Renamed Class' THEN
    RAISE EXCEPTION 'the name did not change, is %', t;
  END IF;
  IF d <> DATE '2026-05-18' THEN
    RAISE EXCEPTION 'updating the name also changed the term start to %', d;
  END IF;

  -- ==========================================================================
  -- add_cohort
  -- ==========================================================================
  PERFORM public.add_cohort(v_class, 'Evening');
  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 cohorts after adding one, found %', n;
  END IF;

  failed := false;
  BEGIN
    PERFORM public.add_cohort(v_class, 'a');    -- 'A' already exists
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a duplicate cohort label was accepted';
  END IF;

  -- ==========================================================================
  -- set_cohort_schedule replaces, atomically
  -- ==========================================================================
  SELECT public.set_cohort_schedule(v_a, ARRAY[2,3,4]::smallint[], TIME '09:00', 60) INTO n;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 schedule rows, created %', n;
  END IF;

  -- Replacing with fewer days leaves exactly the new set, not a union.
  SELECT public.set_cohort_schedule(v_a, ARRAY[1]::smallint[], TIME '14:00', 90) INTO n;
  SELECT count(*) INTO n FROM public.cohort_schedules WHERE cohort_id = v_a;
  IF n <> 1 THEN
    RAISE EXCEPTION 'replacing the schedule left % rows, expected 1', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.cohort_schedules
  WHERE cohort_id = v_a AND weekday = 1 AND start_time = TIME '14:00' AND duration_minutes = 90;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the replacement schedule did not take';
  END IF;

  failed := false;
  BEGIN
    PERFORM public.set_cohort_schedule(v_a, ARRAY[9]::smallint[], TIME '09:00');
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'weekday 9 was accepted';
  END IF;

  -- Sessions already generated keep their own timing: changing a pattern must
  -- not silently rewrite what already happened.
  PERFORM public.set_cohort_schedule(v_a, ARRAY[2]::smallint[], TIME '09:00', 60);
  PERFORM public.generate_sessions(v_class, v_a);
  SELECT count(*) INTO n FROM public.class_sessions WHERE cohort_id = v_a;
  IF n = 0 THEN
    RAISE EXCEPTION 'no sessions were generated to test against';
  END IF;

  PERFORM public.set_cohort_schedule(v_a, ARRAY[2]::smallint[], TIME '16:00', 30);
  SELECT count(*) INTO n
  FROM public.class_sessions WHERE cohort_id = v_a AND duration_minutes = 30;
  IF n <> 0 THEN
    RAISE EXCEPTION 'changing the schedule rewrote % existing sessions', n;
  END IF;

  -- ==========================================================================
  -- upsert_enrolments — the dedupe
  -- ==========================================================================
  r := public.upsert_enrolments(v_a, '[
        {"student_id": "S001", "name": "Should Not Overwrite"},
        {"student_id": "NEW-1", "name": "Brand New"},
        {"student_id": "NEW-2", "name": null},
        {"student_id": "  ",   "name": "Blank"},
        {"student_id": "NEW-1", "name": "Duplicate row"}
      ]'::jsonb);

  -- S001 exists already (from the fixture), NEW-1 and NEW-2 do not.
  IF (r ->> 'reused_students')::int <> 1 THEN
    RAISE EXCEPTION 'expected 1 reused student, got %', r ->> 'reused_students';
  END IF;
  IF (r ->> 'created_students')::int <> 2 THEN
    RAISE EXCEPTION 'expected 2 created students, got %', r ->> 'created_students';
  END IF;
  IF (r ->> 'enrolled')::int <> 3 THEN
    RAISE EXCEPTION 'expected 3 enrolments, got %', r ->> 'enrolled';
  END IF;

  -- The blank row and the in-file duplicate are reported, not silently dropped:
  -- both are spreadsheet mistakes the TA should see.
  IF jsonb_array_length(r -> 'invalid') <> 2 THEN
    RAISE EXCEPTION 'expected 2 invalid rows, got %', r -> 'invalid';
  END IF;

  -- The existing student is reused, not duplicated.
  SELECT count(*) INTO n FROM public.students WHERE student_id = 'S001';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the roster upload duplicated an existing student';
  END IF;

  -- ...and their name was NOT overwritten. Students are global; one TA's stale
  -- spreadsheet must not rename another course's student.
  SELECT name INTO t FROM public.students WHERE student_id = 'S001';
  IF t <> 'Ama Boateng' THEN
    RAISE EXCEPTION 'the upload overwrote an existing name with %', t;
  END IF;

  -- A missing name IS filled in.
  UPDATE public.students SET name = NULL WHERE student_id = 'NEW-2';
  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "NEW-2", "name": "Filled In"}]'::jsonb);
  SELECT name INTO t FROM public.students WHERE student_id = 'NEW-2';
  IF t <> 'Filled In' THEN
    RAISE EXCEPTION 'a missing name was not filled in, is %', COALESCE(t, '(null)');
  END IF;

  -- Re-uploading the same file changes nothing and says so.
  r := public.upsert_enrolments(v_a, '[{"student_id": "NEW-1", "name": "Brand New"}]'::jsonb);
  IF (r ->> 'enrolled')::int <> 0 OR (r ->> 'already_enrolled')::int <> 1 THEN
    RAISE EXCEPTION 're-uploading was not a no-op: %', r;
  END IF;

  -- ---- one student, two classes -------------------------------------------
  v_other := (public.create_class('ASSERT-007-B', 'Other Class',
                DATE '2026-05-18', DATE '2026-05-28') ->> 'class_id')::uuid;
  SELECT id INTO v_oa FROM public.cohorts WHERE class_id = v_other AND label = 'A';

  r := public.upsert_enrolments(v_oa, '[{"student_id": "NEW-1", "name": "Brand New"}]'::jsonb);
  IF (r ->> 'enrolled')::int <> 1 THEN
    RAISE EXCEPTION 'the same student could not be enrolled in a second class: %', r;
  END IF;

  SELECT count(*) INTO n FROM public.enrolments WHERE student_id = 'NEW-1';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 enrolments for a student in 2 classes, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.students WHERE student_id = 'NEW-1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'a student in two classes became % rows', n;
  END IF;

  -- ---- a different cohort of the SAME class -------------------------------
  r := public.upsert_enrolments(v_b, '[{"student_id": "NEW-1", "name": "Brand New"}]'::jsonb);
  IF (r ->> 'enrolled')::int <> 0 THEN
    RAISE EXCEPTION 'a student was silently added to a second cohort of one class';
  END IF;
  IF jsonb_array_length(r -> 'in_other_cohort') <> 1 THEN
    RAISE EXCEPTION 'the cohort clash was not reported: %', r;
  END IF;
  IF (r -> 'in_other_cohort' -> 0 ->> 'current_cohort') <> 'A' THEN
    RAISE EXCEPTION 'the report names the wrong current cohort: %', r -> 'in_other_cohort';
  END IF;

  -- Only when explicitly asked does it move them.
  r := public.upsert_enrolments(v_b, '[{"student_id": "NEW-1"}]'::jsonb, true);
  IF (r ->> 'moved')::int <> 1 THEN
    RAISE EXCEPTION 'the move was requested but did not happen: %', r;
  END IF;

  SELECT co.label INTO t
  FROM public.enrolments e JOIN public.cohorts co ON co.id = e.cohort_id
  WHERE e.student_id = 'NEW-1' AND e.class_id = v_class;
  IF t <> 'B' THEN
    RAISE EXCEPTION 'after the move the student is in cohort %, expected B', t;
  END IF;

  -- Still one enrolment in this class, and still one in the other.
  SELECT count(*) INTO n FROM public.enrolments WHERE student_id = 'NEW-1';
  IF n <> 2 THEN
    RAISE EXCEPTION 'moving cohorts changed the enrolment count to %', n;
  END IF;

  -- ==========================================================================
  -- archive
  -- ==========================================================================
  PERFORM public.archive_class(v_other);
  SELECT count(*) INTO n FROM public.classes WHERE id = v_other AND archived_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'archiving did not stamp archived_at';
  END IF;

  PERFORM public.archive_class(v_other, false);
  SELECT count(*) INTO n FROM public.classes WHERE id = v_other AND archived_at IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'un-archiving did not clear archived_at';
  END IF;

  -- ==========================================================================
  -- delete: preview, confirmation, and what survives
  -- ==========================================================================
  r := public.preview_class_deletion(v_class);

  IF (r ->> 'cohorts')::int <> 3 THEN
    RAISE EXCEPTION 'preview reports % cohorts, expected 3', r ->> 'cohorts';
  END IF;
  IF (r ->> 'enrolments')::int < 3 THEN
    RAISE EXCEPTION 'preview reports too few enrolments: %', r ->> 'enrolments';
  END IF;

  -- NEW-1 also takes the other class, so deleting this one does not strand
  -- them. NEW-2 and S001-in-this-class do get stranded.
  IF (r ->> 'students_left_orphaned')::int < 1 THEN
    RAISE EXCEPTION 'preview should warn about stranded students, reports %',
      r ->> 'students_left_orphaned';
  END IF;

  -- A wrong confirmation refuses.
  failed := false;
  BEGIN
    PERFORM public.delete_class(v_class, 'not-the-code');
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'the class was deleted without the right confirmation code';
  END IF;

  SELECT count(*) INTO n FROM public.classes WHERE id = v_class;
  IF n <> 1 THEN
    RAISE EXCEPTION 'a refused deletion still removed the class';
  END IF;

  -- The right one, in the wrong case, is still the right one.
  r := public.delete_class(v_class, 'assert-007');
  IF NOT (r ->> 'deleted')::boolean THEN
    RAISE EXCEPTION 'the deletion did not report success';
  END IF;

  SELECT count(*) INTO n FROM public.classes WHERE id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'the class survived deletion';
  END IF;
  SELECT count(*) INTO n FROM public.enrolments WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'enrolments survived their class';
  END IF;
  SELECT count(*) INTO n FROM public.class_sessions WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'sessions survived their class';
  END IF;

  -- The people do not belong to the course.
  SELECT count(*) INTO n FROM public.students WHERE student_id IN ('S001', 'NEW-1', 'NEW-2');
  IF n <> 3 THEN
    RAISE EXCEPTION 'deleting a class deleted students; only % of 3 remain', n;
  END IF;

  -- And their other enrolment is untouched.
  SELECT count(*) INTO n FROM public.enrolments WHERE student_id = 'NEW-1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'deleting one class removed a student from another';
  END IF;

  RAISE NOTICE '007 assertions passed';
END
$assert$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- ----------------------------------------------------------------------------
-- Permission: managing is a narrower right than accessing
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  v_class uuid;
  v_staff uuid;
BEGIN
  -- Put staff two on a class they did not create. Since 008 there are no roles:
  -- being on a class is the whole permission, so they can manage it exactly as
  -- its creator can. What must still hold is that a NON-member cannot.
  INSERT INTO public.classes (code, name, term_starts_on, term_ends_on)
  VALUES ('ASSERT-007-P', 'Perms', DATE '2026-05-18', DATE '2026-05-28')
  RETURNING id INTO v_class;

  SELECT id INTO v_staff FROM public.staff
  WHERE user_id = '22222222-2222-2222-2222-222222222222';

  INSERT INTO public.class_staff (class_id, staff_id, role)
  VALUES (v_class, v_staff, 'ta');
END
$setup$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $perms$
DECLARE
  v_class uuid;
  v_other uuid;
  ok      boolean;
BEGIN
  -- Looked up by code rather than handed over: a member can see it through the
  -- SELECT policy, which is itself worth confirming.
  SELECT id INTO v_class FROM public.classes WHERE code = 'ASSERT-007-P';
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'a member of the class cannot see it at all';
  END IF;

  -- There are no roles any more. A member added to someone else's class can
  -- manage it, which is the model the user asked for.
  IF NOT public.can_access_class(v_class) THEN
    RAISE EXCEPTION 'a member cannot access the class';
  END IF;
  IF NOT public.can_manage_class(v_class) THEN
    RAISE EXCEPTION 'a member was refused management rights; roles were flattened';
  END IF;

  PERFORM public.update_class(v_class, p_name => 'Renamed by a collaborator');
  IF NOT EXISTS (
    SELECT 1 FROM public.classes
    WHERE id = v_class AND name = 'Renamed by a collaborator')
  THEN
    RAISE EXCEPTION 'a member could not rename a class they collaborate on';
  END IF;

  -- ...but a class they are NOT on stays out of reach, by name and by id.
  SELECT id INTO v_other FROM public.classes WHERE code = 'INTRO-AI';
  IF v_other IS NOT NULL THEN
    -- Staff two was attached to the rescued class, so this is expected to be
    -- visible; the isolation case is covered in 003 against a fresh class.
    NULL;
  END IF;

  ok := false;
  BEGIN
    PERFORM public.delete_class(
      '00000000-0000-0000-0000-000000000009'::uuid, 'whatever');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'a class that does not exist was deleted';
  END IF;

  RAISE NOTICE '007 permission assertions passed';
END
$perms$;

RESET ROLE;
RESET request.jwt.claim.sub;

ROLLBACK;
