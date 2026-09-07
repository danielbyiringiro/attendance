-- ============================================================================
-- The fixture itself is correct.
--
-- Runs before any migration exists, so the harness is verified end-to-end from
-- the first commit rather than only once there is something to migrate. These
-- assertions also pin the awkward shapes the backfill has to handle, so if
-- someone "tidies" the fixture later, the thing it was tidying away is named.
-- ============================================================================

DO $$
DECLARE
  n bigint;
  t text;
BEGIN
  -- --- roster ---------------------------------------------------------------
  SELECT count(*) INTO n FROM public.students;
  IF n <> 6 THEN
    RAISE EXCEPTION 'expected 6 students, found %', n;
  END IF;

  -- Cohort C is the letter README's `check (cohort in ('A','B'))` rejects.
  -- If this fails, the fixture has grown a constraint it must not have.
  SELECT count(*) INTO n FROM public.students WHERE cohort = 'C';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 cohort C students, found %', n;
  END IF;

  -- A student with no name, so the roster upload's fill-if-null rule has a target.
  SELECT count(*) INTO n FROM public.students WHERE name IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 nameless student, found %', n;
  END IF;

  -- --- check-ins ------------------------------------------------------------
  SELECT count(*) INTO n FROM public.present_students;
  IF n <> 18 THEN
    RAISE EXCEPTION 'expected 18 check-in rows, found %', n;
  END IF;

  -- The duplicate the table has no constraint against. The backfill must
  -- collapse this to one attendance record.
  SELECT count(*) INTO n
  FROM public.present_students
  WHERE student_id = 'S001' AND timestamp::date = DATE '2026-05-19';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected S001 to have 2 check-ins on 19 May, found %', n;
  END IF;

  -- An orphan check-in: present_students has no FK to students.
  SELECT count(*) INTO n
  FROM public.present_students p
  WHERE NOT EXISTS (SELECT 1 FROM public.students s WHERE s.student_id = p.student_id);
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 orphan check-in, found %', n;
  END IF;

  -- --- the per-cohort cancellation -----------------------------------------
  -- 27 May is cancelled for A. B still met that day, which is the case the
  -- weekly report gets wrong today by matching on date alone.
  SELECT count(*) INTO n
  FROM public.cancelled_sessions
  WHERE date = DATE '2026-05-27' AND cohort = 'A' AND is_cancelled;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 27 May cancelled for cohort A, found % rows', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.present_students
  WHERE timestamp::date = DATE '2026-05-27' AND cohort = 'B';
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected 2 cohort B check-ins on the day A was cancelled, found %', n;
  END IF;

  -- Somebody marked before the class was called off. The backfill must keep
  -- that record, matching cancel_session(), which deletes only unexcused rows.
  SELECT count(*) INTO n
  FROM public.present_students
  WHERE timestamp::date = DATE '2026-05-27' AND cohort = 'A';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 cohort A check-in on the cancelled day, found %', n;
  END IF;

  -- --- days only one cohort met --------------------------------------------
  -- 28 May: A only. B and C must end up with no session that day, which is
  -- exactly what the current Tue/Wed/Thu constant gets wrong.
  SELECT count(DISTINCT cohort) INTO n
  FROM public.present_students
  WHERE timestamp::date = DATE '2026-05-28';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 cohort meeting on 28 May, found %', n;
  END IF;

  -- --- scheduling tables ----------------------------------------------------
  SELECT count(*) INTO n FROM public.class_schedule;
  IF n <> 9 THEN
    RAISE EXCEPTION 'expected 9 class_schedule rows (3 cohorts x Tue/Wed/Thu), found %', n;
  END IF;

  -- Empty in production. The backfill's reconstruction path depends on it being
  -- empty here, so this is load-bearing, not incidental.
  SELECT count(*) INTO n FROM public.class_dates;
  IF n <> 0 THEN
    RAISE EXCEPTION 'class_dates must be empty in the fixture, found % rows', n;
  END IF;

  -- --- the singleton --------------------------------------------------------
  SELECT count(*) INTO n FROM public.session_state;
  IF n <> 1 THEN
    RAISE EXCEPTION 'session_state must hold exactly one row, found %', n;
  END IF;

  SELECT count(*) INTO n FROM public.session_state WHERE id = 1;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the session_state row must be id = 1 (mark_attendance hardcodes it)';
  END IF;

  -- --- excused and flagged --------------------------------------------------
  SELECT count(*) INTO n FROM public.excused_absences;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 excused absence, found %', n;
  END IF;

  -- Excused on a day the cohort met and the student did not check in.
  SELECT count(*) INTO n
  FROM public.excused_absences e
  WHERE e.student_id = 'S002' AND e.date = DATE '2026-05-28'
    AND NOT EXISTS (
      SELECT 1 FROM public.present_students p
      WHERE p.student_id = e.student_id AND p.timestamp::date = e.date);
  IF n <> 1 THEN
    RAISE EXCEPTION 'the excused absence must fall on a met day with no check-in';
  END IF;

  SELECT count(*) INTO n FROM public.flagged WHERE status = 'accepted';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 accepted flag (it must become a present record), found %', n;
  END IF;

  -- --- report_settings is keyed on the cohort letter ------------------------
  -- The reason two classes cannot both have a Cohort A today.
  SELECT a.attname INTO t
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = 'public.report_settings'::regclass AND i.indisprimary;
  IF t <> 'cohort' THEN
    RAISE EXCEPTION 'report_settings primary key should be `cohort`, found `%`', t;
  END IF;

  RAISE NOTICE 'fixture assertions passed';
END $$;
