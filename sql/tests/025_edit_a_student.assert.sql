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

-- ----------------------------------------------------------------------------
-- Correcting a mistyped ID carries the person's history with them
--
-- The reason this exists: a wrong ID on the roster is silent. The student
-- types their real one, nothing matches, and they are marked absent all term
-- while looking perfectly enrolled. Fixing it must not orphan what they
-- already have — they are not a new person.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $reid$
DECLARE
  v_class   uuid := (SELECT class_id FROM t025);
  v_cohort  uuid;
  v_session uuid;
  r         jsonb;
  n         bigint;
  failed    boolean;
BEGIN
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  -- Give REN-1 some history to carry.
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM DATE '2026-05-20')::int)::jsonb);

  PERFORM public.generate_sessions(v_class, NULL,
                                   DATE '2026-05-20', DATE '2026-05-20');

  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
  ORDER BY session_date DESC LIMIT 1;

  IF v_session IS NULL THEN
    RAISE EXCEPTION 'fixture: no session was generated';
  END IF;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_session, v_class, 'REN-1', 'present', now(), 'staff');

  SELECT count(*) INTO n
  FROM public.attendance_records WHERE student_id = 'REN-1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'fixture: expected 1 attendance record, got %', n;
  END IF;

  r := public.change_student_id('REN-1', 'REN-1-FIXED');

  IF r ->> 'student_id' <> 'REN-1-FIXED' THEN
    RAISE EXCEPTION 'the id did not change: %', r;
  END IF;
  IF (r ->> 'attendance_records')::int <> 1 THEN
    RAISE EXCEPTION 'the report did not mention the record that moved: %', r;
  END IF;

  -- The old ID is gone entirely.
  IF EXISTS (SELECT 1 FROM public.students WHERE student_id = 'REN-1') THEN
    RAISE EXCEPTION 'the old student row survived the change';
  END IF;

  -- And the history came along rather than being orphaned or deleted.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE student_id = 'REN-1-FIXED';
  IF n <> 1 THEN
    RAISE EXCEPTION
      'attendance did not follow the corrected ID — % record(s) under the new '
      'id. ON DELETE CASCADE without ON UPDATE CASCADE deletes history instead '
      'of moving it', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.enrolments WHERE student_id = 'REN-1-FIXED';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the enrolment did not follow the corrected ID';
  END IF;

  -- The name is untouched by an ID change.
  IF (SELECT name FROM public.students WHERE student_id = 'REN-1-FIXED')
     IS DISTINCT FROM 'Renamed By A Colleague' THEN
    RAISE EXCEPTION 'changing the id disturbed the name';
  END IF;

  -- An ID somebody else holds is a merge, and is refused.
  failed := false;
  BEGIN PERFORM public.change_student_id('REN-1-FIXED', 'REN-2');
  EXCEPTION WHEN others THEN failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION
      'a student was given an ID another student already held — that silently '
      'merges two people''s attendance';
  END IF;

  -- Both survived the refusal intact.
  SELECT count(*) INTO n
  FROM public.students WHERE student_id IN ('REN-1-FIXED', 'REN-2');
  IF n <> 2 THEN
    RAISE EXCEPTION 'the refused merge damaged one of the two rows';
  END IF;
END
$reid$;

-- A TA who does not teach them cannot re-ID them either.
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

DO $stranger$
DECLARE failed boolean := false;
BEGIN
  BEGIN PERFORM public.change_student_id('REN-1-FIXED', 'STOLEN');
  EXCEPTION WHEN others THEN failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION 'a TA changed the ID of a student they do not teach';
  END IF;
END
$stranger$;

DO $done$ BEGIN RAISE NOTICE '025 student-edit assertions passed'; END $done$;

ROLLBACK;
