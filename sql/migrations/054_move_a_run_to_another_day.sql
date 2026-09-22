-- ============================================================================
-- 054 — move a session to another day, or move the run it belongs to
--
-- What dragging a session on the calendar means. It is the question calendar
-- apps ask about a repeating event, and 053 already asks it for a time or a
-- length. The day is the part 053 refused for a run, and said why: which
-- weekday a run falls on is the weekly pattern, and moving the sessions alone
-- leaves the pattern naming the old day — so the next fill puts them back.
--
-- HOW A RUN MOVES: BY SPLITTING THE PATTERN AT THE DATE
--
-- "Tuesdays at nine" becomes "Tuesdays at nine until 29 Sep, Thursdays at nine
-- from 1 Oct". That is what a calendar app does with "this and following", and
-- the schema was built for it: cohort_schedules has had effective_from and
-- effective_until since 002, and generate_sessions, fill_sessions and
-- apply_schedule_to_future all honour them.
--
-- One thing did not: set_cohort_schedules, which deletes a cohort's slots and
-- inserts them again without the dates. The first pattern save after a move
-- would have quietly turned the split into "both days, all term". It is
-- redefined below to carry the dates through, and the pattern editor now sends
-- them back.
--
-- WHAT MOVES WITH THE RUN, AND WHAT STAYS
--
-- From the dragged session onward, in the same run (cohort, weekday, time):
--
--   moves       scheduled or cancelled, nothing recorded, not hand-moved. A
--               cancelled week moves too, so "no class that week" survives the
--               move instead of reappearing on the new day at the next fill.
--   dropped     one that would land on a declared day off or past the end of
--               term. The pattern would not have made it there either.
--   stays       one somebody has been marked on (034's rule: a register was
--               taken for a class at a time), one moved by hand, one already
--               open or closed, and one whose target already holds a session
--               for that cohort at that time.
--
-- Every one of those is counted and returned, and the whole thing can run as a
-- dry run — the same do-it-count-it-roll-it-back as fill_sessions in 053, so
-- the question the calendar asks on drop shows numbers that the real move
-- cannot then contradict.
--
-- ALSO FIXED
--
-- update_session moved a single session onto a declared day off without a
-- word. Creating one there is refused since 038 ("remove the day off first");
-- moving one there is now refused the same way.
--
-- Run AFTER 053. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_cohort_schedules(
  p_cohort_ids uuid[],
  p_slots      jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class_ids uuid[];
  v_class_id  uuid;
  v_created   integer := 0;
  v_added     integer;
BEGIN
  IF p_cohort_ids IS NULL OR array_length(p_cohort_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no cohorts given';
  END IF;

  SELECT array_agg(DISTINCT class_id) INTO v_class_ids
  FROM public.cohorts WHERE id = ANY (p_cohort_ids);

  IF v_class_ids IS NULL THEN
    RAISE EXCEPTION 'none of those cohorts exist';
  END IF;

  IF array_length(v_class_ids, 1) > 1 THEN
    RAISE EXCEPTION 'those cohorts belong to different classes';
  END IF;

  v_class_id := v_class_ids[1];
  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF (SELECT count(*) FROM public.cohorts
      WHERE id = ANY (p_cohort_ids) AND class_id = v_class_id)
     <> array_length(p_cohort_ids, 1)
  THEN
    RAISE EXCEPTION 'one of those cohorts does not exist';
  END IF;

  -- Validate before deleting anything, so a bad slot cannot wipe a schedule
  -- and then fail.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'weekday') IS NULL
       OR (sl ->> 'weekday')::int NOT BETWEEN 0 AND 6
       OR NULLIF(btrim(COALESCE(sl ->> 'start_time', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION
      'every slot needs a weekday between 0 (Sunday) and 6 (Saturday) and a start time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'duration_minutes') IS NOT NULL
      AND (sl ->> 'duration_minutes')::int <= 0
  ) THEN
    RAISE EXCEPTION 'a slot duration must be greater than zero';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'auto_close_minutes') IS NOT NULL
      AND (sl ->> 'auto_close_minutes')::int <= 0
  ) THEN
    RAISE EXCEPTION
      'a sign-up window must be greater than zero — a zero-minute window can never be used';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'early_open_minutes') IS NOT NULL
      AND (sl ->> 'early_open_minutes')::int < 0
  ) THEN
    RAISE EXCEPTION 'a slot opens a negative number of minutes early';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'late_window_minutes') IS NOT NULL
      AND (sl ->> 'late_window_minutes')::int < 0
  ) THEN
    RAISE EXCEPTION 'a late window cannot be negative';
  END IF;

  -- 048: the same bound the column and every other entry point enforce.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'grace_minutes') IS NOT NULL
      AND (sl ->> 'grace_minutes')::int NOT BETWEEN 1 AND 30
  ) THEN
    RAISE EXCEPTION 'a grace window must be between 1 and 30 minutes';
  END IF;

  -- A late window past the end of the sign-up window is unreachable: check-in
  -- has already closed, so nobody can ever be marked late. Not checked for a
  -- slot that shuts at the start — there the sign-up window means nothing, and
  -- refusing on it would block a perfectly good slot (048).
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'late_window_minutes') IS NOT NULL
      AND (sl ->> 'auto_close_minutes') IS NOT NULL
      AND (sl ->> 'late_window_minutes')::int > (sl ->> 'auto_close_minutes')::int
      AND COALESCE((sl ->> 'closes_at_start')::boolean, false) = false
  ) THEN
    RAISE EXCEPTION
      'the late window cannot be longer than the sign-up window — check-in would already have closed';
  END IF;

  -- 054: a slot may carry the dates it applies between. A range that ends
  -- before it starts would silently generate nothing, forever.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE NULLIF(sl ->> 'effective_from', '') IS NOT NULL
      AND NULLIF(sl ->> 'effective_until', '') IS NOT NULL
      AND (sl ->> 'effective_until')::date < (sl ->> 'effective_from')::date
  ) THEN
    RAISE EXCEPTION
      'a meeting cannot end before it starts — check its from and until dates';
  END IF;

  DELETE FROM public.cohort_schedules WHERE cohort_id = ANY (p_cohort_ids);

  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time,
    duration_minutes, auto_close_minutes, late_window_minutes,
    early_open_minutes, closes_at_start, grace_minutes, grace_counts_late,
    effective_from, effective_until)
  SELECT
    v_class_id,
    c.cohort_id,
    (sl ->> 'weekday')::smallint,
    (sl ->> 'start_time')::time,
    NULLIF(sl ->> 'duration_minutes', '')::integer,
    NULLIF(sl ->> 'auto_close_minutes', '')::integer,
    NULLIF(sl ->> 'late_window_minutes', '')::integer,
    NULLIF(sl ->> 'early_open_minutes', '')::integer,
    NULLIF(sl ->> 'closes_at_start', '')::boolean,
    NULLIF(sl ->> 'grace_minutes', '')::integer,
    NULLIF(sl ->> 'grace_counts_late', '')::boolean,
    -- 054. Carried through a save, where before they were dropped: the delete
    -- above takes the old rows with them, and a split made by moving a run
    -- ("Tuesdays until 1 Oct, Thursdays from 2 Oct") came back from the next
    -- pattern save as both days for the whole term.
    NULLIF(sl ->> 'effective_from', '')::date,
    NULLIF(sl ->> 'effective_until', '')::date
  FROM unnest(p_cohort_ids) AS c(cohort_id)
  CROSS JOIN jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
  ON CONFLICT (cohort_id, weekday, start_time) DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_created := v_added;

  RETURN v_created;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.update_session(
  p_session_id          uuid,
  p_date                date    DEFAULT NULL,
  p_start_time          time    DEFAULT NULL,
  p_duration_minutes    integer DEFAULT NULL,
  p_notes               text    DEFAULT NULL,
  p_auto_close_minutes  integer DEFAULT NULL,
  p_late_window_minutes integer DEFAULT NULL,
  p_closes_at_start     boolean DEFAULT NULL,
  p_grace_minutes       integer DEFAULT NULL,
  p_grace_counts_late   boolean DEFAULT NULL
)
RETURNS public.class_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_class   public.classes%ROWTYPE;
  v_date    date;
  v_time    time;
  v_starts  timestamptz;
  v_close   integer;
  v_late    integer;
  v_shuts   boolean;
  v_grace   integer;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_session.class_id;

  IF NOT public.can_manage_class(v_session.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF v_session.status <> 'scheduled' THEN
    RAISE EXCEPTION
      'this session is %, so its time cannot be changed — only sessions that have not run yet can be moved',
      v_session.status;
  END IF;

  v_date := COALESCE(p_date, v_session.session_date);
  v_time := COALESCE(
    p_start_time,
    (v_session.starts_at AT TIME ZONE v_class.timezone)::time
  );
  v_starts := (v_date + v_time) AT TIME ZONE v_class.timezone;

  v_close := COALESCE(p_auto_close_minutes,  v_session.auto_close_minutes);
  v_late  := COALESCE(p_late_window_minutes, v_session.late_window_minutes);
  v_shuts := COALESCE(p_closes_at_start,     v_session.closes_at_start);
  v_grace := COALESCE(p_grace_minutes,       v_session.grace_minutes);

  IF v_close <= 0 THEN
    RAISE EXCEPTION
      'a sign-up window must be greater than zero — a zero-minute window can never be used';
  END IF;

  -- Only when it is the rule in force. A class on the ordinary rule can carry
  -- a late window longer than nothing in particular, and 048 does not change
  -- what that means.
  IF NOT v_shuts AND v_late > v_close THEN
    RAISE EXCEPTION
      'the late window cannot be longer than the sign-up window — check-in would already have closed';
  END IF;

  IF v_grace < 1 OR v_grace > 30 THEN
    RAISE EXCEPTION 'the grace window must be between 1 and 30 minutes, not %', v_grace;
  END IF;

  -- 054. Moving a session onto a declared day off put a class on a date the
  -- class does not meet. Creating one there has been refused since 038.
  IF v_date <> v_session.session_date
     AND public.is_no_class_day(v_session.class_id, v_session.cohort_id, v_date) THEN
    RAISE EXCEPTION
      '% is set as a day this class does not meet. Remove the day off first.',
      v_date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.class_sessions s
    WHERE s.cohort_id = v_session.cohort_id
      AND s.starts_at = v_starts
      AND s.id <> v_session.id
  ) THEN
    RAISE EXCEPTION
      'that cohort already has a session at % on %', v_time, v_date;
  END IF;

  UPDATE public.class_sessions
     SET starts_at           = v_starts,
         session_date        = v_date,
         duration_minutes    = COALESCE(p_duration_minutes, duration_minutes),
         auto_close_minutes  = v_close,
         late_window_minutes = v_late,
         notes               = COALESCE(p_notes, notes),
         -- 048, this session only.
         closes_at_start     = v_shuts,
         grace_minutes       = v_grace,
         grace_counts_late   = COALESCE(p_grace_counts_late, grace_counts_late),
         moved_manually      = true
   WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- move_session_to — what a drop on the calendar does
--
-- p_scope 'one'     this session, to that date. It leaves the pattern
--                   (update_session marks it moved by hand), which is what
--                   "just this one" means.
-- p_scope 'future'  this session and every later one in its run, and the
--                   pattern split so the run stays where it was put.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_session_to(
  p_session_id uuid,
  p_new_date   date,
  p_scope      text    DEFAULT 'one',
  p_dry_run    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_anchor     public.class_sessions%ROWTYPE;
  v_class      public.classes%ROWTYPE;
  v_slot       public.cohort_schedules%ROWTYPE;
  v_target     public.class_sessions%ROWTYPE;
  v_time       time;
  v_old_dow    smallint;
  v_new_dow    smallint;
  v_delta      integer;
  v_to         date;
  v_starts     timestamptz;
  v_new_slot   uuid;
  v_split      boolean := false;
  v_moved      integer := 0;
  v_day_off    integer := 0;
  v_past_term  integer := 0;
  v_marked     integer := 0;
  v_by_hand    integer := 0;
  v_running    integer := 0;
  v_clash      integer := 0;
BEGIN
  IF p_scope NOT IN ('one', 'future') THEN
    RAISE EXCEPTION
      'scope must be one (this session) or future (this and every later one), not %',
      p_scope;
  END IF;

  SELECT * INTO v_anchor FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  IF NOT public.can_manage_class(v_anchor.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_anchor.class_id;

  IF p_new_date IS NULL OR p_new_date = v_anchor.session_date THEN
    RAISE EXCEPTION 'that session is already on %', v_anchor.session_date;
  END IF;

  IF p_new_date < v_class.term_starts_on OR p_new_date > v_class.term_ends_on THEN
    RAISE EXCEPTION '% is outside the term (% to %)',
      p_new_date, v_class.term_starts_on, v_class.term_ends_on;
  END IF;

  IF public.is_no_class_day(v_anchor.class_id, v_anchor.cohort_id, p_new_date) THEN
    RAISE EXCEPTION
      '% is set as a day this class does not meet. Remove the day off first.',
      p_new_date;
  END IF;

  v_time    := (v_anchor.starts_at AT TIME ZONE v_class.timezone)::time;
  v_old_dow := EXTRACT(DOW FROM v_anchor.session_date)::smallint;
  v_new_dow := EXTRACT(DOW FROM p_new_date)::smallint;
  v_delta   := p_new_date - v_anchor.session_date;

  -- ---------------------------------------------------------- just this one
  IF p_scope = 'one' THEN
    BEGIN
      PERFORM public.update_session(p_session_id, p_new_date);
      v_moved := 1;
      IF p_dry_run THEN
        RAISE EXCEPTION 'move_session_to dry run' USING ERRCODE = 'ZZ002';
      END IF;
    EXCEPTION WHEN SQLSTATE 'ZZ002' THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'scope', 'one', 'dry_run', p_dry_run, 'split', false,
      'moved', v_moved, 'dropped', jsonb_build_object('day_off', 0, 'past_term', 0),
      'kept', jsonb_build_object('marked', 0, 'by_hand', 0, 'running', 0, 'clash', 0));
  END IF;

  -- ----------------------------------------------- this and every later one
  IF v_anchor.status <> 'scheduled' THEN
    RAISE EXCEPTION
      'this session is %, so it cannot lead a move — only one that has not run yet can',
      v_anchor.status;
  END IF;

  IF v_new_dow = v_old_dow THEN
    RAISE EXCEPTION
      'that is the same weekday, so the run would not change day — move just this session instead';
  END IF;

  -- The slot this session came from: same cohort, weekday and time, in force
  -- on its date. Without one the session is not part of the weekly pattern,
  -- and there is no run to move.
  SELECT * INTO v_slot
    FROM public.cohort_schedules s
   WHERE s.cohort_id  = v_anchor.cohort_id
     AND s.weekday    = v_old_dow
     AND s.start_time = v_time
     AND (s.effective_from  IS NULL OR s.effective_from  <= v_anchor.session_date)
     AND (s.effective_until IS NULL OR s.effective_until >= v_anchor.session_date);
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'this session is not part of the weekly pattern, so there is no run to move — move just this session instead';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cohort_schedules s
     WHERE s.cohort_id  = v_anchor.cohort_id
       AND s.weekday    = v_new_dow
       AND s.start_time = v_time
  ) THEN
    RAISE EXCEPTION
      'this cohort already has a weekly meeting on that weekday at %, so the two runs would collide',
      v_time;
  END IF;

  BEGIN
    -- The split. If the slot starts on or after this session, nothing before
    -- it needs keeping and the slot simply changes day; otherwise the old day
    -- ends the day before and a new slot carries on from the new date.
    --
    -- Either way the new day starts ON the new date, never earlier. Dragging
    -- Tue 22 to Thu 1 Oct and starting the Thursday slot on the 22nd would
    -- have the pattern want a Thursday on the 24th, and the next fill would
    -- create a class that nobody scheduled.
    IF v_slot.effective_from IS NOT NULL
       AND v_slot.effective_from >= v_anchor.session_date THEN
      UPDATE public.cohort_schedules
         SET weekday = v_new_dow,
             effective_from = p_new_date
       WHERE id = v_slot.id;
      v_new_slot := v_slot.id;
    ELSE
      UPDATE public.cohort_schedules
         SET effective_until = v_anchor.session_date - 1
       WHERE id = v_slot.id;

      INSERT INTO public.cohort_schedules (
        class_id, cohort_id, weekday, start_time, duration_minutes,
        delivery_mode, auto_close_minutes, late_window_minutes,
        early_open_minutes, closes_at_start, grace_minutes, grace_counts_late,
        effective_from, effective_until)
      VALUES (
        v_slot.class_id, v_slot.cohort_id, v_new_dow, v_slot.start_time,
        v_slot.duration_minutes, v_slot.delivery_mode,
        v_slot.auto_close_minutes, v_slot.late_window_minutes,
        v_slot.early_open_minutes, v_slot.closes_at_start,
        v_slot.grace_minutes, v_slot.grace_counts_late,
        p_new_date, v_slot.effective_until)
      RETURNING id INTO v_new_slot;
      v_split := true;
    END IF;

    FOR v_target IN
      SELECT * FROM public.class_sessions s
       WHERE s.cohort_id = v_anchor.cohort_id
         AND EXTRACT(DOW FROM s.session_date)::smallint = v_old_dow
         AND (s.starts_at AT TIME ZONE v_class.timezone)::time = v_time
         AND s.session_date >= v_anchor.session_date
       ORDER BY s.session_date
    LOOP
      IF v_target.status NOT IN ('scheduled', 'cancelled') THEN
        v_running := v_running + 1;
        CONTINUE;
      END IF;

      IF EXISTS (SELECT 1 FROM public.attendance_records a
                  WHERE a.session_id = v_target.id) THEN
        v_marked := v_marked + 1;
        CONTINUE;
      END IF;

      IF v_target.moved_manually THEN
        v_by_hand := v_by_hand + 1;
        CONTINUE;
      END IF;

      v_to := v_target.session_date + v_delta;

      -- Where the pattern would not have put one either: remove it rather
      -- than leave a Tuesday session standing in a Thursday run.
      IF v_to > v_class.term_ends_on THEN
        DELETE FROM public.class_sessions WHERE id = v_target.id;
        v_past_term := v_past_term + 1;
        CONTINUE;
      END IF;

      IF public.is_no_class_day(v_anchor.class_id, v_anchor.cohort_id, v_to) THEN
        DELETE FROM public.class_sessions WHERE id = v_target.id;
        v_day_off := v_day_off + 1;
        CONTINUE;
      END IF;

      v_starts := (v_to + v_time) AT TIME ZONE v_class.timezone;

      IF EXISTS (SELECT 1 FROM public.class_sessions o
                  WHERE o.cohort_id = v_target.cohort_id
                    AND o.starts_at = v_starts
                    AND o.id <> v_target.id) THEN
        v_clash := v_clash + 1;
        CONTINUE;
      END IF;

      -- Not through update_session: that marks a session moved by hand, and
      -- these are the opposite — still following the pattern, which now says
      -- the new day.
      UPDATE public.class_sessions
         SET session_date = v_to,
             starts_at    = v_starts,
             schedule_id  = v_new_slot
       WHERE id = v_target.id;
      v_moved := v_moved + 1;
    END LOOP;

    IF p_dry_run THEN
      RAISE EXCEPTION 'move_session_to dry run' USING ERRCODE = 'ZZ002';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZZ002' THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'scope',   'future',
    'dry_run', p_dry_run,
    'split',   v_split,
    'moved',   v_moved,
    'dropped', jsonb_build_object('day_off', v_day_off, 'past_term', v_past_term),
    'kept',    jsonb_build_object(
                 'marked',  v_marked,
                 'by_hand', v_by_hand,
                 'running', v_running,
                 'clash',   v_clash)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.move_session_to(uuid, date, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.move_session_to(uuid, date, text, boolean) TO authenticated;

COMMENT ON FUNCTION public.move_session_to(uuid, date, text, boolean) IS
  'Move one session to another date, or move it and every later one in its run '
  'by splitting the weekly pattern at that date. Marked, hand-moved and running '
  'sessions stay; ones landing on a day off or past the term are removed. '
  'p_dry_run does the work, counts it and rolls it back.';
