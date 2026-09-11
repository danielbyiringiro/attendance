-- ============================================================================
-- Migration 033 — a lecture in progress can still open itself
--
-- The case that matters is the one 031 got wrong: a TA reaching the dashboard
-- partway through their own class. Under 031 the session had stopped being
-- eligible fifteen minutes after the start and would never open, while opening
-- it by hand worked perfectly — so it read as auto-open being broken rather
-- than expired.
--
-- The guard that 031 was actually right about still has to hold: a class that
-- finished must not open. Both are asserted here, because widening a bound is
-- exactly the change that removes the protection along with the limitation.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class('ASSERT-033', 'Mid Lecture',
                CURRENT_DATE - 30, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S033A", "name": "Present"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- A 60 minute class that began 40 minutes ago, with a 15 minute check-in
  -- window. Under 031 this stopped being openable 25 minutes ago.
  --
  -- And one that began 3 hours ago and is long finished.
  CREATE TEMP TABLE t033 ON COMMIT DROP AS
  WITH ins AS (
    INSERT INTO public.class_sessions
      (class_id, cohort_id, starts_at, duration_minutes, status,
       early_open_minutes, auto_close_minutes, late_window_minutes)
    VALUES
      (v_class, v_cohort, now() - interval '40 minutes', 60, 'scheduled', 15, 15, 10),
      (v_class, v_cohort, now() - interval '3 hours',    60, 'scheduled', 15, 15, 10)
    RETURNING id, starts_at
  )
  SELECT
    (SELECT id FROM ins WHERE starts_at > now() - interval '1 hour') AS midway_id,
    (SELECT id FROM ins WHERE starts_at < now() - interval '2 hours') AS over_id,
    v_class AS class_id;
END;
$setup$;

DO $assert$
DECLARE
  t         record;
  v_status  public.session_status;
  v_pin     text;
  v_closes  timestamptz;
  v_session public.class_sessions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM t033;

  PERFORM public.sync_sessions();

  -- The one 031 refused.
  SELECT status, pin INTO v_status, v_pin
  FROM public.class_sessions WHERE id = t.midway_id;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      '033: a class 40 minutes into its hour did not open (status %) — a TA arriving late to their own lecture cannot start check-in',
      v_status;
  END IF;
  IF v_pin IS NULL THEN
    RAISE EXCEPTION '033: opened with no PIN, so nobody can check in';
  END IF;

  -- Opening late must still give a full window, measured from the opening.
  -- Without this the session would be opened and immediately closeable, which
  -- is worse than not opening it: a PIN appears and stops working at once.
  SELECT * INTO v_session FROM public.class_sessions WHERE id = t.midway_id;
  v_closes := public.session_closes_at(v_session);

  IF v_closes <= now() THEN
    RAISE EXCEPTION
      '033: opened a session whose window had already shut (closes %) — the PIN would be dead on arrival',
      v_closes;
  END IF;

  -- And the guard 031 was right about. Widening a bound is exactly the change
  -- that quietly removes the protection along with the limitation.
  SELECT status INTO v_status FROM public.class_sessions WHERE id = t.over_id;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION
      '033: a class that finished two hours ago was opened — a sweep after downtime must not resurrect finished lectures';
  END IF;

  RAISE NOTICE
    '033 ok: a lecture in progress opened and its window runs to %, a finished one was left alone',
    v_closes;
END;
$assert$;

ROLLBACK;
