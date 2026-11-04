-- ============================================================================
-- Migration 063 — add time to check-in while it is open
--
-- What is checked:
--
--   the closing rule        extra_minutes lands on top of all three of 048's
--                           rules, and nothing moves while it is zero
--   extend_check_in         adds to an open session and keeps its PIN
--   a window already over   the time is measured from now, not from the past
--                           deadline
--   refusals                not open, out of 1-60, past four hours in all,
--                           and somebody not on the class
--   marks                   a check-in in the added time is accepted
--   the display screen      carries extra_minutes and 048's fields
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class uuid;
  v_a     uuid;
BEGIN
  v_class := (public.create_class('ASSERT-063', 'More time',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  PERFORM set_config('t063.class', v_class::text, true);

  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  PERFORM set_config('t063.cohort', v_a::text, true);

  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "S063", "name": "Latecomer"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30 WHERE cohort_id = v_a;
END;
$setup$;

-- ----------------------------------------------------------------------------
-- The closing rule, as arithmetic
-- ----------------------------------------------------------------------------

DO $closing$
DECLARE
  s      public.class_sessions%ROWTYPE;
  starts timestamptz := now() + interval '1 day';
BEGIN
  s.starts_at           := starts;
  s.auto_close_minutes  := 15;
  s.grace_minutes       := 5;
  s.extra_minutes       := 0;

  -- Zero changes nothing: 048's three answers, exactly.
  s.closes_at_start := false;
  s.opened_at := starts - interval '5 minutes';
  IF public.session_closes_at(s) <> starts + interval '15 minutes' THEN
    RAISE EXCEPTION '063: with no time added the ordinary rule moved (got %)', public.session_closes_at(s);
  END IF;

  s.extra_minutes := 10;
  IF public.session_closes_at(s) <> starts + interval '25 minutes' THEN
    RAISE EXCEPTION '063: ten minutes added to the ordinary rule gave %', public.session_closes_at(s);
  END IF;

  -- Closes at the start: the added time runs past it.
  s.closes_at_start := true;
  IF public.session_closes_at(s) <> starts + interval '10 minutes' THEN
    RAISE EXCEPTION '063: ten minutes added to a class that shuts at the start gave %', public.session_closes_at(s);
  END IF;

  -- In a grace window: on top of the grace.
  s.opened_at := starts + interval '7 minutes';
  IF public.session_closes_at(s) <> starts + interval '22 minutes' THEN
    RAISE EXCEPTION '063: ten minutes added to a grace window gave %', public.session_closes_at(s);
  END IF;

  s.opened_at := NULL;
  IF public.session_closes_at(s) IS NOT NULL THEN
    RAISE EXCEPTION '063: a session nobody opened has a closing time once time is added';
  END IF;

  RAISE NOTICE '063 ok: added time lands on top of whichever closing rule applies';
END;
$closing$;

-- ----------------------------------------------------------------------------
-- extend_check_in
-- ----------------------------------------------------------------------------

DO $extend$
DECLARE
  v_session uuid;
  v_pin     text;
  v_before  timestamptz;
  s         public.class_sessions%ROWTYPE;
  ok        boolean;
  v_mark    jsonb;
BEGIN
  -- Started five minutes ago, opened then, a fifteen minute window: ten left.
  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, early_open_minutes, auto_close_minutes, late_window_minutes
  )
  VALUES (
    current_setting('t063.class')::uuid, current_setting('t063.cohort')::uuid,
    now() - interval '5 minutes', CURRENT_DATE, 60,
    'scheduled', 5, 15, 10)
  RETURNING id INTO v_session;
  PERFORM set_config('t063.session', v_session::text, true);

  -- Refused before it is open: there is no window yet to add to.
  BEGIN
    PERFORM public.extend_check_in(v_session, 5);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: time was added to a session that was not open';
  END IF;

  PERFORM public.open_session(v_session);
  UPDATE public.class_sessions SET opened_at = now() - interval '5 minutes'
   WHERE id = v_session;
  SELECT * INTO s FROM public.class_sessions WHERE id = v_session;
  v_pin := s.pin;
  v_before := public.session_closes_at(s);

  s := public.extend_check_in(v_session, 5);
  IF s.extra_minutes <> 5 THEN
    RAISE EXCEPTION '063: adding five minutes stored %', s.extra_minutes;
  END IF;
  IF public.session_closes_at(s) <> v_before + interval '5 minutes' THEN
    RAISE EXCEPTION '063: adding five minutes moved the close from % to %',
      v_before, public.session_closes_at(s);
  END IF;
  IF s.pin IS DISTINCT FROM v_pin OR s.status <> 'open' THEN
    RAISE EXCEPTION '063: adding time changed the PIN or the status';
  END IF;

  -- Again: it adds up.
  s := public.extend_check_in(v_session, 3);
  IF s.extra_minutes <> 8 THEN
    RAISE EXCEPTION '063: five then three minutes stored %', s.extra_minutes;
  END IF;

  -- Bounds on one press.
  BEGIN
    PERFORM public.extend_check_in(v_session, 0);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: adding zero minutes was accepted';
  END IF;

  BEGIN
    PERFORM public.extend_check_in(v_session, 61);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: adding 61 minutes at once was accepted';
  END IF;

  -- Four hours in all.
  UPDATE public.class_sessions SET extra_minutes = 230 WHERE id = v_session;
  BEGIN
    PERFORM public.extend_check_in(v_session, 20);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: check-in was extended past four hours in all';
  END IF;

  -- A mark in the added time is accepted. Back to a window that ran out two
  -- minutes ago, then five more minutes.
  UPDATE public.class_sessions SET extra_minutes = 0, auto_close_minutes = 3
   WHERE id = v_session;
  SELECT * INTO s FROM public.class_sessions WHERE id = v_session;
  IF public.session_is_live(s) THEN
    RAISE EXCEPTION '063: the set-up session should have run out already';
  END IF;

  s := public.extend_check_in(v_session, 5);
  -- Measured from now: it ran out two minutes ago, so five more from now is
  -- seven on the clock, not five that would end three minutes from now.
  IF public.session_closes_at(s) < now() + interval '5 minutes' THEN
    RAISE EXCEPTION '063: time added after the window ran out ends at %, under five minutes from now',
      public.session_closes_at(s);
  END IF;
  IF public.session_closes_at(s) > now() + interval '6 minutes' THEN
    RAISE EXCEPTION '063: time added after the window ran out overshot to %',
      public.session_closes_at(s);
  END IF;

  v_mark := public.mark_attendance('S063', v_pin);
  IF NOT COALESCE((v_mark ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION '063: a check-in inside the added time was refused: %', v_mark;
  END IF;

  RAISE NOTICE '063 ok: time adds up, keeps the PIN, is bounded, starts from now when late, and lets a mark in';
END;
$extend$;

-- Somebody not on the class cannot add time to it.
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $outsider$
DECLARE
  ok boolean;
BEGIN
  BEGIN
    PERFORM public.extend_check_in(current_setting('t063.session')::uuid, 5);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: somebody not on the class added time to its check-in';
  END IF;
  RAISE NOTICE '063 ok: only staff on the class can add time';
END;
$outsider$;

SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- Closed is closed: the sweep's decision is not undone by adding time.
DO $closed$
DECLARE
  ok boolean;
BEGIN
  UPDATE public.class_sessions SET status = 'closed', closed_at = now()
   WHERE id = current_setting('t063.session')::uuid;
  BEGIN
    PERFORM public.extend_check_in(current_setting('t063.session')::uuid, 5);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '063: time was added to a closed session';
  END IF;
  RAISE NOTICE '063 ok: a closed session cannot be extended';
END;
$closed$;

-- ----------------------------------------------------------------------------
-- The display screen gets what it needs to count down correctly
-- ----------------------------------------------------------------------------

DO $display$
DECLARE
  v_session uuid;
  v_link    jsonb;
  v_shown   jsonb;
  v_entry   jsonb;
BEGIN
  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, early_open_minutes, auto_close_minutes, late_window_minutes,
    closes_at_start, grace_minutes
  )
  VALUES (
    current_setting('t063.class')::uuid, current_setting('t063.cohort')::uuid,
    now() + interval '3 minutes', CURRENT_DATE, 60,
    'scheduled', 10, 15, 10, true, 6)
  RETURNING id INTO v_session;
  PERFORM public.open_session(v_session);
  PERFORM public.extend_check_in(v_session, 4);

  v_link := public.issue_display_code(current_setting('t063.class')::uuid);
  v_shown := public.get_class_display(v_link ->> 'token', v_link ->> 'code');

  SELECT e INTO v_entry FROM jsonb_array_elements(v_shown -> 'sessions') e
   WHERE e ->> 'id' = v_session::text;
  IF v_entry IS NULL THEN
    RAISE EXCEPTION '063: the open session is missing from the display: %', v_shown;
  END IF;
  IF (v_entry ->> 'extra_minutes')::int IS DISTINCT FROM 4
     OR (v_entry ->> 'closes_at_start')::boolean IS DISTINCT FROM true
     OR (v_entry ->> 'grace_minutes')::int IS DISTINCT FROM 6
     OR (v_entry ->> 'grace_counts_late') IS NULL THEN
    RAISE EXCEPTION '063: the display does not carry the closing rule: %', v_entry;
  END IF;

  RAISE NOTICE '063 ok: the display screen is told the added time and the 048 rule';
END;
$display$;

ROLLBACK;
