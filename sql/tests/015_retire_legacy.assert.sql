-- ============================================================================
-- Migration 015 — the old tables are out of reach, and the data is not lost
--
-- Two things worth pinning: that nothing in `public` can still be reached by a
-- client role, and that the gate would actually have stopped an unclean
-- migration rather than being decoration.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Gone from public, present in legacy
-- ----------------------------------------------------------------------------

DO $moved$
DECLARE
  t text;
  retired text[] := ARRAY[
    'present_students', 'session_state', 'excused_absences',
    'cancelled_sessions', 'class_schedule', 'class_dates', 'report_settings'
  ];
BEGIN
  FOREACH t IN ARRAY retired LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE EXCEPTION
        'public.% survived retirement — PostgREST still exposes it', t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'legacy' AND table_name = t
    ) THEN
      RAISE EXCEPTION 'legacy.% is missing — the data was destroyed, not moved', t;
    END IF;
  END LOOP;
END
$moved$;

-- ----------------------------------------------------------------------------
-- The rows survived the move
-- ----------------------------------------------------------------------------

DO $data$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM legacy.present_students;
  IF n = 0 THEN
    RAISE EXCEPTION
      'legacy.present_students is empty; the fixture had check-ins, so the move lost them';
  END IF;
END
$data$;

-- ----------------------------------------------------------------------------
-- No client role can reach the schema
-- ----------------------------------------------------------------------------

DO $grants$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema = 'legacy'
    AND grantee IN ('anon', 'authenticated');
  IF n > 0 THEN
    RAISE EXCEPTION
      '% grant(s) on schema legacy still held by anon or authenticated', n;
  END IF;

  IF has_schema_privilege('anon', 'legacy', 'USAGE') THEN
    RAISE EXCEPTION 'anon can still USE schema legacy';
  END IF;
END
$grants$;

-- ----------------------------------------------------------------------------
-- The tables that were KEPT are still where the app expects them
-- ----------------------------------------------------------------------------

DO $kept$
DECLARE
  t text;
  kept text[] := ARRAY['students', 'flagged', 'canvas_row_mappings'];
BEGIN
  FOREACH t IN ARRAY kept LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE EXCEPTION
        'public.% was retired but is still used — students is the person '
        'registry, flagged is still written, canvas_row_mappings is still read', t;
    END IF;
  END LOOP;
END
$kept$;

-- ----------------------------------------------------------------------------
-- The reconciliation still answers, from the table's new home
-- ----------------------------------------------------------------------------

DO $recon$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.v_bridge_reconciliation;
  IF r.unexplained <> 0 THEN
    RAISE EXCEPTION
      'the reconciliation is no longer clean after retirement: % unexplained',
      r.unexplained;
  END IF;
  IF r.legacy_unique_checkins = 0 THEN
    RAISE EXCEPTION
      'the view reports no legacy check-ins, so it is not reading the moved table';
  END IF;
END
$recon$;

-- ----------------------------------------------------------------------------
-- get_student_attendance stopped deriving from the retired tables
-- ----------------------------------------------------------------------------

DO $rpc$
DECLARE r jsonb;
BEGIN
  r := public.get_student_attendance('S001');

  IF r ? 'present' OR r ? 'cancelled' OR r ? 'excused' THEN
    RAISE EXCEPTION
      'get_student_attendance still returns keys derived from retired tables: %',
      (SELECT jsonb_agg(k) FROM jsonb_object_keys(r) k);
  END IF;

  IF NOT (r ? 'sessions') OR NOT (r ? 'flagged') THEN
    RAISE EXCEPTION 'get_student_attendance lost a key the screen reads: %', r;
  END IF;
END
$rpc$;

-- ----------------------------------------------------------------------------
-- The dual-write really stopped
--
-- 006 wrote present_students alongside attendance_records so the old readers
-- kept working; 014 stopped it. Checked here because this file runs as
-- superuser, and the table now lives where a client role cannot follow.
-- ----------------------------------------------------------------------------

DO $bridge$
DECLARE
  v_legacy integer;
  v_recent integer;
BEGIN
  SELECT count(*) INTO v_legacy FROM legacy.present_students;

  SELECT count(*) INTO v_recent
  FROM legacy.present_students
  WHERE timestamp > now() - INTERVAL '1 minute';

  IF v_recent > 0 THEN
    RAISE EXCEPTION
      '% present_students row(s) were written during this run — mark_attendance '
      'is still dual-writing a table nothing reads', v_recent;
  END IF;

  IF v_legacy = 0 THEN
    RAISE EXCEPTION
      'legacy.present_students holds nothing; the fixture rows were lost';
  END IF;
END
$bridge$;

DO $done$ BEGIN RAISE NOTICE '015 retirement assertions passed'; END $done$;

ROLLBACK;
