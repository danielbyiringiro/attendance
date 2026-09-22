-- ============================================================================
-- 053 — see what filling would do, before it does it
--
-- Two buttons on two screens today. "Generate sessions" sits at the bottom of
-- the weekly pattern editor and "Backfill earlier sessions" beside it, while
-- everything either one does is only visible on the OTHER tab. You press,
-- read "created 34", and then go and look.
--
-- fill_sessions is one call that does both directions over a date range, and —
-- the point of it — answers the same question without writing anything.
--
-- WHY A DRY RUN AND NOT A SEPARATE COUNTING FUNCTION
--
-- A preview written as its own query is a second implementation of the rules,
-- and the two drift. The first time a guard is added to the real path and not
-- the counting one, the screen promises something the button does not do —
-- and the person finds out afterwards, which is exactly the thing this is
-- meant to prevent.
--
-- So the dry run IS the real path: it creates, it removes, it counts, and then
-- it raises to roll the whole lot back. plpgsql rolls database changes back to
-- the block's implicit savepoint but leaves variables alone, so the counts
-- survive the undo. The preview cannot be wrong about what the action does,
-- because it is the action.
--
-- WHAT IT REMOVES, AND WHAT IT WILL NOT
--
-- Pruning only ever reaches forward from today. A past session the pattern no
-- longer wants is history, not a mistake to tidy: somebody held that class.
--
-- Ahead of today it removes a scheduled session on a day the cohort no longer
-- meets, and never one that is cancelled, hand-moved, or has anybody marked
-- against it. Those three are counted and returned separately, so the screen
-- can say "3 left alone" instead of a TA counting 11 where they expected 14
-- and having no way to learn why.
--
-- This is the same rule apply_schedule_to_future (034) applies when a pattern
-- is saved. It is written again here rather than called because that function
-- always runs to the end of term, and a fill bounded at "up to today" must not
-- quietly reach past its own end date.
--
-- WHAT IT DOES NOT DO
--
-- It does not restyle the sessions it leaves standing. Moving an existing
-- session to a new time when the pattern's time changes is what saving the
-- pattern does, through apply_schedule_to_future. Filling is about dates that
-- have a session and dates that should.
--
-- Nor does it close anything. generate_sessions has always created every
-- session 'scheduled', in the past as much as the future, and that is left
-- alone here: this migration is about seeing the work before it happens, not
-- about changing what the work is.
--
-- ALSO IN THIS MIGRATION
--
-- update_session_series: editing one session, or the run it belongs to, the
-- way a calendar app asks it — only this one, this and every later one, or all
-- of them. Same reasoning as above, one level down: the app could change one
-- session or rewrite the weekly rule, and nothing in between.
--
-- Run AFTER 052. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fill_sessions(
  p_class_id uuid,
  p_from     date    DEFAULT NULL,
  p_to       date    DEFAULT NULL,
  p_prune    boolean DEFAULT true,
  p_dry_run  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class     public.classes%ROWTYPE;
  v_from      date;
  v_to        date;
  v_prune_from date;
  v_created   integer := 0;
  v_removed   integer := 0;
  v_marked    integer := 0;
  v_by_hand   integer := 0;
  v_cancelled integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  v_from := COALESCE(p_from, v_class.term_starts_on);
  v_to   := COALESCE(p_to,   v_class.term_ends_on);

  IF v_to < v_from THEN
    RAISE EXCEPTION 'fill_sessions: % is before %', v_to, v_from;
  END IF;

  -- Never behind today, whatever range was asked for.
  v_prune_from := GREATEST(v_from, CURRENT_DATE);

  -- The counts that explain a smaller number than expected. Read before
  -- anything is written, because two of the three stop existing as "left
  -- alone" the moment the pattern is what decides them.
  IF p_prune AND v_to >= v_prune_from THEN
    WITH wanted AS (
      SELECT s.cohort_id, d::date AS on_date
      FROM public.cohort_schedules s
      CROSS JOIN LATERAL
        generate_series(v_prune_from, v_to, INTERVAL '1 day') AS d
      WHERE s.class_id = p_class_id
        AND EXTRACT(DOW FROM d)::smallint = s.weekday
        AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
        AND (s.effective_until IS NULL OR d::date <= s.effective_until)
    ),
    unwanted AS (
      SELECT s.*
      FROM public.class_sessions s
      WHERE s.class_id      = p_class_id
        AND s.session_date >= v_prune_from
        AND s.session_date <= v_to
        AND NOT EXISTS (
          SELECT 1 FROM wanted w
          WHERE w.cohort_id = s.cohort_id AND w.on_date = s.session_date
        )
    )
    SELECT
      count(*) FILTER (WHERE u.status = 'cancelled'),
      count(*) FILTER (
        WHERE u.status <> 'cancelled'
          AND EXISTS (SELECT 1 FROM public.attendance_records a
                       WHERE a.session_id = u.id)),
      count(*) FILTER (
        WHERE u.status = 'scheduled'
          AND u.moved_manually
          AND NOT EXISTS (SELECT 1 FROM public.attendance_records a
                           WHERE a.session_id = u.id))
    INTO v_cancelled, v_marked, v_by_hand
    FROM unwanted u;
  END IF;

  -- The work itself, done for real even when the answer is going to be thrown
  -- away. See the header: a preview that is a second implementation is a
  -- preview that can be wrong.
  BEGIN
    v_created := public.generate_sessions(p_class_id, NULL, v_from, v_to);

    IF p_prune AND v_to >= v_prune_from THEN
      WITH wanted AS (
        SELECT s.cohort_id, d::date AS on_date
        FROM public.cohort_schedules s
        CROSS JOIN LATERAL
          generate_series(v_prune_from, v_to, INTERVAL '1 day') AS d
        WHERE s.class_id = p_class_id
          AND EXTRACT(DOW FROM d)::smallint = s.weekday
          AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
          AND (s.effective_until IS NULL OR d::date <= s.effective_until)
      ),
      removed AS (
        DELETE FROM public.class_sessions s
         WHERE s.class_id      = p_class_id
           AND s.status        = 'scheduled'
           AND NOT s.moved_manually
           AND s.session_date >= v_prune_from
           AND s.session_date <= v_to
           AND NOT EXISTS (
             SELECT 1 FROM wanted w
             WHERE w.cohort_id = s.cohort_id AND w.on_date = s.session_date
           )
           -- 034's rule, and the reason it exists: attendance_records cascades
           -- on delete, so without this a TA who took a register by hand and
           -- then tidied the timetable would lose it, silently.
           AND NOT EXISTS (
             SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
           )
        RETURNING 1
      )
      SELECT count(*) INTO v_removed FROM removed;
    END IF;

    IF p_dry_run THEN
      -- Undo all of it. The counts above are plpgsql variables, which an
      -- exception does not touch; only the database changes go back.
      RAISE EXCEPTION 'fill_sessions dry run' USING ERRCODE = 'ZZ001';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZZ001' THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'from',      v_from,
    'to',        v_to,
    'dry_run',   p_dry_run,
    'pruned',    p_prune AND v_to >= v_prune_from,
    'created',   v_created,
    'removed',   v_removed,
    -- Left standing although the pattern no longer names their date.
    'kept', jsonb_build_object(
      'marked',    COALESCE(v_marked, 0),
      'by_hand',   COALESCE(v_by_hand, 0),
      'cancelled', COALESCE(v_cancelled, 0)
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fill_sessions(uuid, date, date, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.fill_sessions(uuid, date, date, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.fill_sessions(uuid, date, date, boolean, boolean) IS
  'Create the sessions a pattern wants across a date range, and ahead of today '
  'remove the ones it no longer wants. With p_dry_run it does the work, counts '
  'it and rolls it back, so a screen can show the plan without a second '
  'implementation of the rules that could disagree with this one.';

-- ----------------------------------------------------------------------------
-- Editing one session, or the run of them it belongs to
--
-- Calendar apps ask this when you edit a repeating event — only this one, this
-- and everything after it, or all of them — and the app has only ever had the
-- first. Changing a lab's time for the rest of term meant opening eleven
-- sessions one at a time, or editing the weekly pattern and hoping the two
-- agreed about what already existed.
--
-- WHAT COUNTS AS THE SAME RUN
--
-- Same cohort, same weekday, same start time. Deliberately NOT schedule_id:
-- set_cohort_schedules replaces its slot rows wholesale, so schedule_id is not
-- stable across a pattern save, and 034 already matches on (cohort, date) for
-- that reason. Weekday-and-time is also what a person means by "every Tuesday
-- at nine", which is the question being answered.
--
-- WHAT IT REFUSES TO DO
--
-- Move a date for anything but 'one'. Which weekday a run falls on is the
-- weekly pattern, not a session edit: changing it here would leave the pattern
-- still naming the old day, and the next fill would recreate every session
-- this had just moved. The error says so rather than doing half of it.
--
-- WHAT IT LEAVES ALONE
--
-- A session somebody has been marked on, and anything that is not still
-- 'scheduled'. 034 gives the reason for the first at length: the register was
-- taken for a class at a particular time, and restamping it with a different
-- one makes the record say something nobody asserted. A single-session edit
-- still allows it, because that is a person looking at one session and
-- deciding; a bulk edit is looking at none of them. Both counts come back, so
-- a screen can say "9 changed, 2 left alone" instead of a number that does
-- not add up to what was asked for.
--
-- WHAT IT COSTS
--
-- Every session it changes is marked moved_manually. That is what stops the
-- next pattern save undoing the edit, and equally what stops the pattern ever
-- reaching those sessions again. It is the trade for editing sessions instead
-- of the rule that makes them, and the dialog says so before you choose.
--
-- Each row goes through update_session rather than one bulk UPDATE, so every
-- validation that function performs — the sign-up window, the late window, the
-- grace bounds, the clash check — applies here exactly as it does to one.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_session_series(
  p_session_id          uuid,
  p_scope               text    DEFAULT 'one',
  p_date                date    DEFAULT NULL,
  p_start_time          time    DEFAULT NULL,
  p_duration_minutes    integer DEFAULT NULL,
  p_auto_close_minutes  integer DEFAULT NULL,
  p_late_window_minutes integer DEFAULT NULL,
  p_closes_at_start     boolean DEFAULT NULL,
  p_grace_minutes       integer DEFAULT NULL,
  p_grace_counts_late   boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_anchor  public.class_sessions%ROWTYPE;
  v_class   public.classes%ROWTYPE;
  v_time    time;
  v_weekday smallint;
  v_target  public.class_sessions%ROWTYPE;
  v_updated integer := 0;
  v_marked  integer := 0;
  v_state   integer := 0;
BEGIN
  IF p_scope NOT IN ('one', 'future', 'series') THEN
    RAISE EXCEPTION
      'scope must be one (this session), future (this and later ones) or series (all of them), not %',
      p_scope;
  END IF;

  SELECT * INTO v_anchor FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  IF NOT public.can_manage_class(v_anchor.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_date IS NOT NULL AND p_scope <> 'one' THEN
    RAISE EXCEPTION
      'a date can only be changed for one session — moving a whole run to another weekday is what the weekly pattern is for, and changing it here would leave the pattern still naming the old day';
  END IF;

  -- One session is the ordinary path and keeps the ordinary rules: it may move
  -- a date, and it may retime a session somebody has marked, because a person
  -- is looking at that session while they decide to.
  IF p_scope = 'one' THEN
    PERFORM public.update_session(
      p_session_id, p_date, p_start_time, p_duration_minutes, NULL,
      p_auto_close_minutes, p_late_window_minutes,
      p_closes_at_start, p_grace_minutes, p_grace_counts_late);

    RETURN jsonb_build_object(
      'scope', 'one', 'updated', 1,
      'skipped_marked', 0, 'skipped_status', 0);
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_anchor.class_id;

  -- The run this session belongs to, read from the session as it is NOW —
  -- before anything changes, or the second row would be matched against the
  -- first row's new time and the run would fall apart halfway through.
  v_time    := (v_anchor.starts_at AT TIME ZONE v_class.timezone)::time;
  v_weekday := EXTRACT(DOW FROM v_anchor.session_date)::smallint;

  FOR v_target IN
    SELECT * FROM public.class_sessions s
    WHERE s.cohort_id = v_anchor.cohort_id
      AND EXTRACT(DOW FROM s.session_date)::smallint = v_weekday
      AND (s.starts_at AT TIME ZONE v_class.timezone)::time = v_time
      AND (p_scope = 'series' OR s.session_date >= v_anchor.session_date)
    ORDER BY s.session_date
  LOOP
    IF v_target.status <> 'scheduled' THEN
      v_state := v_state + 1;
      CONTINUE;
    END IF;

    -- 034's rule, applied to a bulk edit: a register was taken for a class at
    -- a particular time, and restamping it makes the record claim something
    -- nobody asserted. One-session edits are allowed this; a bulk edit is not
    -- looking at any of the sessions it would change.
    IF EXISTS (SELECT 1 FROM public.attendance_records a
                WHERE a.session_id = v_target.id) THEN
      v_marked := v_marked + 1;
      CONTINUE;
    END IF;

    PERFORM public.update_session(
      v_target.id, NULL, p_start_time, p_duration_minutes, NULL,
      p_auto_close_minutes, p_late_window_minutes,
      p_closes_at_start, p_grace_minutes, p_grace_counts_late);

    v_updated := v_updated + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'scope',          p_scope,
    'updated',        v_updated,
    'skipped_marked', v_marked,
    'skipped_status', v_state
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_session_series(
  uuid, text, date, time, integer, integer, integer, boolean, integer, boolean)
  FROM public;
GRANT EXECUTE ON FUNCTION public.update_session_series(
  uuid, text, date, time, integer, integer, integer, boolean, integer, boolean)
  TO authenticated;

COMMENT ON FUNCTION public.update_session_series(
  uuid, text, date, time, integer, integer, integer, boolean, integer, boolean) IS
  'Edit one session, this one and every later one in its run, or the whole run. '
  'A run is same cohort, same weekday, same start time. The bulk scopes leave '
  'sessions somebody has marked, and anything no longer scheduled, alone.';

-- ----------------------------------------------------------------------------
-- How big the run is, so the dialog can say what each choice would touch
--
-- Asked before anything is edited. A choice offered as "this and every later
-- one" with no number beside it is a choice made blind, which is the same
-- complaint that produced fill_sessions above.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.count_session_series(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_anchor  public.class_sessions%ROWTYPE;
  v_class   public.classes%ROWTYPE;
  v_time    time;
  v_weekday smallint;
  v_future  integer;
  v_all     integer;
BEGIN
  SELECT * INTO v_anchor FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  IF NOT public.can_manage_class(v_anchor.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_anchor.class_id;
  v_time    := (v_anchor.starts_at AT TIME ZONE v_class.timezone)::time;
  v_weekday := EXTRACT(DOW FROM v_anchor.session_date)::smallint;

  SELECT
    count(*) FILTER (WHERE s.session_date >= v_anchor.session_date),
    count(*)
  INTO v_future, v_all
  FROM public.class_sessions s
  WHERE s.cohort_id = v_anchor.cohort_id
    AND EXTRACT(DOW FROM s.session_date)::smallint = v_weekday
    AND (s.starts_at AT TIME ZONE v_class.timezone)::time = v_time;

  RETURN jsonb_build_object('future', v_future, 'series', v_all);
END;
$fn$;

REVOKE ALL ON FUNCTION public.count_session_series(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.count_session_series(uuid) TO authenticated;
