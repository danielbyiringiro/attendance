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
