-- ============================================================================
-- Term dates versus sessions that already exist
--
-- Written to answer a direct question: if you change a class's term range,
-- what happens to sessions that have already been created, and to ones that
-- have already been used?
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class('ASSERT-020', 'Term dates',
                CURRENT_DATE - 30, CURRENT_DATE + 60,
                'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class;

  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE)::int)::jsonb);
  PERFORM public.generate_sessions(v_class);

  CREATE TEMP TABLE t020 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- Editing the term alone changes no session at all
-- ----------------------------------------------------------------------------

DO $edit_only$
DECLARE
  v_class  uuid := (SELECT class_id FROM t020);
  v_before integer;
  v_after  integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.class_sessions WHERE class_id = v_class;

  PERFORM public.update_class(v_class, NULL, NULL,
            CURRENT_DATE - 10, CURRENT_DATE + 14);

  SELECT count(*) INTO v_after FROM public.class_sessions WHERE class_id = v_class;

  IF v_after <> v_before THEN
    RAISE EXCEPTION
      'changing the term changed the session count on its own: % -> %',
      v_before, v_after;
  END IF;
END
$edit_only$;

-- ----------------------------------------------------------------------------
-- A session that has RUN is never removed, even outside the new term
-- ----------------------------------------------------------------------------

DO $used$
DECLARE
  v_class  uuid := (SELECT class_id FROM t020);
  v_cohort uuid := (SELECT cohort_id FROM t020);
  v_far    uuid;
BEGIN
  -- A session well past the new term end, already closed.
  SELECT id INTO v_far
  FROM public.class_sessions
  WHERE class_id = v_class AND session_date > CURRENT_DATE + 14
  ORDER BY session_date LIMIT 1;

  IF v_far IS NULL THEN
    RAISE EXCEPTION 'the fixture has no session past the shortened term';
  END IF;

  UPDATE public.class_sessions SET status = 'closed' WHERE id = v_far;

  PERFORM public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  IF NOT EXISTS (SELECT 1 FROM public.class_sessions WHERE id = v_far) THEN
    RAISE EXCEPTION
      'a session that had already run was deleted because the term was shortened';
  END IF;
END
$used$;

-- ----------------------------------------------------------------------------
-- But an unused session outside the new term IS removed, on the next apply
--
-- This is the surprising half and the reason to document it: shortening the
-- term does nothing on its own, and then quietly prunes on the next pattern
-- save.
-- ----------------------------------------------------------------------------

DO $unused$
DECLARE
  v_class  uuid := (SELECT class_id FROM t020);
  v_cohort uuid := (SELECT cohort_id FROM t020);
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE class_id = v_class
    AND session_date > CURRENT_DATE + 14
    AND status = 'scheduled';

  IF n > 0 THEN
    RAISE EXCEPTION
      '% scheduled session(s) survive past the shortened term end', n;
  END IF;
END
$unused$;

DO $done$ BEGIN RAISE NOTICE '020 term-date assertions passed'; END $done$;

ROLLBACK;
