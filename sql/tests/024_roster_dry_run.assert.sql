-- ============================================================================
-- Migration 023 — the preview is the write, asked not to write
--
-- One assertion carries this file: run the dry run, run the real thing on the
-- same input, and require the two answers to be identical apart from the flag
-- that says which was which. Everything else here supports that claim — that
-- nothing was written, that permission is still required, that the numbers are
-- right rather than merely equal to each other.
--
-- Equality alone would pass if both were wrong in the same way, so the counts
-- are also checked against reality before the comparison is made.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $assert$
DECLARE
  v_class    uuid;
  v_a        uuid;
  v_b        uuid;
  v_dry      jsonb;
  v_real     jsonb;
  v_rows     jsonb;
  n_students bigint;
  n_enrol    bigint;
  n_after    bigint;
  failed     boolean;
BEGIN
  v_class := (public.create_class('ASSERT-024', 'Preview Class',
                DATE '2026-05-18', DATE '2026-05-28',
                'Africa/Accra', NULL, ARRAY['A','B']) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  -- Somebody already in cohort B of this class, so in_other_cohort is exercised
  -- rather than left empty.
  PERFORM public.upsert_enrolments(v_b,
    '[{"student_id": "DRY-B", "name": "In Cohort B"}]'::jsonb);

  -- A mixed file: one the registry knows, two it does not, one already in
  -- another cohort, one blank, one duplicate.
  v_rows := '[
    {"student_id": "S001",  "name": "Should Not Overwrite"},
    {"student_id": "DRY-1", "name": "Brand New"},
    {"student_id": "DRY-2", "name": null},
    {"student_id": "DRY-B", "name": "In Cohort B"},
    {"student_id": "   ",   "name": "Blank"},
    {"student_id": "DRY-1", "name": "Duplicate row"}
  ]'::jsonb;

  SELECT count(*) INTO n_students FROM public.students;
  SELECT count(*) INTO n_enrol    FROM public.enrolments;

  -- ==========================================================================
  -- The dry run writes nothing at all
  -- ==========================================================================
  v_dry := public.upsert_enrolments(v_a, v_rows, false, true);

  IF NOT (v_dry ->> 'dry_run')::boolean THEN
    RAISE EXCEPTION 'a dry run did not say it was one: %', v_dry;
  END IF;

  SELECT count(*) INTO n_after FROM public.students;
  IF n_after <> n_students THEN
    RAISE EXCEPTION 'a dry run created % student row(s)', n_after - n_students;
  END IF;

  SELECT count(*) INTO n_after FROM public.enrolments;
  IF n_after <> n_enrol THEN
    RAISE EXCEPTION 'a dry run created % enrolment(s)', n_after - n_enrol;
  END IF;

  -- ==========================================================================
  -- And the numbers it reports are true, not merely self-consistent
  -- ==========================================================================

  -- S001 is in the fixture, DRY-B was just created; DRY-1 and DRY-2 are new.
  IF (v_dry ->> 'reused_students')::int <> 2 THEN
    RAISE EXCEPTION 'expected 2 reused, got %: %', v_dry ->> 'reused_students', v_dry;
  END IF;
  IF (v_dry ->> 'created_students')::int <> 2 THEN
    RAISE EXCEPTION 'expected 2 created, got %: %', v_dry ->> 'created_students', v_dry;
  END IF;

  -- S001, DRY-1, DRY-2 can be enrolled here. DRY-B cannot: they hold this
  -- class's one enrolment already, in cohort B.
  IF (v_dry ->> 'enrolled')::int <> 3 THEN
    RAISE EXCEPTION 'expected 3 enrolable, got %: %', v_dry ->> 'enrolled', v_dry;
  END IF;

  IF NOT (v_dry -> 'in_other_cohort')::text LIKE '%DRY-B%' THEN
    RAISE EXCEPTION 'the student in cohort B was not reported: %', v_dry;
  END IF;

  -- The blank row and the duplicate, both named with their row numbers.
  IF jsonb_array_length(v_dry -> 'invalid') <> 2 THEN
    RAISE EXCEPTION 'expected 2 invalid rows, got %', v_dry -> 'invalid';
  END IF;

  -- ==========================================================================
  -- THE POINT: the real call reports exactly what the preview promised
  -- ==========================================================================
  v_real := public.upsert_enrolments(v_a, v_rows, false, false);

  IF (v_real ->> 'dry_run')::boolean THEN
    RAISE EXCEPTION 'the real call claimed to be a dry run: %', v_real;
  END IF;

  IF (v_dry - 'dry_run') <> (v_real - 'dry_run') THEN
    RAISE EXCEPTION
      'the preview and the write disagree. preview: % actual: %',
      v_dry, v_real;
  END IF;

  -- And the write did happen.
  SELECT count(*) INTO n_after FROM public.enrolments WHERE cohort_id = v_a;
  IF n_after <> 3 THEN
    RAISE EXCEPTION 'expected 3 enrolments in cohort A, got %', n_after;
  END IF;

  -- ==========================================================================
  -- The same agreement when the file is applied a second time
  --
  -- Everything is already there, so both answers should be zeroes -- the case
  -- where a wrong preview would be least likely to be noticed.
  -- ==========================================================================
  v_dry  := public.upsert_enrolments(v_a, v_rows, false, true);
  v_real := public.upsert_enrolments(v_a, v_rows, false, false);

  IF (v_dry - 'dry_run') <> (v_real - 'dry_run') THEN
    RAISE EXCEPTION
      're-uploading: preview and write disagree. preview % actual %',
      v_dry, v_real;
  END IF;

  IF (v_real ->> 'enrolled')::int <> 0
     OR (v_real ->> 'already_enrolled')::int <> 3 THEN
    RAISE EXCEPTION 're-uploading was not a no-op: %', v_real;
  END IF;

  -- ==========================================================================
  -- Agreement when the move is asked for too
  -- ==========================================================================
  v_dry  := public.upsert_enrolments(v_a, v_rows, true, true);
  v_real := public.upsert_enrolments(v_a, v_rows, true, false);

  IF (v_dry - 'dry_run') <> (v_real - 'dry_run') THEN
    RAISE EXCEPTION
      'with p_move_existing: preview and write disagree. preview % actual %',
      v_dry, v_real;
  END IF;

  IF (v_real ->> 'moved')::int <> 1 THEN
    RAISE EXCEPTION 'expected DRY-B to move, got %', v_real;
  END IF;

  SELECT count(*) INTO n_after FROM public.enrolments WHERE cohort_id = v_b;
  IF n_after <> 0 THEN
    RAISE EXCEPTION 'DRY-B was reported moved but cohort B still has %', n_after;
  END IF;

  -- ==========================================================================
  -- A dry run is not a way to read a roster you may not touch
  -- ==========================================================================
  CREATE TEMP TABLE t024 ON COMMIT DROP AS SELECT v_a AS cohort_id;
END
$assert$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $outsider$
DECLARE
  v_a    uuid := (SELECT cohort_id FROM t024);
  failed boolean := false;
BEGIN
  BEGIN
    PERFORM public.upsert_enrolments(v_a, '[]'::jsonb, false, true);
  EXCEPTION WHEN others THEN failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      'somebody who cannot manage the class ran a dry run against it — that '
      'reports how many of a list of IDs are already enrolled, which is the '
      'roster answered one guess at a time';
  END IF;
END
$outsider$;

DO $done$ BEGIN RAISE NOTICE '024 roster dry-run assertions passed'; END $done$;

ROLLBACK;
