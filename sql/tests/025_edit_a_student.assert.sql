-- ============================================================================
-- Migration 024 — renaming a student, and who may
--
-- students is a global registry, so a rename reaches every class the person
-- takes. The assertion that matters is therefore the negative one: a TA who
-- does not teach somebody cannot rename them, even though the row is perfectly
-- visible to the application.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $mine$
DECLARE
  v_class uuid;
  v_a     uuid;
  r       jsonb;
  t       text;
  failed  boolean;
BEGIN
  v_class := (public.create_class('ASSERT-025', 'Rename Class',
                DATE '2026-05-18', DATE '2026-05-28') ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_a, '[
    {"student_id": "REN-1", "name": "Misspelt Nmae"},
    {"student_id": "REN-2", "name": null}
  ]'::jsonb);

  -- The ordinary case: a correction.
  r := public.update_student('REN-1', 'Corrected Name');
  IF r ->> 'name' <> 'Corrected Name' THEN
    RAISE EXCEPTION 'the rename did not take: %', r;
  END IF;

  SELECT name INTO t FROM public.students WHERE student_id = 'REN-1';
  IF t <> 'Corrected Name' THEN
    RAISE EXCEPTION 'the row still reads %', COALESCE(t, '(null)');
  END IF;

  -- A student who arrived with no name at all, which is what an export
  -- without a name column produces.
  PERFORM public.update_student('REN-2', '  Filled In  ');
  SELECT name INTO t FROM public.students WHERE student_id = 'REN-2';
  IF t <> 'Filled In' THEN
    RAISE EXCEPTION 'a blank name was not filled in and trimmed, is %',
      COALESCE(t, '(null)');
  END IF;

  -- Emptying it is allowed, and stores null rather than ''. A name that is
  -- merely invisible is worse to work with than one that is honestly absent.
  PERFORM public.update_student('REN-2', '   ');
  SELECT name INTO t FROM public.students WHERE student_id = 'REN-2';
  IF t IS NOT NULL THEN
    RAISE EXCEPTION 'clearing a name stored % rather than null', quote_literal(t);
  END IF;

  -- An ID that does not exist is refused rather than silently doing nothing.
  failed := false;
  BEGIN PERFORM public.update_student('NO-SUCH-STUDENT', 'Someone');
  EXCEPTION WHEN others THEN failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'renaming a student who does not exist succeeded';
  END IF;

  CREATE TEMP TABLE t025 ON COMMIT DROP AS SELECT v_class AS class_id;
END
$mine$;

-- ----------------------------------------------------------------------------
-- THE POINT: a TA who does not teach this student cannot rename them
--
-- The registry is global and the row is readable. Without this check any TA
-- could rename anybody in the institution, and the change would follow that
-- student into every other course.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $theirs$
DECLARE
  failed boolean := false;
  t      text;
BEGIN
  BEGIN
    PERFORM public.update_student('REN-1', 'Renamed By A Stranger');
  EXCEPTION WHEN others THEN failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      'a TA renamed a student they do not teach — students is a global '
      'registry, so that would follow the student into every other class';
  END IF;

  SELECT name INTO t FROM public.students WHERE student_id = 'REN-1';
  IF t IS DISTINCT FROM 'Corrected Name' THEN
    RAISE EXCEPTION 'the name changed anyway, to %', COALESCE(t, '(null)');
  END IF;
END
$theirs$;

-- ----------------------------------------------------------------------------
-- Being added to the class is what grants it, not anything about admin
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $grant$
DECLARE v_class uuid := (SELECT class_id FROM t025);
BEGIN
  PERFORM public.add_class_member(v_class, 'ta.two@example.edu');
END
$grant$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $now_allowed$
DECLARE t text;
BEGIN
  PERFORM public.update_student('REN-1', 'Renamed By A Colleague');

  SELECT name INTO t FROM public.students WHERE student_id = 'REN-1';
  IF t <> 'Renamed By A Colleague' THEN
    RAISE EXCEPTION
      'a TA on the class could not rename its student, name is %',
      COALESCE(t, '(null)');
  END IF;
END
$now_allowed$;

DO $done$ BEGIN RAISE NOTICE '025 student-rename assertions passed'; END $done$;

ROLLBACK;
