-- ============================================================================
-- Migration 012 — a class deletion takes its exclusive students, and no others
--
-- The dangerous half is the "and no others". Deleting a shared student would
-- destroy another TA's roster and their attendance history from a screen that
-- never mentioned that class, so the assertions lean on the shared case.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- ----------------------------------------------------------------------------
-- Two classes. ONLY-1 has a student to itself; SHARED-2 shares one with it.
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  v_doomed uuid;
  v_keeper uuid;
  v_dc     uuid;
  v_kc     uuid;
BEGIN
  v_doomed := (public.create_class('ASSERT-012-A', 'Doomed',
                 CURRENT_DATE - 10, CURRENT_DATE + 40) ->> 'class_id')::uuid;
  v_keeper := (public.create_class('ASSERT-012-B', 'Keeper',
                 CURRENT_DATE - 10, CURRENT_DATE + 40) ->> 'class_id')::uuid;

  SELECT id INTO v_dc FROM public.cohorts WHERE class_id = v_doomed;
  SELECT id INTO v_kc FROM public.cohorts WHERE class_id = v_keeper;

  -- solo: only in the doomed class.
  -- shared: in both.
  -- dropped: in the doomed class, and dropped from the keeper.
  PERFORM public.upsert_enrolments(v_dc, '[
    {"student_id": "A012-SOLO",    "name": "Solo Only"},
    {"student_id": "A012-SHARED",  "name": "Shared Two"},
    {"student_id": "A012-DROPPED", "name": "Dropped Elsewhere"}]'::jsonb);

  PERFORM public.upsert_enrolments(v_kc, '[
    {"student_id": "A012-SHARED",  "name": "Shared Two"},
    {"student_id": "A012-DROPPED", "name": "Dropped Elsewhere"}]'::jsonb);

  -- Backdate the enrolment too: dropped_on cannot precede enrolled_on, and
  -- upsert_enrolments starts everyone today.
  UPDATE public.enrolments
     SET enrolled_on = CURRENT_DATE - 5,
         dropped_on  = CURRENT_DATE - 1
   WHERE class_id = v_keeper AND student_id = 'A012-DROPPED';

  -- Legacy rows with no foreign key to students: nothing cascades into these.
  INSERT INTO public.present_students (student_id, cohort, timestamp) VALUES
    ('A012-SOLO',   'A', now()),
    ('A012-SHARED', 'A', now());
  INSERT INTO public.flagged (student_id, session_date, status) VALUES
    ('A012-SOLO',   CURRENT_DATE, 'flagged'),
    ('A012-SHARED', CURRENT_DATE, 'flagged');

  CREATE TEMP TABLE t012 ON COMMIT DROP AS
  SELECT v_doomed AS doomed, v_keeper AS keeper;
END
$setup$;

-- ----------------------------------------------------------------------------
-- The preview counts exactly the one student nobody else has
-- ----------------------------------------------------------------------------

DO $preview$
DECLARE
  v_preview jsonb;
BEGIN
  v_preview := public.preview_class_deletion((SELECT doomed FROM t012));

  IF (v_preview ->> 'students_also_deleted')::int <> 1 THEN
    RAISE EXCEPTION
      'preview said % students would be deleted, expected 1 (only A012-SOLO): %',
      v_preview ->> 'students_also_deleted', v_preview;
  END IF;

  IF (v_preview ->> 'enrolments')::int <> 3 THEN
    RAISE EXCEPTION 'preview miscounted enrolments: %', v_preview;
  END IF;
END
$preview$;

-- ----------------------------------------------------------------------------
-- Deleting it removes the solo student and keeps the other two
-- ----------------------------------------------------------------------------

DO $delete$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.delete_class((SELECT doomed FROM t012), 'ASSERT-012-A');

  IF (v_result ->> 'students_deleted')::int <> 1 THEN
    RAISE EXCEPTION
      'delete_class removed % students, expected 1: %',
      v_result ->> 'students_deleted', v_result;
  END IF;

  IF EXISTS (SELECT 1 FROM public.students WHERE student_id = 'A012-SOLO') THEN
    RAISE EXCEPTION 'the student with no other class survived';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'A012-SHARED') THEN
    RAISE EXCEPTION 'a student enrolled in another class was deleted';
  END IF;

  -- A dropped enrolment elsewhere is still a claim: they have history there.
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'A012-DROPPED') THEN
    RAISE EXCEPTION
      'a student whose only other enrolment was dropped was deleted; their history in that class is now orphaned';
  END IF;

  -- The shared student keeps their enrolment in the surviving class.
  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments
    WHERE student_id = 'A012-SHARED' AND class_id = (SELECT keeper FROM t012)
  ) THEN
    RAISE EXCEPTION 'the shared student lost their enrolment in the other class';
  END IF;
END
$delete$;

-- ----------------------------------------------------------------------------
-- The legacy tables that have no foreign key were cleared by hand
-- ----------------------------------------------------------------------------

DO $legacy$
BEGIN
  IF EXISTS (SELECT 1 FROM public.present_students WHERE student_id = 'A012-SOLO') THEN
    RAISE EXCEPTION
      'present_students still holds check-ins for a deleted student — no FK cascades there';
  END IF;

  IF EXISTS (SELECT 1 FROM public.flagged WHERE student_id = 'A012-SOLO') THEN
    RAISE EXCEPTION
      'flagged still holds rows for a deleted student — no FK cascades there';
  END IF;

  -- And the surviving student's legacy rows were NOT collateral damage.
  IF NOT EXISTS (SELECT 1 FROM public.present_students WHERE student_id = 'A012-SHARED') THEN
    RAISE EXCEPTION 'a surviving student lost their check-ins';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.flagged WHERE student_id = 'A012-SHARED') THEN
    RAISE EXCEPTION 'a surviving student lost their flags';
  END IF;
END
$legacy$;

-- ----------------------------------------------------------------------------
-- Opting out keeps everybody
-- ----------------------------------------------------------------------------

DO $opt_out$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  v_result jsonb;
BEGIN
  v_class := (public.create_class('ASSERT-012-C', 'Keep them',
                CURRENT_DATE - 10, CURRENT_DATE + 40) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.upsert_enrolments(
    v_cohort, '[{"student_id": "A012-KEPT", "name": "Kept"}]'::jsonb);

  v_result := public.delete_class(v_class, 'ASSERT-012-C', false);

  IF (v_result ->> 'students_deleted')::int <> 0 THEN
    RAISE EXCEPTION 'delete_class deleted students despite being told not to: %', v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'A012-KEPT') THEN
    RAISE EXCEPTION 'the student was deleted despite p_delete_orphaned_students = false';
  END IF;
END
$opt_out$;

-- ----------------------------------------------------------------------------
-- A wrong confirmation code still deletes nothing at all
-- ----------------------------------------------------------------------------

DO $confirm$
DECLARE
  v_keeper uuid := (SELECT keeper FROM t012);
  v_msg    text;
BEGIN
  BEGIN
    PERFORM public.delete_class(v_keeper, 'not-the-code');
    RAISE EXCEPTION 'delete_class accepted a wrong confirmation code';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg = 'delete_class accepted a wrong confirmation code' THEN
      RAISE;
    END IF;
  END;

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = v_keeper) THEN
    RAISE EXCEPTION 'the class was deleted despite the wrong code';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = 'A012-SHARED') THEN
    RAISE EXCEPTION 'a student was deleted despite the wrong code';
  END IF;
END
$confirm$;

DO $done$ BEGIN RAISE NOTICE '012 orphaned-student assertions passed'; END $done$;

ROLLBACK;
