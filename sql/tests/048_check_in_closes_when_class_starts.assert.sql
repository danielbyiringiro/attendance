-- ============================================================================
-- Migration 048 — check-in that shuts when the class starts, with grace
--
-- Sessions are built by hand with fixed opened_at values, because the whole
-- feature is arithmetic on three timestamps and a boolean. now() only matters
-- for the sweep, which is checked separately with sessions placed around it.
--
-- What is checked:
--
--   nothing changes when the setting is off    every existing class
--   opened early, setting on                   closes exactly at the start
--   opened at the start                        closes at the start
--   opened after the start                     closes grace_minutes later
--   a mark inside grace                        present, or late when asked
--   a mark under the normal rule               still uses late_window_minutes
--   the sweep                                  will not open a class that has
--                                              already started, when the
--                                              setting is on
--   the grace bound                            1-30, enforced by the column
--                                              and by set_session_windows
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
  v_class := (public.create_class('ASSERT-048', 'Closing',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  PERFORM set_config('t048.class', v_class::text, true);

  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  PERFORM set_config('t048.cohort', v_a::text, true);

  PERFORM public.upsert_enrolments(v_a, '[{"student_id": "S048", "name": "Marker"}]'::jsonb);
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
  -- A session shaped by hand: the row is what session_closes_at reads.
  s.id                 := gen_random_uuid();
  s.class_id           := current_setting('t048.class')::uuid;
  s.cohort_id          := current_setting('t048.cohort')::uuid;
  s.starts_at          := starts;
  s.duration_minutes   := 60;
  s.auto_close_minutes := 15;
  s.late_window_minutes := 10;
  s.early_open_minutes := 5;
  s.grace_minutes      := 5;

  -- OFF: 028's rule, whichever is later plus the sign-up window.
  s.closes_at_start := false;
  s.opened_at := starts - interval '5 minutes';
  IF public.session_closes_at(s) <> starts + interval '15 minutes' THEN
    RAISE EXCEPTION '048: with the setting off, an early open no longer closes at start+auto_close (got %)',
      public.session_closes_at(s);
  END IF;

  s.opened_at := starts + interval '7 minutes';
  IF public.session_closes_at(s) <> starts + interval '22 minutes' THEN
    RAISE EXCEPTION '048: with the setting off, a late open no longer gets its full window (got %)',
      public.session_closes_at(s);
  END IF;

  -- ON, opened early: the door shuts as the class starts.
  s.closes_at_start := true;
  s.opened_at := starts - interval '5 minutes';
  IF public.session_closes_at(s) <> starts THEN
    RAISE EXCEPTION '048: opened early, check-in should close at the start, got %',
      public.session_closes_at(s);
  END IF;

  -- ON, opened exactly at the start: the same branch, deliberately.
  s.opened_at := starts;
  IF public.session_closes_at(s) <> starts THEN
    RAISE EXCEPTION '048: opened at the start, check-in should close at the start, got %',
      public.session_closes_at(s);
  END IF;

  -- ON, opened after: grace from the click, not from the class.
  s.opened_at := starts + interval '7 minutes';
  IF public.session_closes_at(s) <> starts + interval '12 minutes' THEN
    RAISE EXCEPTION '048: opened late, check-in should close grace_minutes after opening, got %',
      public.session_closes_at(s);
  END IF;

  -- Never opened: no window at all, either way.
  s.opened_at := NULL;
  IF public.session_closes_at(s) IS NOT NULL THEN
    RAISE EXCEPTION '048: a session nobody opened has a closing time';
  END IF;

  RAISE NOTICE '048 ok: closing is the start, or grace after a late open, and unchanged when off';
END;
$closing$;

-- ----------------------------------------------------------------------------
-- Present or late
-- ----------------------------------------------------------------------------

DO $state$
DECLARE
  s      public.class_sessions%ROWTYPE;
  starts timestamptz := now() + interval '1 day';
BEGIN
  s.starts_at           := starts;
  s.late_window_minutes := 10;
  s.grace_minutes       := 5;

  -- The normal rule still measures from the later of opening and the start.
  s.closes_at_start := false;
  s.opened_at := starts - interval '5 minutes';
  IF public.session_mark_state(s, starts - interval '1 minute') <> 'present' THEN
    RAISE EXCEPTION '048: a mark before the class started was recorded late';
  END IF;
  IF public.session_mark_state(s, starts + interval '11 minutes') <> 'late' THEN
    RAISE EXCEPTION '048: a mark past late_window_minutes was not recorded late';
  END IF;

  -- Inside a grace window: present by default.
  s.closes_at_start  := true;
  s.grace_counts_late := false;
  s.opened_at := starts + interval '7 minutes';
  IF public.session_mark_state(s, starts + interval '8 minutes') <> 'present' THEN
    RAISE EXCEPTION '048: a mark inside the grace window should be present by default';
  END IF;

  -- And late when the class asks for that.
  s.grace_counts_late := true;
  IF public.session_mark_state(s, starts + interval '8 minutes') <> 'late' THEN
    RAISE EXCEPTION '048: grace_counts_late did not make a grace mark late';
  END IF;

  -- Opened early with the setting on: there is no grace window, so the normal
  -- rule applies and nothing inside the window is late.
  s.grace_counts_late := true;
  s.opened_at := starts - interval '5 minutes';
  IF public.session_mark_state(s, starts - interval '1 minute') <> 'present' THEN
    RAISE EXCEPTION '048: grace_counts_late leaked into a session opened before the class';
  END IF;

  RAISE NOTICE '048 ok: grace decides present or late only inside a grace window';
END;
$state$;

-- ----------------------------------------------------------------------------
-- The sweep will not open a class that has already begun
-- ----------------------------------------------------------------------------

-- Through sync_sessions, not open_due_sessions: the inner functions are
-- deliberately granted to nobody (031), and the sweep is reached through the
-- one RPC the dashboard and pg_cron actually call. Testing the granted path is
-- also the only way to notice if that grant ever goes.
DO $sweep$
DECLARE
  v_shuts  uuid;
  v_normal uuid;
  v_swept  jsonb;
BEGIN
  -- Both started ten minutes ago and run an hour, so 033's rule would open
  -- each of them. One shuts at the start.
  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, early_open_minutes, auto_close_minutes, late_window_minutes,
    closes_at_start, grace_minutes
  )
  VALUES (
    current_setting('t048.class')::uuid, current_setting('t048.cohort')::uuid,
    now() - interval '10 minutes', CURRENT_DATE, 60,
    'scheduled', 5, 15, 10, true, 5)
  RETURNING id INTO v_shuts;

  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, early_open_minutes, auto_close_minutes, late_window_minutes,
    closes_at_start, grace_minutes
  )
  VALUES (
    current_setting('t048.class')::uuid, current_setting('t048.cohort')::uuid,
    now() - interval '10 minutes' + interval '1 second', CURRENT_DATE, 60,
    'scheduled', 5, 15, 10, false, 5)
  RETURNING id INTO v_normal;

  v_swept := public.sync_sessions();

  IF (SELECT status FROM public.class_sessions WHERE id = v_shuts) <> 'scheduled' THEN
    RAISE EXCEPTION '048: the sweep opened a class that had already started, whose check-in shuts at the start';
  END IF;

  IF (SELECT status FROM public.class_sessions WHERE id = v_normal) <> 'open' THEN
    RAISE EXCEPTION '048: the sweep stopped opening an ordinary session mid-class, which is 033''s rule';
  END IF;

  RAISE NOTICE '048 ok: the sweep opens a class in progress only when check-in does not shut at its start';
END;
$sweep$;

-- ----------------------------------------------------------------------------
-- Defaults, propagation and bounds
-- ----------------------------------------------------------------------------

DO $settings$
DECLARE
  k  public.classes%ROWTYPE;
  ok boolean;
BEGIN
  SELECT * INTO k FROM public.classes WHERE id = current_setting('t048.class')::uuid;
  IF k.default_closes_at_start OR k.default_grace_counts_late THEN
    RAISE EXCEPTION '048: a new class is not on the old behaviour: % / %',
      k.default_closes_at_start, k.default_grace_counts_late;
  END IF;
  IF k.default_grace_minutes <> 5 THEN
    RAISE EXCEPTION '048: the default grace window is % minutes, expected 5',
      k.default_grace_minutes;
  END IF;

  PERFORM public.set_session_windows(
    p_class_id         := current_setting('t048.class')::uuid,
    p_closes_at_start  := true,
    p_grace_minutes    := 12,
    p_grace_counts_late := true);

  SELECT * INTO k FROM public.classes WHERE id = current_setting('t048.class')::uuid;
  IF NOT k.default_closes_at_start
     OR k.default_grace_minutes <> 12
     OR NOT k.default_grace_counts_late THEN
    RAISE EXCEPTION '048: set_session_windows did not carry the closing rule to the class defaults';
  END IF;

  -- The sign-up window is untouched by a call that did not mention it.
  IF k.default_auto_close_minutes IS NULL THEN
    RAISE EXCEPTION '048: the sign-up window was cleared by a closing-rule change';
  END IF;

  BEGIN
    PERFORM public.set_session_windows(
      p_class_id      := current_setting('t048.class')::uuid,
      p_grace_minutes := 90);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '048: a 90 minute grace window was accepted';
  END IF;

  BEGIN
    UPDATE public.class_sessions SET grace_minutes = 0
     WHERE class_id = current_setting('t048.class')::uuid;
    ok := false;
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '048: a zero-minute grace window was stored';
  END IF;

  RAISE NOTICE '048 ok: off by default, settable for a class, and bounded at 1-30';
END;
$settings$;

DO $generation$
DECLARE
  v_slot uuid;
BEGIN
  -- A weekly slot with its own closing rule, overriding the class default —
  -- which the block above set to "shuts at the start" with a 12 minute grace.
  --
  -- Inserted rather than set through set_cohort_schedules: what is under test
  -- here is what generate_sessions copies onto a session, and a slot is four
  -- NOT NULL columns. Going through the RPC would test its JSON shape instead.
  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time, duration_minutes,
    closes_at_start, grace_minutes
  )
  VALUES (
    current_setting('t048.class')::uuid,
    current_setting('t048.cohort')::uuid,
    EXTRACT(DOW FROM CURRENT_DATE + 2)::smallint,
    TIME '09:00',
    60,
    false,
    7)
  RETURNING id INTO v_slot;

  PERFORM public.generate_sessions(
    current_setting('t048.class')::uuid,
    current_setting('t048.cohort')::uuid,
    CURRENT_DATE + 1, CURRENT_DATE + 8);

  IF EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE schedule_id = v_slot
      AND (closes_at_start <> false OR grace_minutes <> 7)
  ) THEN
    RAISE EXCEPTION '048: a generated session did not take its slot''s closing rule';
  END IF;

  RAISE NOTICE '048 ok: a generated session inherits the slot''s closing rule, or the class default';
END;
$generation$;

-- ----------------------------------------------------------------------------
-- One session, and one weekly slot
--
-- The rule is rarely true of a whole class evenly: a cohort's lecture shuts the
-- door at the start while its lab does not, and one particular Tuesday is an
-- exception to whichever the pattern says.
-- ----------------------------------------------------------------------------

DO $one_session$
DECLARE
  v_session uuid;
  s         public.class_sessions%ROWTYPE;
  ok        boolean;
BEGIN
  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, early_open_minutes, auto_close_minutes, late_window_minutes,
    closes_at_start, grace_minutes, grace_counts_late
  )
  VALUES (
    current_setting('t048.class')::uuid, current_setting('t048.cohort')::uuid,
    now() + interval '3 days', (CURRENT_DATE + 3), 60,
    'scheduled', 5, 15, 10, false, 5, false)
  RETURNING id INTO v_session;

  PERFORM public.update_session(
    p_session_id      := v_session,
    p_closes_at_start := true,
    p_grace_minutes   := 9,
    p_grace_counts_late := true);

  SELECT * INTO s FROM public.class_sessions WHERE id = v_session;
  IF NOT s.closes_at_start OR s.grace_minutes <> 9 OR NOT s.grace_counts_late THEN
    RAISE EXCEPTION '048: update_session did not set the closing rule on one session: % / % / %',
      s.closes_at_start, s.grace_minutes, s.grace_counts_late;
  END IF;

  -- And it is genuinely one session: the slot it came from is untouched.
  IF EXISTS (
    SELECT 1 FROM public.cohort_schedules
    WHERE cohort_id = current_setting('t048.cohort')::uuid
      AND closes_at_start IS DISTINCT FROM false
  ) THEN
    RAISE EXCEPTION '048: changing one session changed its weekly slot too';
  END IF;

  BEGIN
    PERFORM public.update_session(
      p_session_id    := v_session,
      p_grace_minutes := 90);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '048: update_session accepted a 90 minute grace window';
  END IF;

  RAISE NOTICE '048 ok: one session can be set on its own, and its slot is left alone';
END;
$one_session$;

DO $one_slot$
DECLARE
  v_cohort uuid := current_setting('t048.cohort')::uuid;
  ok       boolean;
BEGIN
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    jsonb_build_array(
      jsonb_build_object(
        'weekday', EXTRACT(DOW FROM CURRENT_DATE + 4)::int,
        'start_time', '11:00',
        'closes_at_start', true,
        'grace_minutes', 8,
        'grace_counts_late', true),
      -- A second slot with none of them: it inherits the class default.
      jsonb_build_object(
        'weekday', EXTRACT(DOW FROM CURRENT_DATE + 5)::int,
        'start_time', '15:00')));

  IF NOT EXISTS (
    SELECT 1 FROM public.cohort_schedules
    WHERE cohort_id = v_cohort AND start_time = TIME '11:00'
      AND closes_at_start AND grace_minutes = 8 AND grace_counts_late
  ) THEN
    RAISE EXCEPTION '048: a slot did not keep the closing rule it was given';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cohort_schedules
    WHERE cohort_id = v_cohort AND start_time = TIME '15:00'
      AND closes_at_start IS NULL AND grace_minutes IS NULL
  ) THEN
    RAISE EXCEPTION '048: a slot given nothing did not stay on the class default';
  END IF;

  BEGIN
    PERFORM public.set_cohort_schedules(
      ARRAY[v_cohort],
      jsonb_build_array(jsonb_build_object(
        'weekday', 2, 'start_time', '09:00', 'grace_minutes', 45)));
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '048: a slot with a 45 minute grace window was accepted';
  END IF;

  RAISE NOTICE '048 ok: one weekly slot can be set on its own, and a slot given nothing inherits';
END;
$one_slot$;

ROLLBACK;
