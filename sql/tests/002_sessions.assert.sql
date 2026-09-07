-- ============================================================================
-- Migration 002 — schedules and sessions
--
-- The behaviours that matter: a session's calendar date is resolved in the
-- class's timezone rather than the server's, generating is re-runnable, an open
-- PIN is unique across the whole installation, and cancelling one cohort's
-- session leaves every other cohort alone.
--
-- Creates its own class under code 'ASSERT-002' and removes it at the end.
-- ============================================================================

DO $assert$
DECLARE
  v_class    uuid;
  v_cohort_a uuid;
  v_cohort_b uuid;
  v_session  uuid;
  v_other    uuid;
  n          bigint;
  d          date;
  ts         timestamptz;
  st         public.session_status;
  failed     boolean;
BEGIN
  -- ==========================================================================
  -- session_date is the class's local date, not the server's
  --
  -- Auckland is UTC+12 in May. A 09:00 local class on 19 May is 21:00 UTC on
  -- the 18th, so anything that derives the date by converting the timestamp to
  -- UTC — which is what attendanceExport does today — lands a day early and
  -- reports the whole cohort absent on a day they attended.
  -- ==========================================================================
  INSERT INTO public.classes (code, name, term_starts_on, term_ends_on, timezone)
  VALUES ('ASSERT-002', 'Timezone Class', DATE '2026-05-18', DATE '2026-05-28',
          'Pacific/Auckland')
  RETURNING id INTO v_class;

  INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'A') RETURNING id INTO v_cohort_a;
  INSERT INTO public.cohorts (class_id, label) VALUES (v_class, 'B') RETURNING id INTO v_cohort_b;

  INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
  VALUES (v_cohort_a, TIMESTAMPTZ '2026-05-18 21:00:00+00', DATE '1970-01-01')
  RETURNING id, session_date INTO v_session, d;

  IF d <> DATE '2026-05-19' THEN
    RAISE EXCEPTION
      'session_date should be 2026-05-19 in Pacific/Auckland, got % (UTC date is 2026-05-18)', d;
  END IF;

  -- class_id is filled in from the cohort rather than having to be passed.
  SELECT count(*) INTO n
  FROM public.class_sessions WHERE id = v_session AND class_id = v_class;
  IF n <> 1 THEN
    RAISE EXCEPTION 'class_id was not derived from the cohort';
  END IF;

  -- A session cannot claim to belong to a different class than its cohort does.
  failed := false;
  BEGIN
    UPDATE public.class_sessions
       SET class_id = gen_random_uuid()
     WHERE id = v_session;
  EXCEPTION WHEN others THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a session was allowed a class_id that disagrees with its cohort';
  END IF;

  DELETE FROM public.class_sessions WHERE id = v_session;

  -- ==========================================================================
  -- generate_sessions expands the schedule
  -- ==========================================================================
  -- Tue/Wed/Thu for both cohorts, 09:00.
  INSERT INTO public.cohort_schedules (class_id, cohort_id, weekday, start_time)
  SELECT v_class, c.id, w, TIME '09:00'
  FROM (VALUES (v_cohort_a), (v_cohort_b)) AS c(id),
       unnest(ARRAY[2, 3, 4]) AS w;

  -- 18–28 May 2026 holds Tue/Wed/Thu on 19, 20, 21, 26, 27, 28 = 6 per cohort.
  SELECT public.generate_sessions(v_class) INTO n;
  IF n <> 12 THEN
    RAISE EXCEPTION 'expected 12 generated sessions (6 days x 2 cohorts), got %', n;
  END IF;

  -- Every generated session must be a Tue, Wed or Thu in the class's timezone.
  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE class_id = v_class
    AND EXTRACT(DOW FROM session_date)::int NOT IN (2, 3, 4);
  IF n <> 0 THEN
    RAISE EXCEPTION '% generated sessions fall outside the scheduled weekdays', n;
  END IF;

  -- Re-running creates nothing: the TA will press the button twice.
  SELECT public.generate_sessions(v_class) INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'regenerating created % duplicate sessions', n;
  END IF;

  -- Adding a weekday and regenerating adds only the new ones.
  INSERT INTO public.cohort_schedules (class_id, cohort_id, weekday, start_time)
  VALUES (v_class, v_cohort_a, 5, TIME '14:00');          -- Fridays, cohort A

  -- Only 22 May: the term ends on the 28th, so 29 May is out of range.
  SELECT public.generate_sessions(v_class) INTO n;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 new Friday session in range, got %', n;
  END IF;

  -- Sessions start as scheduled, never as open. Nothing is attendable until a
  -- TA opens it.
  SELECT count(*) INTO n
  FROM public.class_sessions WHERE class_id = v_class AND status <> 'scheduled';
  IF n <> 0 THEN
    RAISE EXCEPTION '% sessions were generated already open or closed', n;
  END IF;

  -- Generated sessions inherit the class defaults, copied not referenced.
  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE class_id = v_class AND late_window_minutes = 10 AND duration_minutes = 60;
  IF n <> 13 THEN
    RAISE EXCEPTION 'expected 13 sessions carrying the class defaults, found %', n;
  END IF;

  -- ==========================================================================
  -- An open PIN is unique across the installation
  -- ==========================================================================
  SELECT id INTO v_session
  FROM public.class_sessions WHERE cohort_id = v_cohort_a ORDER BY starts_at LIMIT 1;
  SELECT id INTO v_other
  FROM public.class_sessions WHERE cohort_id = v_cohort_b ORDER BY starts_at LIMIT 1;

  UPDATE public.class_sessions SET status = 'open', pin = '1234' WHERE id = v_session;

  -- Two TAs both picking 1234 is not hypothetical. Without this the check-in
  -- RPC would have to choose one of them.
  failed := false;
  BEGIN
    UPDATE public.class_sessions SET status = 'open', pin = '1234' WHERE id = v_other;
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'two sessions were open on the same PIN';
  END IF;

  -- Case and padding must not create a second "different" PIN.
  failed := false;
  BEGIN
    UPDATE public.class_sessions SET status = 'open', pin = ' 1234 ' WHERE id = v_other;
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a padded duplicate PIN was accepted as distinct';
  END IF;

  -- opened_at was stamped without anyone passing it.
  SELECT opened_at INTO ts FROM public.class_sessions WHERE id = v_session;
  IF ts IS NULL THEN
    RAISE EXCEPTION 'opening a session did not stamp opened_at';
  END IF;

  -- Closing releases the PIN so it can be reused, and stamps closed_at.
  UPDATE public.class_sessions SET status = 'closed' WHERE id = v_session;

  IF (SELECT pin FROM public.class_sessions WHERE id = v_session) IS NOT NULL THEN
    RAISE EXCEPTION 'a closed session kept its PIN';
  END IF;
  IF (SELECT closed_at FROM public.class_sessions WHERE id = v_session) IS NULL THEN
    RAISE EXCEPTION 'closing a session did not stamp closed_at';
  END IF;

  -- Now the PIN is free again.
  UPDATE public.class_sessions SET status = 'open', pin = '1234' WHERE id = v_other;
  SELECT count(*) INTO n
  FROM public.class_sessions WHERE status = 'open' AND upper(btrim(pin)) = '1234';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 open session on PIN 1234, found %', n;
  END IF;

  -- ==========================================================================
  -- Cancellation is per session, so per cohort
  --
  -- The bug this forecloses: cancelled_sessions is keyed (date, cohort) but the
  -- weekly report matches on date alone, so cancelling A's Wednesday cancels
  -- everyone's. Sessions are not shared, so it cannot happen here.
  -- ==========================================================================
  SELECT id INTO v_session
  FROM public.class_sessions
  WHERE cohort_id = v_cohort_a AND session_date = DATE '2026-05-20';

  UPDATE public.class_sessions
     SET status = 'cancelled', cancellation_reason = 'Public holiday'
   WHERE id = v_session;

  SELECT status INTO st
  FROM public.class_sessions
  WHERE cohort_id = v_cohort_b AND session_date = DATE '2026-05-20';

  IF st = 'cancelled' THEN
    RAISE EXCEPTION 'cancelling cohort A''s session also cancelled cohort B''s';
  END IF;

  SELECT cancelled_at INTO ts FROM public.class_sessions WHERE id = v_session;
  IF ts IS NULL THEN
    RAISE EXCEPTION 'cancelling did not stamp cancelled_at';
  END IF;

  -- ==========================================================================
  -- Two cohorts cannot occupy the same slot twice
  -- ==========================================================================
  failed := false;
  BEGIN
    INSERT INTO public.class_sessions (cohort_id, starts_at, session_date)
    SELECT v_cohort_a, starts_at, session_date
    FROM public.class_sessions WHERE cohort_id = v_cohort_a LIMIT 1;
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'a duplicate session was created for the same cohort and instant';
  END IF;

  -- ==========================================================================
  -- RLS and realtime
  -- ==========================================================================
  SELECT count(*) INTO n
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public'
    AND c.relname IN ('cohort_schedules', 'class_sessions')
    AND c.relrowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected RLS on both new tables, got %', n;
  END IF;

  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('cohort_schedules', 'class_sessions')
    AND grantee = 'anon';
  IF n <> 0 THEN
    RAISE EXCEPTION 'anon holds % grants on the session tables; it should hold none', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename = 'class_sessions';
  IF n <> 1 THEN
    RAISE EXCEPTION 'class_sessions is not published for realtime';
  END IF;

  -- ==========================================================================
  -- Clean up
  -- ==========================================================================
  DELETE FROM public.classes WHERE code = 'ASSERT-002';

  SELECT count(*) INTO n FROM public.class_sessions WHERE class_id = v_class;
  IF n <> 0 THEN
    RAISE EXCEPTION 'sessions survived their class being deleted';
  END IF;

  RAISE NOTICE '002 assertions passed';
END
$assert$;
