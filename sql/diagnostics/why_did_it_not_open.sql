-- ============================================================================
-- Why did that session not open by itself?
--
-- READ ONLY. Selects and nothing else. Safe to paste into the Supabase SQL
-- editor against a live project.
--
-- Migration 031 opens a session only when ALL of these hold:
--
--   status = 'scheduled'
--   now() >= starts_at - early_open_minutes
--   now() <= starts_at + auto_close_minutes
--
-- Each row below says which of those is false, so "auto-open is broken" becomes
-- a specific reason. The commonest answers are that the session was cancelled
-- or already closed, or that the chance has simply passed — on the defaults it
-- is about a twenty-minute span around the start time.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Is the sweep installed at all, and is anything scheduling it?
-- ----------------------------------------------------------------------------
SELECT
  to_regprocedure('public.sync_sessions()')      IS NOT NULL AS has_sync_sessions,
  to_regprocedure('public.open_due_sessions()')  IS NOT NULL AS has_open_due,
  to_regprocedure('public.close_due_sessions()') IS NOT NULL AS has_close_due,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS pg_cron_installed,
  now() AS server_time_utc;

-- If pg_cron_installed is true, this lists the job. An empty result means the
-- sweep only runs when a dashboard is open, which is enough for opening and is
-- NOT enough for closing — closing is what records the absences.
SELECT jobid, schedule, command, active
FROM cron.job
WHERE jobname = 'sync-sessions';

-- ----------------------------------------------------------------------------
-- 2. Every session today, and what the sweep thinks of it
-- ----------------------------------------------------------------------------
SELECT
  k.code                                   AS class,
  co.label                                 AS cohort,
  s.starts_at AT TIME ZONE k.timezone      AS starts_local,
  s.status,
  s.early_open_minutes                     AS early,
  s.auto_close_minutes                     AS auto_close,
  s.starts_at - make_interval(mins => COALESCE(s.early_open_minutes, 0))
                                           AS auto_open_from,
  s.starts_at + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
                                           AS auto_open_until,
  CASE
    WHEN s.status = 'cancelled'
      THEN 'no — cancelled, and the sweep never touches a cancelled session'
    WHEN s.status = 'closed'
      THEN 'no — already closed'
    WHEN s.status = 'open'
      THEN 'already open'
    WHEN now() < s.starts_at - make_interval(mins => COALESCE(s.early_open_minutes, 0))
      THEN 'not yet — too early, waiting for the early-open moment'
    WHEN now() > s.starts_at + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
      THEN 'no — the chance has passed, only opening it by hand will work now'
    ELSE 'YES — this should open on the next sweep, within a minute'
  END                                      AS would_open_now
FROM public.class_sessions s
JOIN public.cohorts co ON co.id = s.cohort_id
JOIN public.classes k  ON k.id  = s.class_id
WHERE s.session_date = (now() AT TIME ZONE k.timezone)::date
ORDER BY s.starts_at, co.label;

-- ----------------------------------------------------------------------------
-- 3. Anything the sweep would open right now, across every class
--
-- This is exactly the query inside open_due_sessions. An empty result means the
-- function is doing the right thing and there is genuinely nothing eligible —
-- which is the answer worth having before assuming the code is wrong.
-- ----------------------------------------------------------------------------
SELECT s.id, s.starts_at, s.status, s.early_open_minutes, s.auto_close_minutes
FROM public.class_sessions s
WHERE s.status = 'scheduled'
  AND now() >= s.starts_at - make_interval(mins => COALESCE(s.early_open_minutes, 0))
  AND now() <= s.starts_at + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
ORDER BY s.starts_at;

-- ----------------------------------------------------------------------------
-- 4. Is realtime actually publishing the two tables?
--
-- A missing row here is why the dashboard would not update on its own. The
-- client cannot tell: it subscribes, reports success, and no event ever comes.
-- ----------------------------------------------------------------------------
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND schemaname = 'public'
  AND tablename IN ('attendance_records', 'class_sessions')
ORDER BY tablename;
