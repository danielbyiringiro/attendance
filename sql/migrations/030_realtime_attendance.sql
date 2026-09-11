-- ============================================================================
-- 030 — let the dashboard see a check-in arrive
--
-- THE PROBLEM
--
-- The attendance tab reads once, when it mounts. A TA watching a class fill up
-- sees the count from the moment they opened the page and nothing after it, so
-- the only way to know whether anyone has marked is to press refresh, and the
-- only way to know you need to press refresh is to press refresh.
--
-- The migration brief calls this out twice: §2.9 specifies a live roster
-- "updating automatically as students check in, with no manual refresh
-- required", and §3.5 lists the missing subscription as a direct blocker for
-- it. The stopgap this app replaced subscribed to its session table and got
-- this right; the rewrite dropped it and nothing replaced it. There is not one
-- `.channel(` anywhere in src/.
--
-- WHAT THIS DOES
--
-- Supabase only streams changes for tables in the `supabase_realtime`
-- publication. Subscribing a client to a table that is not in it fails
-- silently: the channel connects, reports SUBSCRIBED, and no event ever
-- arrives. So the client change is useless without this, and this is useless
-- without the client change.
--
-- Row-level security still applies to the stream. A TA receives events only
-- for rows they could have selected anyway, which since 008 means the classes
-- they are on. This does not widen anyone's access.
--
-- WHY class_sessions IS HERE TOO
--
-- Not only for the count. A session opened, closed or cancelled on one device
-- has to reach the same TA's other tab and their colleagues' dashboards — the
-- PIN, the window and the Open/Close buttons are all read off that row.
--
-- REPLICA IDENTITY
--
-- The client filters its subscription by class_id. For an INSERT or UPDATE,
-- Postgres sends the new row and the filter matches. For a DELETE it sends
-- only the primary key unless the table is FULL, so a deletion would be
-- filtered out and missed. These two tables are small and low-churn, so the
-- extra write-ahead log volume is not worth reasoning about; a dropped student
-- silently staying on screen is.
--
-- Run AFTER 029. Idempotent.
-- ============================================================================

-- Supabase creates this publication itself. A local Postgres has no such
-- thing, so create it empty and let the loop below fill it. FOR ALL TABLES is
-- deliberately NOT used: that would stream every table in the database.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['attendance_records', 'class_sessions'] LOOP
    -- ALTER PUBLICATION ... ADD TABLE errors if the table is already a member,
    -- and this file has to survive being run twice.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;

    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
  END LOOP;
END $$;

COMMENT ON TABLE public.attendance_records IS
  'One state per student per session, written once and read back — never '
  'recomputed. Streamed over realtime since 030, so a TA watching a class sees '
  'each check-in arrive; row-level security applies to the stream exactly as '
  'it does to a select.';
