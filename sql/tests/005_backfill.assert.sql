-- ============================================================================
-- Migration 005 — the backfill
--
-- This is the migration that touches real data, so these assertions are about
-- the numbers rather than the shapes. Every expected value below is derived by
-- hand from 00_legacy_fixture.sql; if the fixture changes, these must be
-- recomputed rather than adjusted until they pass.
--
-- The fixture holds, per cohort:
--   A (S001, S002) met 19, 20, 21, 26, 28 May; 27 May cancelled for A only
--   B (S003, S004) met 19, 20, 21, 26, 27 May
--   C (S005, S006) met 19, 26 May, plus 21 May recovered from an upheld dispute
--
-- Check-ins by student-day, after collapsing S001's duplicate on the 19th:
--   S001 19,20,21,27,28   S002 19,21,26   S003 19,20,26,27
--   S004 21,27            S005 19,26      S999 19 (orphan, not on the roster)
--
-- S001's 27 May check-in lands on a session that was cancelled. It is kept: the
-- class was called off after they marked, and cancel_session() preserves present
-- rows for exactly that reason.
-- ============================================================================

DO $assert$
DECLARE
  v_class uuid;
  v_a     uuid;
  v_b     uuid;
  v_c     uuid;
  n       bigint;
  st      public.session_status;
  rec     record;
BEGIN
  -- --------------------------------------------------------------------------
  -- The class itself
  -- --------------------------------------------------------------------------
  SELECT id INTO v_class FROM public.classes WHERE code = 'INTRO-AI';
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'the backfill did not create the class';
  END IF;

  SELECT count(*) INTO n FROM public.classes WHERE code = 'INTRO-AI';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the backfill ran twice: % classes exist', n;
  END IF;

  -- The term spans the data, and does not end before today, or the class would
  -- be born expired and generate no future sessions.
  SELECT count(*) INTO n
  FROM public.classes
  WHERE id = v_class
    AND term_starts_on = DATE '2026-05-19'
    AND term_ends_on >= CURRENT_DATE;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the term does not span the data';
  END IF;

  -- --------------------------------------------------------------------------
  -- Cohorts and enrolments
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.cohorts WHERE class_id = v_class;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 cohorts, found %', n;
  END IF;

  -- C is the letter the README's CHECK constraint would have rejected. If the
  -- backfill ever loses it, it is because someone reintroduced that constraint.
  SELECT id INTO v_c FROM public.cohorts WHERE class_id = v_class AND label = 'C';
  IF v_c IS NULL THEN
    RAISE EXCEPTION 'cohort C was not migrated';
  END IF;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  SELECT count(*) INTO n FROM public.enrolments WHERE class_id = v_class;
  IF n <> 6 THEN
    RAISE EXCEPTION 'expected 6 enrolments, found %', n;
  END IF;

  -- The nameless student is still enrolled: a missing name is not a missing
  -- person, and the roster upload later fills it in rather than skipping them.
  SELECT count(*) INTO n
  FROM public.enrolments e JOIN public.students s ON s.student_id = e.student_id
  WHERE e.class_id = v_class AND s.name IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'the student with no name was not enrolled';
  END IF;

  -- Everyone is enrolled from the start of term. Dating them from today would
  -- make close_session treat every historical session as before their time.
  SELECT count(*) INTO n
  FROM public.enrolments WHERE class_id = v_class AND enrolled_on > DATE '2026-05-19';
  IF n <> 0 THEN
    RAISE EXCEPTION '% enrolments start after the first session', n;
  END IF;

  -- --------------------------------------------------------------------------
  -- Sessions
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO n FROM public.class_sessions WHERE class_id = v_class;
  IF n <> 14 THEN
    RAISE EXCEPTION 'expected 14 reconstructed sessions, found %', n;
  END IF;

  SELECT count(*) INTO n FROM public.class_sessions WHERE cohort_id = v_a;
  IF n <> 6 THEN
    RAISE EXCEPTION 'cohort A should have 6 sessions (5 met + 1 cancelled), found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.class_sessions WHERE cohort_id = v_b;
  IF n <> 5 THEN
    RAISE EXCEPTION 'cohort B should have 5 sessions, found %', n;
  END IF;
  -- 19 and 26 from check-ins, 21 recovered from the upheld dispute.
  SELECT count(*) INTO n FROM public.class_sessions WHERE cohort_id = v_c;
  IF n <> 3 THEN
    RAISE EXCEPTION 'cohort C should have 3 sessions, found %', n;
  END IF;

  -- Session dates round-trip through the class timezone rather than drifting.
  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE class_id = v_class
    AND session_date <> (starts_at AT TIME ZONE 'Africa/Accra')::date;
  IF n <> 0 THEN
    RAISE EXCEPTION '% sessions have a session_date that disagrees with starts_at', n;
  END IF;

  -- ---- the per-cohort cancellation ----------------------------------------
  -- The bug this whole model exists to foreclose: cancelled_sessions is keyed
  -- (date, cohort), but the weekly report matches on date alone, so cancelling
  -- cohort A's Wednesday cancels everybody's.
  SELECT status INTO st
  FROM public.class_sessions WHERE cohort_id = v_a AND session_date = DATE '2026-05-27';
  IF st IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'cohort A''s 27 May session should be cancelled, is %', st;
  END IF;

  SELECT status INTO st
  FROM public.class_sessions WHERE cohort_id = v_b AND session_date = DATE '2026-05-27';
  IF st IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION
      'cohort B''s 27 May session should have survived cohort A''s cancellation, is %', st;
  END IF;

  -- Nobody is marked ABSENT for a class that never ran...
  SELECT count(*) INTO n
  FROM public.attendance_records ar
  JOIN public.class_sessions s ON s.id = ar.session_id
  WHERE s.status = 'cancelled' AND ar.state IN ('unexcused', 'pending');
  IF n <> 0 THEN
    RAISE EXCEPTION '% absences were written against a cancelled session', n;
  END IF;

  -- ...but someone who marked before it was called off keeps their record.
  -- Dropping it would contradict cancel_session() and lose real attendance.
  SELECT count(*) INTO n
  FROM public.attendance_records ar
  JOIN public.class_sessions s ON s.id = ar.session_id
  WHERE s.status = 'cancelled' AND ar.state = 'present';
  IF n <> 1 THEN
    RAISE EXCEPTION
      'expected 1 present record on the cancelled session, found % — a check-in was lost', n;
  END IF;

  -- --------------------------------------------------------------------------
  -- Records
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE class_id = v_class AND state = 'present';
  IF n <> 17 THEN     -- 16 check-in days + 1 upheld dispute
    RAISE EXCEPTION 'expected 17 present records, found %', n;
  END IF;

  -- The duplicate check-in collapsed to one record.
  SELECT count(*) INTO n
  FROM public.attendance_records ar
  JOIN public.class_sessions s ON s.id = ar.session_id
  WHERE ar.student_id = 'S001' AND s.session_date = DATE '2026-05-19';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the duplicate same-day check-in produced % records', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.attendance_records WHERE class_id = v_class AND state = 'excused';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected 1 excused record, found %', n;
  END IF;

  -- The whole point: absence exists as rows now.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE class_id = v_class AND state = 'unexcused';
  IF n <> 9 THEN
    RAISE EXCEPTION 'expected 9 unexcused records, found %', n;
  END IF;

  -- Every session of a cohort covers every enrolled member of it, exactly once.
  FOR rec IN
    SELECT s.id AS session_id, s.session_date, co.label,
           (SELECT count(*) FROM public.enrolments e WHERE e.cohort_id = s.cohort_id) AS enrolled,
           (SELECT count(*) FROM public.attendance_records ar WHERE ar.session_id = s.id) AS records
    FROM public.class_sessions s
    JOIN public.cohorts co ON co.id = s.cohort_id
    WHERE s.class_id = v_class AND s.status <> 'cancelled'
  LOOP
    IF rec.records <> rec.enrolled THEN
      RAISE EXCEPTION
        'cohort % on % has % enrolled but % records — every member should have exactly one',
        rec.label, rec.session_date, rec.enrolled, rec.records;
    END IF;
  END LOOP;

  -- Nobody is both present and absent on the same day, which is what using the
  -- roster cohort rather than the check-in cohort prevents.
  SELECT count(*) INTO n
  FROM (
    SELECT ar.student_id, s.session_date
    FROM public.attendance_records ar
    JOIN public.class_sessions s ON s.id = ar.session_id
    WHERE s.class_id = v_class
    GROUP BY ar.student_id, s.session_date
    HAVING count(*) > 1
  ) dupes;
  IF n <> 0 THEN
    RAISE EXCEPTION '% student-days carry more than one record', n;
  END IF;

  -- The orphan check-in was not invented into existence.
  SELECT count(*) INTO n
  FROM public.attendance_records WHERE student_id = 'S999';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a record was created for a student who is not on the roster';
  END IF;

  -- --------------------------------------------------------------------------
  -- Report settings, re-keyed off the cohort letter
  -- --------------------------------------------------------------------------
  SELECT count(*) INTO n
  FROM public.cohort_report_settings WHERE class_id = v_class;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 re-keyed report settings, found %', n;
  END IF;

  SELECT count(*) INTO n
  FROM public.cohort_report_settings crs
  JOIN public.cohorts co ON co.id = crs.cohort_id
  WHERE co.label = 'C' AND crs.instructor_name = 'Prof. Antwi';
  IF n <> 1 THEN
    RAISE EXCEPTION 'cohort C''s instructor did not survive the re-key';
  END IF;

  -- --------------------------------------------------------------------------
  -- Reconstructed sessions must not be duplicated by a later generate
  --
  -- Last, because it writes: generating over the whole term legitimately adds
  -- sessions for the months after the final check-in, which would break every
  -- count above.
  --
  -- The invariant is not "creates nothing" — over the backfilled fortnight it
  -- correctly adds the four days a cohort was scheduled but has no evidence of
  -- meeting. It is that no cohort ends up with two sessions on one date, which
  -- holds only because the backfill placed its sessions at the same 09:00 the
  -- schedule uses.
  -- --------------------------------------------------------------------------
  PERFORM public.generate_sessions(v_class, NULL, DATE '2026-05-19', DATE '2026-05-28');

  SELECT count(*) INTO n
  FROM (
    SELECT cohort_id, session_date
    FROM public.class_sessions
    WHERE class_id = v_class
    GROUP BY cohort_id, session_date
    HAVING count(*) > 1
  ) d;
  IF n <> 0 THEN
    RAISE EXCEPTION '% cohort-days ended up with more than one session', n;
  END IF;

  -- The 14 reconstructed ones are still exactly the closed and cancelled rows;
  -- anything generate_sessions added is 'scheduled' and clearly distinguishable.
  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE class_id = v_class AND status IN ('closed', 'cancelled');
  IF n <> 14 THEN
    RAISE EXCEPTION 'the 14 reconstructed sessions became %', n;
  END IF;

  RAISE NOTICE '005 backfill assertions passed';
END
$assert$;

-- ----------------------------------------------------------------------------
-- The reconciliation gate
--
-- migration 008 must not run until unexplained reads 0 against production.
-- ----------------------------------------------------------------------------

DO $reconcile$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.v_bridge_reconciliation;

  -- 17 distinct student-days in the fixture, including the orphan.
  IF r.legacy_unique_checkins <> 17 THEN
    RAISE EXCEPTION 'expected 17 legacy check-in days, view reports %',
      r.legacy_unique_checkins;
  END IF;

  IF r.orphan_checkins <> 1 THEN
    RAISE EXCEPTION 'expected 1 orphan check-in, view reports %', r.orphan_checkins;
  END IF;

  -- The gate itself: every check-in by a real student produced a present or
  -- late record.
  IF r.unexplained <> 0 THEN
    RAISE EXCEPTION
      '% legacy check-in(s) produced no attendance record — the backfill lost data',
      r.unexplained;
  END IF;

  RAISE NOTICE '005 reconciliation clean: % legacy days, % migrated, % orphaned',
    r.legacy_unique_checkins, r.migrated_present, r.orphan_checkins;
END
$reconcile$;
