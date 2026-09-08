-- ============================================================================
-- Migration 016 — a flag is visible only to the class it belongs to
--
-- The fault this closes is a leak: `flagged` had no RLS, so every TA could read
-- every dispute in the installation, and the review screen showed them. The
-- assertions are mostly about what a TA can NO LONGER see.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    ('66666666-6666-6666-6666-666666666666', 'other-ta@example.edu')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.staff (user_id, email, display_name, status) VALUES
    ('66666666-6666-6666-6666-666666666666', 'other-ta@example.edu', 'Other TA', 'approved')
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $setup$
DECLARE
  v_mine   uuid;
  v_cohort uuid;
  v_sess   uuid;
BEGIN
  v_mine := (public.create_class('ASSERT-016', 'Mine',
               CURRENT_DATE - 10, CURRENT_DATE + 20,
               'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_mine;

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "F016-A", "name": "Flagger"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 10
   WHERE cohort_id = v_cohort;

  PERFORM public.set_cohort_schedules(ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE - 7)::int)::jsonb);
  PERFORM public.generate_sessions(v_mine, NULL, CURRENT_DATE - 7, CURRENT_DATE - 7);

  SELECT id INTO v_sess FROM public.class_sessions WHERE cohort_id = v_cohort;
  UPDATE public.class_sessions SET status = 'closed' WHERE id = v_sess;

  CREATE TEMP TABLE t016 ON COMMIT DROP AS
  SELECT v_mine AS class_id, v_cohort AS cohort_id, v_sess AS session_id;
END
$setup$;

-- ----------------------------------------------------------------------------
-- Flagging by session id attributes the class, and refuses somebody else's
-- ----------------------------------------------------------------------------

DO $flagging$
DECLARE
  v_sess uuid := (SELECT session_id FROM t016);
  r jsonb;
BEGIN
  r := public.flag_attendance('F016-A', v_sess);
  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'an enrolled student could not flag their own session: %', r;
  END IF;
  IF (r ->> 'class_id')::uuid <> (SELECT class_id FROM t016) THEN
    RAISE EXCEPTION 'the flag was attributed to the wrong class: %', r;
  END IF;

  -- Twice is once.
  r := public.flag_attendance('F016-A', v_sess);
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'the same session was flagged twice';
  END IF;

  -- A session the student is not enrolled in is refused outright.
  r := public.flag_attendance('S001', v_sess);
  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'a student flagged a session of a cohort they are not in';
  END IF;
  IF (r ->> 'error') <> 'not_your_session' THEN
    RAISE EXCEPTION 'unexpected refusal for a non-enrolled student: %', r;
  END IF;
END
$flagging$;

-- ----------------------------------------------------------------------------
-- The owning TA sees it
-- ----------------------------------------------------------------------------

DO $mine$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.flagged WHERE student_id = 'F016-A';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the class''s own TA cannot see the flag they should (% rows)', n;
  END IF;
END
$mine$;

-- ----------------------------------------------------------------------------
-- A TA of another class does not — the whole point
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';

DO $theirs$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.flagged WHERE student_id = 'F016-A';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'a TA with no access to the class can still read its flags (% rows) — '
      'the review screen would show them a student id they have no business seeing', n;
  END IF;

  -- And cannot resolve one either.
  UPDATE public.flagged SET status = 'accepted' WHERE student_id = 'F016-A';
  IF FOUND THEN
    RAISE EXCEPTION 'an outsider resolved a dispute belonging to another class';
  END IF;
END
$theirs$;

-- ----------------------------------------------------------------------------
-- Nothing is left unattributed by accident
-- ----------------------------------------------------------------------------

RESET ROLE;

DO $attribution$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.flagged f
  WHERE f.class_id IS NULL
    AND f.session_id IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      '% flag(s) point at a session but carry no class; the backfill missed them', n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.flagged f
    JOIN public.class_sessions s ON s.id = f.session_id
    WHERE f.class_id <> s.class_id
  ) THEN
    RAISE EXCEPTION 'a flag is attributed to a different class than its session';
  END IF;
END
$attribution$;

DO $done$ BEGIN RAISE NOTICE '016 flag scoping assertions passed'; END $done$;

ROLLBACK;
