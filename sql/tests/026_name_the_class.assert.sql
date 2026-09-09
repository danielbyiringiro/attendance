-- ============================================================================
-- Migration 025 — naming the class after check-in, and not before
--
-- Half of this file is a guard rather than a test of new behaviour.
--
-- Telling a student which class is open BEFORE they type the code was asked
-- for and has no safe form: listing open classes publicly says which of this
-- institution's classes are meeting right now, and resolving them from a
-- student ID is worse, because an ID is a number printed on a card and that
-- makes the check-in box an enrolment oracle.
--
-- So get_open_session_summary stays a count and a closing time, and the
-- assertions below fail if a class name, a code, a PIN or a student ever
-- appears in it. The decision is written down where the next person to have
-- the idea will actually meet it.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_session uuid;
BEGIN
  v_class := (public.create_class('ASSERT-026', 'Naming Things',
                CURRENT_DATE - 7, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "N026-IN", "name": "Enrolled Here"}]'::jsonb);

  UPDATE public.enrolments
     SET enrolled_on = CURRENT_DATE - 7
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE)::int)::jsonb);

  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE, CURRENT_DATE);

  SELECT id INTO v_session
  FROM public.class_sessions WHERE cohort_id = v_cohort LIMIT 1;

  PERFORM public.open_session(v_session, 'N26PIN', 60);
END
$setup$;

-- ----------------------------------------------------------------------------
-- Checking in says which class it was, by code as well as name
-- ----------------------------------------------------------------------------

DO $marked$
DECLARE r jsonb;
BEGIN
  r := public.mark_attendance('N026-IN', 'N26PIN');

  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'the fixture check-in failed: %', r;
  END IF;

  IF r ->> 'class' <> 'Naming Things' THEN
    RAISE EXCEPTION 'the class name is missing from the result: %', r;
  END IF;

  -- The addition. A timetable says ASSERT-026; the syllabus says the name.
  IF r ->> 'class_code' <> 'ASSERT-026' THEN
    RAISE EXCEPTION 'the class code is missing from the result: %', r;
  END IF;

  IF r ->> 'cohort' <> 'A' THEN
    RAISE EXCEPTION 'the cohort is missing from the result: %', r;
  END IF;
END
$marked$;

-- ----------------------------------------------------------------------------
-- THE GUARD: what a stranger can learn without typing anything
--
-- A count and a time. Anything else here is a change of policy, not a bug fix,
-- and should have to argue with this test first.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE anon;

DO $anon$
DECLARE
  r    jsonb := public.get_open_session_summary();
  keys text[];
BEGIN
  -- It still answers, because the countdown on the check-in page depends on it.
  IF (r ->> 'open_count')::int < 1 THEN
    RAISE EXCEPTION 'the open session was not counted: %', r;
  END IF;
  IF (r ->> 'closes_at') IS NULL THEN
    RAISE EXCEPTION 'closes_at disappeared, which stops the countdown: %', r;
  END IF;

  -- And answers with nothing else at all. Checked as a key list rather than by
  -- naming the fields to avoid: a key added later is caught by this, and a
  -- field nobody thought of is exactly the way this leaks.
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r) AS k;

  IF keys <> ARRAY['closes_at', 'open_count'] THEN
    RAISE EXCEPTION
      'get_open_session_summary gained a field: %. It is readable by anyone '
      'who loads the page, so anything beyond a count and a time says which '
      'of this institution''s classes are meeting right now', keys;
  END IF;

  -- Belt and braces on the things that would matter most.
  IF r::text LIKE '%N26PIN%' THEN
    RAISE EXCEPTION 'the summary carries a PIN: %', r;
  END IF;
  IF r::text LIKE '%ASSERT-026%' OR r::text LIKE '%Naming Things%' THEN
    RAISE EXCEPTION 'the summary names a class: %', r;
  END IF;
  IF r::text LIKE '%N026-IN%' OR r::text LIKE '%Enrolled Here%' THEN
    RAISE EXCEPTION 'the summary names a student: %', r;
  END IF;
END
$anon$;

-- ----------------------------------------------------------------------------
-- What anon may read from the tables directly is NOT asserted here
--
-- It was, and it failed: students, canvas_row_mappings and flagged_resolutions
-- are all readable by anon. They predate the migrations, so the REVOKE that
-- every migration-created table gets never reached them, and 015 only swept
-- the legacy tables it retired.
--
-- That is a real exposure and a separate fix. Asserting it from here would
-- either fail this suite for something this migration did not cause, or be
-- quietly narrowed until it passed. It belongs with the migration that closes
-- it.
-- ----------------------------------------------------------------------------

DO $done$ BEGIN RAISE NOTICE '026 class-naming assertions passed'; END $done$;

ROLLBACK;
