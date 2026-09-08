-- ============================================================================
-- 015 — retire the pre-class tables
--
-- Nothing in the app has read any of these since the live check-in path moved
-- to real sessions, and 014 stopped the last write. What is left is surface
-- area: a table holding a PIN column that anon can still SELECT, and six copies
-- of facts that now live somewhere else and can drift from them.
--
-- MOVED, NOT DROPPED. They go to a `legacy` schema. PostgREST exposes only
-- `public`, so from the application's point of view they cease to exist — no
-- REST route, no anon reach, nothing that can accidentally read them again —
-- while the rows survive if the reconciliation ever turns out to have been
-- wrong. Dropping the schema afterwards is one line, and can wait until a term
-- has passed without anyone needing it.
--
-- GATED ON THE RECONCILIATION. This refuses to move anything unless
-- v_bridge_reconciliation reports 0 unexplained check-ins — a legacy check-in
-- by a known student with no attendance record to account for it. There is no
-- flag to skip the check: if it is not clean, the answer is to find out why,
-- not to proceed.
--
--   Retired:  present_students, session_state, excused_absences,
--             cancelled_sessions, class_schedule, class_dates, report_settings
--
--   Kept:     students             the global person registry
--             flagged             still written by flag_attendance
--             canvas_row_mappings keyed on students, still used by the exporter
--
-- Run AFTER 014. Idempotent: re-running finds the tables already moved and
-- does nothing.
-- ============================================================================

DO $retire$
DECLARE
  v_unexplained integer;
  v_orphans     integer;
  v_moved       text[] := ARRAY[]::text[];
  t             text;
  legacy_tables text[] := ARRAY[
    'present_students', 'session_state', 'excused_absences',
    'cancelled_sessions', 'class_schedule', 'class_dates', 'report_settings'
  ];
BEGIN
  -- ---- the gate ------------------------------------------------------------
  -- Only meaningful while the view can still see present_students. On a re-run
  -- the tables have already moved and there is nothing left to check.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'present_students'
  ) THEN
    SELECT unexplained, orphan_checkins
      INTO v_unexplained, v_orphans
    FROM public.v_bridge_reconciliation;

    IF v_unexplained IS NULL THEN
      RAISE EXCEPTION
        'v_bridge_reconciliation returned nothing; refusing to retire anything';
    END IF;

    IF v_unexplained > 0 THEN
      RAISE EXCEPTION
        '% legacy check-in(s) have no attendance record to explain them. '
        'Retiring these tables would destroy the only evidence of them. '
        'Inspect v_bridge_reconciliation and resolve them first.', v_unexplained;
    END IF;

    RAISE NOTICE
      'reconciliation clean: 0 unexplained, % orphaned check-in(s) by students '
      'who are not in the registry at all', COALESCE(v_orphans, 0);
  END IF;

  -- ---- move ----------------------------------------------------------------
  CREATE SCHEMA IF NOT EXISTS legacy;

  -- Never reachable through PostgREST, and never through a client role.
  REVOKE ALL ON SCHEMA legacy FROM anon, authenticated;

  FOREACH t IN ARRAY legacy_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      -- The anon read policy on session_state existed so the public page could
      -- render a countdown from the singleton. That page reads
      -- get_open_session_summary now.
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', t);
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA legacy;', t);
      v_moved := v_moved || t;
    END IF;
  END LOOP;

  IF array_length(v_moved, 1) IS NULL THEN
    RAISE NOTICE '015: nothing to retire — already done';
  ELSE
    RAISE NOTICE '015: retired % table(s) to schema legacy: %',
      array_length(v_moved, 1), array_to_string(v_moved, ', ');
  END IF;
END
$retire$;

-- ----------------------------------------------------------------------------
-- v_bridge_reconciliation — follows the data it reconciles
--
-- Kept rather than dropped: it is the evidence that the migration was sound,
-- and it costs nothing. It now reads the retired table in its new home.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_bridge_reconciliation AS
WITH legacy AS (
  SELECT DISTINCT
         p.student_id,
         (p.timestamp AT TIME ZONE COALESCE(
            (SELECT timezone FROM public.classes ORDER BY created_at LIMIT 1),
            'Africa/Accra'))::date AS on_date
  FROM legacy.present_students p
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

REVOKE ALL ON public.v_bridge_reconciliation FROM anon;

COMMENT ON VIEW public.v_bridge_reconciliation IS
  'Evidence that the 005 backfill accounted for every legacy check-in. Reads '
  'legacy.present_students, which 015 moved out of public. unexplained must be '
  '0 before legacy is dropped for real.';

-- ----------------------------------------------------------------------------
-- get_student_attendance — stop deriving four keys from tables that are gone
--
-- 006 kept `present`, `cancelled` and `excused` so StudentDashboard did not
-- have to change on the same day, and added `sessions` as the replacement. The
-- screen has read `sessions` since it was ported; the other three have been
-- computed and thrown away on every call since, and now reference tables that
-- are no longer in `public`.
--
-- `flagged` stays: flag_attendance still writes it, and the screen still shows
-- whether a day has been queried.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('session_date', f.session_date, 'status', f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb),
    -- Cancelled sessions are included and labelled, so the screen can show
    -- "no class" instead of silently omitting the day.
    'sessions', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_id',   s.id,
                 'date',         s.session_date,
                 'class',        k.name,
                 'class_code',   k.code,
                 'cohort',       co.label,
                 'status',       s.status,
                 'state',        ar.state,
                 'marked_at',    ar.marked_at)
               ORDER BY s.session_date DESC)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      JOIN public.classes k  ON k.id  = s.class_id
      JOIN public.enrolments e
        ON e.cohort_id = s.cohort_id
       AND e.student_id = p_student_id
       AND e.enrolled_on <= s.session_date
       AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date)
      LEFT JOIN public.attendance_records ar
        ON ar.session_id = s.id AND ar.student_id = p_student_id
      WHERE s.status <> 'scheduled'), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_student_attendance(text) IS
  'One student''s attendance, as stored: every session their cohorts held, with '
  'the state recorded against it, plus any days they have flagged.';

-- ----------------------------------------------------------------------------
-- delete_class — stop reaching into a table that is no longer in public
--
-- 012 cleared present_students and flagged by hand when it deleted a student,
-- because neither has a foreign key to `students` and so nothing cascades into
-- them. flagged still needs that. present_students does not: it has no reader,
-- and the function would now fail at call time on a table that is not in
-- `public` — which would take class deletion down with it.
--
-- Rows left behind in legacy.present_students for a deleted student show up as
-- `orphan_checkins` in the reconciliation, never as `unexplained`: that column
-- only counts check-ins by a student who still exists. The historical record
-- is left intact rather than quietly pruned.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_class(
  p_class_id                 uuid,
  p_confirm_code             text,
  p_delete_orphaned_students boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_summary  jsonb;
  v_students integer := 0;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to delete this class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF lower(btrim(COALESCE(p_confirm_code, ''))) <> lower(btrim(v_class.code)) THEN
    RAISE EXCEPTION
      'confirmation does not match: type the class code (%) exactly', v_class.code;
  END IF;

  v_summary := public.preview_class_deletion(p_class_id);

  -- Captured before the delete: the cascade takes the enrolments, and with
  -- them the only record of who was in this class.
  DROP TABLE IF EXISTS tmp_orphans;
  CREATE TEMP TABLE tmp_orphans ON COMMIT DROP AS
  SELECT DISTINCT e.student_id
  FROM public.enrolments e
  WHERE e.class_id = p_class_id
    AND NOT EXISTS (
      SELECT 1 FROM public.enrolments o
      WHERE o.student_id = e.student_id AND o.class_id <> p_class_id);

  DELETE FROM public.classes WHERE id = p_class_id;

  IF p_delete_orphaned_students THEN
    -- flagged has no foreign key to students, so nothing cascades into it.
    DELETE FROM public.flagged f
     USING tmp_orphans o WHERE f.student_id = o.student_id;

    WITH gone AS (
      DELETE FROM public.students s
       USING tmp_orphans o
       WHERE s.student_id = o.student_id
         AND NOT EXISTS (
           SELECT 1 FROM public.enrolments e WHERE e.student_id = s.student_id)
      RETURNING 1
    )
    SELECT count(*) INTO v_students FROM gone;
  END IF;

  DROP TABLE IF EXISTS tmp_orphans;

  RETURN jsonb_build_object(
    'deleted',          true,
    'students_deleted', v_students,
    'summary',          v_summary
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_class(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_class(uuid, text, boolean) TO authenticated;
