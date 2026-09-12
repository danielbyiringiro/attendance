-- ============================================================================
-- What happened to the attendance records?
--
-- READ ONLY. Selects and nothing else. Safe against a live project.
--
-- Run this before changing anything. Two of the migrations in QOL_5 write or
-- delete attendance rows, and both do it in bulk:
--
--   031  close_due_sessions closes every session past its window and writes an
--        explicit 'unexcused' row for everyone who did not mark. Its FIRST run
--        would have swept every session left open from previous weeks at once.
--
--   032  cancel_session now deletes EVERY record against a cancelled session,
--        check-ins included, where before it kept them.
--
-- Neither is reversible by re-running anything, so the point of this file is to
-- see the size and shape of what changed before deciding what to do about it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Absences written by the system, by day
--
-- A single day with a spike far above the others is the signature of the first
-- sweep after 031 was applied: weeks of stale open sessions all closed within
-- the same minute. Normal operation writes these in small daily batches as
-- sessions close.
-- ----------------------------------------------------------------------------
SELECT
  date_trunc('day', a.marked_at)::date AS written_on,
  count(*)                             AS absences_written,
  count(DISTINCT a.session_id)         AS across_sessions,
  min(a.marked_at)                     AS first_at,
  max(a.marked_at)                     AS last_at
FROM public.attendance_records a
WHERE a.state = 'unexcused'
  AND a.marked_by_role = 'system'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;

-- ----------------------------------------------------------------------------
-- 2. The same thing, minute by minute, for the worst day
--
-- If a few hundred rows share one minute, they were written by one sweep and
-- not by sessions closing as they ended.
-- ----------------------------------------------------------------------------
SELECT
  date_trunc('minute', a.marked_at) AS written_at,
  count(*)                          AS absences_written,
  count(DISTINCT a.session_id)      AS across_sessions
FROM public.attendance_records a
WHERE a.state = 'unexcused'
  AND a.marked_by_role = 'system'
GROUP BY 1
HAVING count(*) > 20
ORDER BY count(*) DESC
LIMIT 20;

-- ----------------------------------------------------------------------------
-- 3. Sessions closed long after the class they belong to
--
-- A session whose class was three weeks ago but which only closed today was
-- caught by the sweep rather than by anybody at the time. These are the ones
-- whose absences are newly invented rather than newly recorded.
-- ----------------------------------------------------------------------------
SELECT
  k.code                                    AS class,
  co.label                                  AS cohort,
  s.session_date,
  s.opened_at,
  s.status,
  count(a.id) FILTER (
    WHERE a.state = 'unexcused' AND a.marked_by_role = 'system')  AS absences,
  count(a.id) FILTER (
    WHERE a.state IN ('present', 'late'))                          AS check_ins
FROM public.class_sessions s
JOIN public.cohorts co ON co.id = s.cohort_id
JOIN public.classes k  ON k.id  = s.class_id
LEFT JOIN public.attendance_records a ON a.session_id = s.id
WHERE s.status = 'closed'
  AND s.session_date < CURRENT_DATE - 1
GROUP BY k.code, co.label, s.session_date, s.opened_at, s.status, s.id
HAVING count(a.id) FILTER (
         WHERE a.state = 'unexcused' AND a.marked_by_role = 'system') > 0
ORDER BY s.session_date DESC
LIMIT 40;

-- ----------------------------------------------------------------------------
-- 4. Sessions that closed with NOBODY present
--
-- The clearest sign of a session that should never have been counted: it was
-- opened at some point, nobody ever checked in, and closing then recorded the
-- whole cohort absent. A class that did not really run looks identical in the
-- data to one everybody skipped.
-- ----------------------------------------------------------------------------
SELECT
  k.code          AS class,
  co.label        AS cohort,
  s.session_date,
  s.opened_at,
  count(a.id)     AS everyone_marked_absent
FROM public.class_sessions s
JOIN public.cohorts co ON co.id = s.cohort_id
JOIN public.classes k  ON k.id  = s.class_id
JOIN public.attendance_records a ON a.session_id = s.id
WHERE s.status = 'closed'
GROUP BY k.code, co.label, s.session_date, s.opened_at, s.id
HAVING count(*) FILTER (WHERE a.state IN ('present', 'late')) = 0
ORDER BY s.session_date DESC
LIMIT 40;

-- ----------------------------------------------------------------------------
-- 5. Cancelled sessions, and whether anything survives against them
--
-- After 032 this should be empty. A non-empty result means records were written
-- against a session after it was cancelled, which nothing should do.
-- ----------------------------------------------------------------------------
SELECT s.id, s.session_date, co.label AS cohort, count(a.id) AS records_left
FROM public.class_sessions s
JOIN public.cohorts co ON co.id = s.cohort_id
JOIN public.attendance_records a ON a.session_id = s.id
WHERE s.status = 'cancelled'
GROUP BY s.id, s.session_date, co.label
ORDER BY s.session_date DESC;

-- ----------------------------------------------------------------------------
-- 6. The totals, so the scale is clear
-- ----------------------------------------------------------------------------
SELECT
  count(*)                                                  AS records_total,
  count(*) FILTER (WHERE state = 'present')                 AS present,
  count(*) FILTER (WHERE state = 'late')                    AS late,
  count(*) FILTER (WHERE state = 'excused')                 AS excused,
  count(*) FILTER (WHERE state = 'unexcused')               AS unexcused,
  count(*) FILTER (WHERE state = 'unexcused'
                     AND marked_by_role = 'system')         AS unexcused_by_sweep,
  count(*) FILTER (WHERE marked_by_role = 'staff')          AS marked_by_hand
FROM public.attendance_records;
