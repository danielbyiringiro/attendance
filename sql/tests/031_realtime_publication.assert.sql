-- ============================================================================
-- 030 — the dashboard can actually be told about a check-in
--
-- This is worth asserting rather than eyeballing because the failure is
-- invisible. A Supabase client subscribing to a table that is not in the
-- publication connects, reports SUBSCRIBED, and then simply never receives an
-- event. There is no error to notice. The dashboard would look exactly like it
-- does today — correct on load, frozen afterwards — and the bug would read as
-- "realtime is flaky" rather than "the table was never published".
--
-- The harness runs Postgres with wal_level=logical for this file's sake. On the
-- default setting CREATE PUBLICATION succeeds with a warning and streams
-- nothing, which would make every assertion below pass while proving nothing.
-- ============================================================================

DO $$
DECLARE
  missing text[];
  bad_identity text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    RAISE EXCEPTION
      '030: the supabase_realtime publication does not exist, so nothing is streamed at all';
  END IF;

  -- Both tables, named individually. attendance_records carries the check-ins;
  -- class_sessions carries the PIN, the window and the status the buttons read.
  SELECT array_agg(t ORDER BY t) INTO missing
  FROM unnest(ARRAY['attendance_records', 'class_sessions']) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = t
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      '030: not published, so a subscriber would connect and hear nothing: %',
      array_to_string(missing, ', ');
  END IF;

  -- REPLICA IDENTITY FULL, or a DELETE arrives carrying only its primary key
  -- and the client's class_id filter discards it. 'f' is FULL in pg_class.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO bad_identity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('attendance_records', 'class_sessions')
    AND c.relreplident <> 'f';

  IF bad_identity IS NOT NULL THEN
    RAISE EXCEPTION
      '030: replica identity is not FULL, so filtered deletes go missing: %',
      array_to_string(bad_identity, ', ');
  END IF;

  -- FOR ALL TABLES would stream the whole database, including the staff table
  -- and anything added later, with nobody having decided that.
  IF EXISTS (
    SELECT 1 FROM pg_publication
    WHERE pubname = 'supabase_realtime' AND puballtables
  ) THEN
    RAISE EXCEPTION
      '030: the publication is FOR ALL TABLES — every table is streamed, which nobody chose';
  END IF;

  RAISE NOTICE '030 ok: attendance_records and class_sessions are streamed, and only those';
END $$;
