-- ============================================================================
-- 005 — backfill the existing data into a real class
--
-- The first migration that touches rows you already have. Everything before it
-- only added empty tables.
--
-- It reconstructs sessions from the dates people checked in on. That is the
-- exact heuristic the rest of this work exists to abolish — "somebody marked,
-- therefore a class happened" — and it is used here ONCE, to rebuild a past
-- that was never recorded properly, and never again. Every session created from
-- now on is a row that exists before anyone checks in.
--
-- What it cannot do: recover a class day where nobody checked in at all. There
-- is no trace of such a day anywhere in the old schema. Cancelled days and days
-- someone was excused on are recovered, because those left records. Anything
-- else has to be added by hand afterwards, which is why the class page will
-- show the reconstructed session list for review.
--
-- Run AFTER 004. Idempotent: it does nothing if the class below already exists.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EDIT ME before running
-- ----------------------------------------------------------------------------
--   code      a short unique handle; you type this back to confirm a deletion
--   name      what the TA sees
--   timezone  the wall clock the class actually meets on
--   start     nominal start time for reconstructed sessions. The old data has
--             no session times, so this is a stand-in. It matches the schedule
--             created below, which is what stops a later "generate sessions"
--             from producing a second session on every historical day.
-- ----------------------------------------------------------------------------

DO $backfill$
DECLARE
  -- ---- configuration -------------------------------------------------------
  c_code     text := 'INTRO-AI';
  c_name     text := 'Introduction to AI';
  c_timezone text := 'Africa/Accra';
  c_start    time := TIME '09:00';
  c_weekdays smallint[] := ARRAY[2, 3, 4]::smallint[];   -- Tue, Wed, Thu
  -- --------------------------------------------------------------------------

  v_class     uuid;
  v_first     date;
  v_last      date;
  n_cohorts   bigint;
  n_enrolled  bigint;
  n_sessions  bigint;
  n_cancelled bigint;
  n_present   bigint;
  n_excused   bigint;
  n_flag      bigint;
  n_absent    bigint;
  n_orphan    bigint;
BEGIN
  -- Idempotency for a data migration is "have I already run", not
  -- CREATE IF NOT EXISTS. Re-running must not double the roster.
  SELECT id INTO v_class FROM public.classes WHERE lower(btrim(code)) = lower(c_code);
  IF v_class IS NOT NULL THEN
    RAISE NOTICE 'class % already exists — backfill skipped', c_code;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students) THEN
    RAISE NOTICE 'no legacy students — nothing to backfill';
    RETURN;
  END IF;

  -- ---- the class -----------------------------------------------------------
  -- Term spans the data. The end is pushed to today when the last check-in is
  -- in the past, so the class is not born already expired.
  SELECT COALESCE(min((timestamp AT TIME ZONE c_timezone)::date), CURRENT_DATE)
    INTO v_first
  FROM public.present_students;

  SELECT GREATEST(
           COALESCE(max((timestamp AT TIME ZONE c_timezone)::date), CURRENT_DATE),
           CURRENT_DATE)
    INTO v_last
  FROM public.present_students;

  INSERT INTO public.classes (code, name, description, term_starts_on, term_ends_on, timezone)
  VALUES (c_code, c_name,
          'Migrated from the single-class check-in data by migration 005.',
          v_first, v_last, c_timezone)
  RETURNING id INTO v_class;

  -- ---- cohorts -------------------------------------------------------------
  -- Straight from whatever letters the roster actually uses, which picks up 'C'
  -- — the value the README's `check (cohort in ('A','B'))` would have rejected.
  INSERT INTO public.cohorts (class_id, label)
  SELECT DISTINCT v_class, upper(btrim(s.cohort))
  FROM public.students s
  WHERE btrim(COALESCE(s.cohort, '')) <> ''
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n_cohorts = ROW_COUNT;

  -- ---- schedule ------------------------------------------------------------
  -- The hardcoded Tue/Wed/Thu constant, finally written down as data.
  INSERT INTO public.cohort_schedules (class_id, cohort_id, weekday, start_time)
  SELECT v_class, co.id, w, c_start
  FROM public.cohorts co, unnest(c_weekdays) w
  WHERE co.class_id = v_class
  ON CONFLICT DO NOTHING;

  -- ---- enrolments ----------------------------------------------------------
  -- enrolled_on is the start of term: the old schema never recorded when anyone
  -- joined, and dating them from today would make close_session treat every
  -- historical session as one they were not enrolled for.
  INSERT INTO public.enrolments (class_id, cohort_id, student_id, enrolled_on)
  SELECT v_class, co.id, s.student_id, v_first
  FROM public.students s
  JOIN public.cohorts co
    ON co.class_id = v_class AND co.label = upper(btrim(s.cohort))
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS n_enrolled = ROW_COUNT;

  -- ---- sessions ------------------------------------------------------------
  --
  -- Four sources, unioned. A check-in proves a class ran; a cancellation row
  -- proves one was meant to; an excusal proves one the student was let off; an
  -- upheld dispute proves one a TA agreed the student attended.
  --
  -- Cohort comes from the student's ENROLMENT, not from present_students.cohort.
  -- That column is a copy taken at check-in time and can disagree with the
  -- roster — the misfiled-student problem. Using the roster keeps every record's
  -- student enrolled in the session's cohort, so nobody ends up both present at
  -- one cohort's session and absent from another's on the same day.
  CREATE TEMP TABLE tmp_sessions ON COMMIT DROP AS
  WITH from_checkins AS (
    SELECT e.cohort_id, (p.timestamp AT TIME ZONE c_timezone)::date AS on_date
    FROM public.present_students p
    JOIN public.enrolments e
      ON e.student_id = p.student_id AND e.class_id = v_class
  ),
  from_cancellations AS (
    SELECT co.id AS cohort_id, cs.date AS on_date
    FROM public.cancelled_sessions cs
    JOIN public.cohorts co
      ON co.class_id = v_class AND co.label = upper(btrim(cs.cohort))
    WHERE cs.is_cancelled
  ),
  from_excusals AS (
    SELECT e.cohort_id, ea.date AS on_date
    FROM public.excused_absences ea
    JOIN public.enrolments e
      ON e.student_id = ea.student_id AND e.class_id = v_class
    -- The app already filters an excusal range down to class days, so this only
    -- guards against anything written directly to the table.
    WHERE EXTRACT(DOW FROM ea.date)::smallint = ANY (c_weekdays)
  ),
  from_accepted_flags AS (
    -- An accepted dispute is a TA stating the student attended, which is itself
    -- evidence the class ran. Without this source, a day whose only trace is an
    -- upheld dispute is lost, and the student's own accepted record with it.
    SELECT e.cohort_id, f.session_date AS on_date
    FROM public.flagged f
    JOIN public.enrolments e
      ON e.student_id = f.student_id AND e.class_id = v_class
    WHERE f.status = 'accepted'
  )
  SELECT DISTINCT cohort_id, on_date
  FROM (
    SELECT * FROM from_checkins
    UNION SELECT * FROM from_cancellations
    UNION SELECT * FROM from_excusals
    UNION SELECT * FROM from_accepted_flags
  ) u;

  INSERT INTO public.class_sessions (
    cohort_id, starts_at, session_date, status, notes
  )
  SELECT
    t.cohort_id,
    (t.on_date + c_start) AT TIME ZONE c_timezone,
    t.on_date,
    'closed',
    'Reconstructed from legacy data by migration 005'
  FROM tmp_sessions t
  ON CONFLICT (cohort_id, starts_at) DO NOTHING;

  GET DIAGNOSTICS n_sessions = ROW_COUNT;

  -- ---- cancellations -------------------------------------------------------
  -- Honours the cohort column, which buildWeeklyReport ignores: today
  -- cancelling cohort A's Wednesday silently cancels B's and C's too.
  WITH cancelled AS (
    UPDATE public.class_sessions s
       SET status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = 'Cancelled in the legacy schedule'
    FROM public.cancelled_sessions cs
    JOIN public.cohorts co
      ON co.class_id = v_class AND co.label = upper(btrim(cs.cohort))
    WHERE s.cohort_id = co.id
      AND s.session_date = cs.date
      AND cs.is_cancelled
    RETURNING 1
  )
  SELECT count(*) INTO n_cancelled FROM cancelled;

  -- ---- present -------------------------------------------------------------
  -- DISTINCT ON collapses the duplicate same-day check-ins the old table has no
  -- constraint against, keeping the earliest.
  WITH first_checkin AS (
    SELECT DISTINCT ON (p.student_id, (p.timestamp AT TIME ZONE c_timezone)::date)
           p.student_id,
           (p.timestamp AT TIME ZONE c_timezone)::date AS on_date,
           p.timestamp AS marked_at
    FROM public.present_students p
    ORDER BY p.student_id,
             (p.timestamp AT TIME ZONE c_timezone)::date,
             p.timestamp ASC
  ),
  inserted AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role, method_used
    )
    SELECT s.id, v_class, f.student_id, 'present', f.marked_at, 'student', 'fixed_code'
    FROM first_checkin f
    JOIN public.enrolments e
      ON e.student_id = f.student_id AND e.class_id = v_class
    JOIN public.class_sessions s
      ON s.cohort_id = e.cohort_id AND s.session_date = f.on_date
    -- Cancelled sessions included on purpose. Somebody marked before the class
    -- was called off, and cancel_session() keeps present rows for exactly that
    -- reason; dropping them here would contradict the runtime rule and silently
    -- lose attendance.
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_present FROM inserted;

  -- ---- excused -------------------------------------------------------------
  WITH inserted AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, v_class, ea.student_id, 'excused',
           COALESCE(ea.created_at, now()), 'staff'
    FROM public.excused_absences ea
    JOIN public.enrolments e
      ON e.student_id = ea.student_id AND e.class_id = v_class
    JOIN public.class_sessions s
      ON s.cohort_id = e.cohort_id AND s.session_date = ea.date
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_excused FROM inserted;

  -- ---- accepted disputes ---------------------------------------------------
  -- A TA already agreed these students were present. Inserted after the present
  -- pass so a real check-in wins, and before the absent pass so it is not
  -- overwritten by one.
  WITH inserted AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, v_class, f.student_id, 'present', COALESCE(f.created_at, now()), 'staff'
    FROM public.flagged f
    JOIN public.enrolments e
      ON e.student_id = f.student_id AND e.class_id = v_class
    JOIN public.class_sessions s
      ON s.cohort_id = e.cohort_id AND s.session_date = f.session_date
    WHERE f.status = 'accepted'
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_flag FROM inserted;

  -- ---- absence, written down for the first time ----------------------------
  -- Everyone enrolled in a session's cohort with no record yet. This is the
  -- number the app has been recomputing in the browser on every render.
  WITH inserted AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, v_class, e.student_id, 'unexcused', now(), 'system'
    FROM public.class_sessions s
    JOIN public.enrolments e
      ON e.cohort_id = s.cohort_id
     AND e.enrolled_on <= s.session_date
     AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date)
    WHERE s.class_id = v_class
      -- The one pass that DOES skip cancellations: a class that never ran
      -- cannot produce an absence. Mirrors cancel_session(), which deletes
      -- unexcused rows and leaves present ones alone.
      AND s.status <> 'cancelled'
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_absent FROM inserted;

  -- ---- report settings -----------------------------------------------------
  -- report_settings has `cohort` as its PRIMARY KEY, so two classes can never
  -- both have a Cohort A. Copied into a table keyed by cohort_id instead; the
  -- original is left untouched until 008 retires it.
  CREATE TABLE IF NOT EXISTS public.cohort_report_settings (
    cohort_id       uuid PRIMARY KEY REFERENCES public.cohorts(id) ON DELETE CASCADE,
    class_id        uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    instructor_name text DEFAULT '',
    fi_name         text DEFAULT '',
    updated_at      timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO public.cohort_report_settings (cohort_id, class_id, instructor_name, fi_name)
  SELECT co.id, v_class, COALESCE(rs.instructor_name, ''), COALESCE(rs.fi_name, '')
  FROM public.report_settings rs
  JOIN public.cohorts co
    ON co.class_id = v_class AND co.label = upper(btrim(rs.cohort))
  ON CONFLICT (cohort_id) DO NOTHING;

  -- ---- what could not be migrated -----------------------------------------
  SELECT count(*) INTO n_orphan
  FROM public.present_students p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = p.student_id AND e.class_id = v_class);

  RAISE NOTICE 'backfilled % into class %', c_name, v_class;
  RAISE NOTICE '  cohorts %, enrolments %, sessions % (% cancelled)',
    n_cohorts, n_enrolled, n_sessions, n_cancelled;
  RAISE NOTICE '  records: % present, % excused, % from accepted disputes, % absent',
    n_present, n_excused, n_flag, n_absent;

  IF n_orphan > 0 THEN
    RAISE WARNING
      '% check-in row(s) belong to a student_id that is not on the roster and '
      'could not be migrated. They are listed by v_bridge_reconciliation.', n_orphan;
  END IF;
END
$backfill$;

-- ----------------------------------------------------------------------------
-- v_bridge_reconciliation
--
-- The gate on migration 008. Per legacy check-in, is there a record that
-- explains it? `unexplained` must read 0 before any legacy table is dropped.
--
-- Compared per row rather than by totals, because the migrated side legitimately
-- gains rows the old side never had — every absence, for a start.
-- ----------------------------------------------------------------------------

-- Guarded: migration 015 moves present_students into the `legacy` schema and
-- redefines this view to follow it. Re-running 005 afterwards must not put back
-- a definition that points at a table no longer in `public`.
DO $recon_view$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'present_students'
  ) THEN
    RAISE NOTICE
      'v_bridge_reconciliation left as migration 015 defined it — '
      'present_students has been retired out of public';
    RETURN;
  END IF;

  EXECUTE $recon_sql$
CREATE OR REPLACE VIEW public.v_bridge_reconciliation AS
WITH legacy AS (
  SELECT DISTINCT
         p.student_id,
         (p.timestamp AT TIME ZONE COALESCE(
            (SELECT timezone FROM public.classes ORDER BY created_at LIMIT 1),
            'Africa/Accra'))::date AS on_date
  FROM public.present_students p
),
migrated AS (
  SELECT ar.student_id, s.session_date AS on_date
  FROM public.attendance_records ar
  JOIN public.class_sessions s ON s.id = ar.session_id
  WHERE ar.state IN ('present', 'late')
)
SELECT
  (SELECT count(*) FROM legacy)                                   AS legacy_unique_checkins,
  (SELECT count(*) FROM migrated)                                 AS migrated_present,
  (SELECT count(*) FROM legacy l
     WHERE NOT EXISTS (SELECT 1 FROM public.students s
                       WHERE s.student_id = l.student_id))        AS orphan_checkins,
  (SELECT count(*) FROM legacy l
     WHERE EXISTS (SELECT 1 FROM public.students s
                   WHERE s.student_id = l.student_id)
       AND NOT EXISTS (SELECT 1 FROM migrated m
                       WHERE m.student_id = l.student_id
                         AND m.on_date = l.on_date))              AS unexplained;
  $recon_sql$;
END
$recon_view$;

COMMENT ON VIEW public.v_bridge_reconciliation IS
  'Gate on migration 008. unexplained must be 0 before any legacy table is '
  'dropped: it counts check-ins by a real student that produced no present or '
  'late record. orphan_checkins are check-ins by a student_id that is not on '
  'the roster at all and were never migratable.';

-- The old cohort-keyed table stays until 008; this is what replaces it.
DO $rls$
BEGIN
  IF to_regclass('public.cohort_report_settings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.cohort_report_settings ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS cohort_report_settings_scoped ON public.cohort_report_settings';
    EXECUTE 'CREATE POLICY cohort_report_settings_scoped ON public.cohort_report_settings '
            'FOR ALL TO authenticated '
            'USING (public.can_access_class(class_id)) '
            'WITH CHECK (public.can_access_class(class_id))';
    EXECUTE 'REVOKE ALL ON public.cohort_report_settings FROM anon';
  END IF;
END
$rls$;
