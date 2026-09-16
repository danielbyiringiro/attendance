-- ============================================================================
-- 048 — check-in that shuts when the class starts, with a grace window
--
-- THE CLASS THIS IS FOR
--
-- Check-in currently runs from the early-open allowance until
-- auto_close_minutes after the class began (028). That suits a class where
-- people drift in. It does not suit one where the register is the door: the
-- point of marking is that you were there when it started, and a window that
-- stays open for fifteen minutes afterwards is fifteen minutes in which
-- somebody two buildings away can mark themselves present.
--
-- So, optionally: check-in closes at starts_at. Not a minute after.
--
-- OFF BY DEFAULT
--
-- Every existing class keeps exactly the behaviour it has. This is one boolean
-- per class, per weekly slot, and per session, defaulting to false, and every
-- rule below reads "if it is on" — with the off branch being the current rule
-- character for character.
--
-- THE GRACE WINDOW
--
-- The awkward case is a TA who opens check-in AFTER the class has started —
-- the projector would not wake up, the room was double-booked. Closing at
-- starts_at would mean the window opens and shuts in the same instant, and
-- nobody can mark at all.
--
-- So when the session is opened after it was due to start, check-in gets a
-- grace window measured from the click: grace_minutes, five by default,
-- settable between one and thirty. Long enough to take a register, short
-- enough that it is not the old behaviour wearing a new name.
--
--   Opened 08:55 for a 09:00 class     opens 08:55, closes 09:00
--   Opened 09:00 exactly               opens 09:00, closes 09:00 — see below
--   Opened 09:07, grace 5              opens 09:07, closes 09:12
--
-- The 09:00 case is a real edge and it resolves the safe way: opened_at <=
-- starts_at takes the "closes at the start" branch, so a session opened in the
-- same second the class begins has no window. The sweep opens sessions at the
-- early-open moment, so in practice a session reaching 09:00 unopened was never
-- going to be opened by the schedule, and a TA opening by hand at 09:00:01 gets
-- the grace window.
--
-- WHAT COUNTS AS LATE
--
-- Under the normal rule, late_window_minutes decides. Under this one it cannot:
-- the window has already shut by the time lateness would begin, so every mark
-- would be present and late_window_minutes would silently mean nothing.
--
-- Inside a grace window the class chooses. grace_counts_late is false by
-- default — somebody who marked in the two minutes after their TA got the
-- projector working was not late, the room was — and true records them as late,
-- for a class where being there at the start is the whole point.
--
-- session_mark_state is a new function rather than a fourth inline CASE.
-- mark_attendance had this arithmetic written into its body, and "is this mark
-- late?" now has two rules; one of them living in a function body is how the
-- other one ends up disagreeing with it.
--
-- THE SWEEP
--
-- 033 lets a session open itself any time up to the end of the class. With this
-- setting on, that upper bound becomes starts_at: opening a class twenty
-- minutes in would mint a PIN for a window session_closes_at already considers
-- shut, and the dashboard would show a live code nobody can use. Off, 033's
-- rule is untouched.
--
-- WHERE IT CAN BE SET
--
-- All three places the other check-in windows already live, because "shut the
-- door at the start" is rarely true of a whole class evenly:
--
--   the class            set_session_windows, for every cohort or one of them
--   one weekly slot      set_cohort_schedules — a cohort's lecture can be run
--                        this way while its lab keeps the sign-up window
--   one session          update_session, for the day the lecturer asked for it
--                        — or the day it should not apply
--
-- A slot or session carrying none of the three inherits the class default, the
-- same way the three windows beside them already do.
--
-- Run AFTER 047. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The three settings, on the same path the other three already take:
-- a class default, an optional per-slot override, and the value each session
-- copies when it is generated.
-- ----------------------------------------------------------------------------

ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS default_closes_at_start   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_grace_minutes     integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS default_grace_counts_late boolean NOT NULL DEFAULT false;

ALTER TABLE public.cohort_schedules
  ADD COLUMN IF NOT EXISTS closes_at_start   boolean,
  ADD COLUMN IF NOT EXISTS grace_minutes     integer,
  ADD COLUMN IF NOT EXISTS grace_counts_late boolean;

ALTER TABLE public.class_sessions
  ADD COLUMN IF NOT EXISTS closes_at_start   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grace_minutes     integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS grace_counts_late boolean NOT NULL DEFAULT false;

-- Dropped and re-added rather than IF NOT EXISTS, which constraints do not
-- take: this is what makes the migration safe to run twice.
ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS classes_default_grace_minutes_check;
ALTER TABLE public.classes
  ADD CONSTRAINT classes_default_grace_minutes_check
  CHECK (default_grace_minutes BETWEEN 1 AND 30);

ALTER TABLE public.cohort_schedules DROP CONSTRAINT IF EXISTS cohort_schedules_grace_minutes_check;
ALTER TABLE public.cohort_schedules
  ADD CONSTRAINT cohort_schedules_grace_minutes_check
  CHECK (grace_minutes IS NULL OR grace_minutes BETWEEN 1 AND 30);

ALTER TABLE public.class_sessions DROP CONSTRAINT IF EXISTS class_sessions_grace_minutes_check;
ALTER TABLE public.class_sessions
  ADD CONSTRAINT class_sessions_grace_minutes_check
  CHECK (grace_minutes BETWEEN 1 AND 30);

COMMENT ON COLUMN public.class_sessions.closes_at_start IS
  'Check-in shuts at starts_at instead of auto_close_minutes after it (048).';
COMMENT ON COLUMN public.class_sessions.grace_minutes IS
  'With closes_at_start, how long check-in lasts when the session is opened '
  'after it was due to start. 1-30, five by default (048).';
COMMENT ON COLUMN public.class_sessions.grace_counts_late IS
  'Whether a mark made inside that grace window is recorded late (048).';

-- ----------------------------------------------------------------------------
-- When check-in closes
--
-- The off branch is 028's rule, unchanged. session_opens_at and session_is_live
-- are not redefined here: opening is unaffected, and liveness is already
-- "between the two", so it follows this automatically — as do the sweep's
-- closer and mark_attendance, which both ask through it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.session_closes_at(s public.class_sessions)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN s.opened_at IS NULL THEN NULL
    WHEN NOT COALESCE(s.closes_at_start, false) THEN
      GREATEST(s.opened_at, s.starts_at)
      + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
    -- Open by the time the class began: the door shuts as it starts.
    WHEN s.opened_at <= s.starts_at THEN s.starts_at
    -- Opened after it: a grace window measured from the click, because closing
    -- at a moment already past would leave no window at all.
    ELSE s.opened_at + make_interval(mins => COALESCE(s.grace_minutes, 5))
  END;
$fn$;

COMMENT ON FUNCTION public.session_closes_at(public.class_sessions) IS
  'When check-in stops accepting marks: auto_close_minutes after the later of '
  'opening and the class start, or — with closes_at_start (048) — at the class '
  'start, or grace_minutes after a session opened later than that.';

-- ----------------------------------------------------------------------------
-- Present or late
--
-- One definition, because there are now two rules and mark_attendance is no
-- longer the only thing that needs to know which applies.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.session_mark_state(
  s    public.class_sessions,
  p_at timestamptz DEFAULT now()
)
RETURNS public.attendance_state
LANGUAGE sql
STABLE
AS $fn$
  SELECT CASE
    -- Never opened: nothing can be marked against it anyway, and 'present' is
    -- the answer that cannot silently penalise anybody.
    WHEN s.opened_at IS NULL THEN 'present'::public.attendance_state
    -- Inside a grace window the class decides. late_window_minutes cannot: the
    -- window shuts before lateness would begin, so it would mean nothing here.
    WHEN COALESCE(s.closes_at_start, false) AND s.opened_at > s.starts_at THEN
      CASE
        WHEN COALESCE(s.grace_counts_late, false)
        THEN 'late'::public.attendance_state
        ELSE 'present'::public.attendance_state
      END
    -- 028's rule: measured from whichever is later, the class starting or the
    -- TA opening, so a mark at 08:50 for a 09:00 class is never late.
    WHEN p_at > GREATEST(s.opened_at, s.starts_at)
                + make_interval(mins => COALESCE(s.late_window_minutes, 0))
    THEN 'late'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;
$fn$;

COMMENT ON FUNCTION public.session_mark_state(public.class_sessions, timestamptz) IS
  'Whether a mark made at that moment is present or late: late_window_minutes '
  'from the later of opening and the class start, or — inside a 048 grace '
  'window — whatever grace_counts_late says.';

-- ----------------------------------------------------------------------------
-- mark_attendance — copied from 044, with the state decision moved out
--
-- Everything else is 044 character for character: the refusal wording, what is
-- and is not said before the student is identified, and the ON CONFLICT that
-- lets a student's own mark replace a system-written absence.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_attendance(
  p_student_id text,
  p_pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_student_id text := btrim(p_student_id);
  v_pin        text := upper(btrim(COALESCE(p_pin, '')));
  v_session    public.class_sessions%ROWTYPE;
  v_pin_open   integer;
  v_matches    integer;
  v_student    public.students%ROWTYPE;
  v_cohort     text;
  v_class_name text;
  v_class_code text;
  v_state      public.attendance_state;
  v_existing   public.attendance_state;
BEGIN
  IF v_student_id = '' OR v_pin = '' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'Enter your Student ID and the PIN.');
  END IF;

  -- Does ANY open session carry this code? Nothing about the student is
  -- involved, so the answer is the same for everyone and can be reported.
  SELECT count(*) INTO v_pin_open
  FROM public.class_sessions s
  WHERE s.status = 'open'
    AND upper(btrim(s.pin)) = v_pin;

  IF v_pin_open = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'no_such_code',
      'error',   'That code is not open right now. Check the letters on '
                 'screen — it is not the same code every session.');
  END IF;

  -- The window runs from when the TA opened, not from the scheduled start: a
  -- session opened late should still accept marks for its full length. Also
  -- PIN-only, so it can be named.
  IF NOT EXISTS (
    SELECT 1
    FROM public.class_sessions s
    WHERE upper(btrim(s.pin)) = v_pin
      AND public.session_is_live(s)
  ) THEN
    -- Two different refusals, because "too early" and "too late" are both
    -- fixable and by different people. Still PIN-only, so neither says
    -- anything about who is asking.
    IF EXISTS (
      SELECT 1
      FROM public.class_sessions s
      WHERE s.status = 'open'
        AND upper(btrim(s.pin)) = v_pin
        AND s.opened_at IS NOT NULL
        AND now() < public.session_opens_at(s)
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'reason',  'not_open_yet',
        'error',   'That code is right, but check-in has not opened yet. It '
                   'opens shortly before the class starts.');
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'reason',  'window_closed',
      'error',   'That code was right, but its check-in window has closed. '
                 'Ask your TA to reopen it.');
  END IF;

  -- From here the answer depends on who is asking, so it stops being specific.
  SELECT count(*) INTO v_matches
  FROM public.class_sessions s
  JOIN public.enrolments e
    ON e.cohort_id = s.cohort_id
   AND e.student_id = v_student_id
   AND e.dropped_on IS NULL
   AND e.enrolled_on <= s.session_date
  WHERE upper(btrim(s.pin)) = v_pin
    AND public.session_is_live(s);

  IF v_matches = 0 THEN
    -- ONE message for "not enrolled in that cohort" and "no such student".
    -- Separating them would let anyone with a student ID — a number printed on
    -- a card — find out who is in which class.
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'not_for_you',
      'error',   'That code is not valid for your ID. Check your Student ID, '
                 'and that this is your class.');
  END IF;

  IF v_matches > 1 THEN
    -- Should be unreachable: the open-PIN index and the one-enrolment-per-class
    -- constraint together forbid it. Refuse rather than guess which class.
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'ambiguous',
      'error',   'That code matches more than one of your classes. Please tell '
                 'your TA.');
  END IF;

  SELECT s.* INTO v_session
  FROM public.class_sessions s
  JOIN public.enrolments e
    ON e.cohort_id = s.cohort_id
   AND e.student_id = v_student_id
   AND e.dropped_on IS NULL
   AND e.enrolled_on <= s.session_date
  WHERE upper(btrim(s.pin)) = v_pin
    AND public.session_is_live(s);

  SELECT state INTO v_existing
  FROM public.attendance_records
  WHERE session_id = v_session.id AND student_id = v_student_id;

  IF v_existing IS NOT NULL AND v_existing IN ('present', 'late') THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason',  'already_marked',
      'error',   'You have already marked your attendance for this session.');
  END IF;

  -- 048: one definition, shared with anything else that has to decide this.
  v_state := public.session_mark_state(v_session, now());

  -- ON CONFLICT, not a prior read: close_session may have written an unexcused
  -- row for this student between the check above and this insert.
  INSERT INTO public.attendance_records (
    session_id, class_id, student_id, state, marked_at, marked_by_role, method_used
  )
  VALUES (v_session.id, v_session.class_id, v_student_id, v_state, now(),
          'student', v_session.method)
  ON CONFLICT (session_id, student_id) DO UPDATE
    SET state          = EXCLUDED.state,
        marked_at      = EXCLUDED.marked_at,
        method_used    = EXCLUDED.method_used,
        -- 044: the student made this mark, whoever wrote the row it replaces.
        marked_by_role = EXCLUDED.marked_by_role
    WHERE public.attendance_records.state NOT IN ('present', 'late');

  SELECT * INTO v_student FROM public.students WHERE student_id = v_student_id;
  SELECT label INTO v_cohort FROM public.cohorts WHERE id = v_session.cohort_id;
  SELECT name, code INTO v_class_name, v_class_code
  FROM public.classes WHERE id = v_session.class_id;

  RETURN jsonb_build_object(
    'success', true,
    'name',    COALESCE(v_student.name, v_student_id),
    'cohort',  v_cohort,
    'class',   v_class_name,
    'class_code', v_class_code,
    'state',   v_state
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.mark_attendance(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_attendance(text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- open_due_sessions — copied from 033, with the upper bound made conditional
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_due_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id     uuid;
  v_opened integer := 0;
BEGIN
  FOR v_id IN
    SELECT s.id
    FROM public.class_sessions s
    WHERE s.status = 'scheduled'
      -- The allowance 028 defined: the point from which opening costs nothing.
      AND now() >= s.starts_at
                   - make_interval(mins => COALESCE(s.early_open_minutes, 0))
      AND now() <= CASE
        -- 048: a class whose check-in shuts at the start has nothing to open
        -- afterwards. Opening it at 09:20 would mint a PIN for a window
        -- session_closes_at already considers shut, and the dashboard would
        -- show a live code nobody can use. A TA who wants one opens by hand,
        -- which is what starts the grace window.
        WHEN COALESCE(s.closes_at_start, false) THEN s.starts_at
        -- 033: otherwise, any time until the class is over. Not until the
        -- check-in window would have shut — that is a much shorter thing, and
        -- using it meant a lecture in progress could no longer open itself.
        ELSE s.starts_at + make_interval(mins => COALESCE(s.duration_minutes, 60))
      END
    ORDER BY s.starts_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.mint_session_pin(v_id);
    v_opened := v_opened + 1;
  END LOOP;

  RETURN v_opened;
END;
$fn$;

REVOKE ALL ON FUNCTION public.open_due_sessions() FROM public;

COMMENT ON FUNCTION public.open_due_sessions() IS
  'Opens every scheduled session between its early-open allowance and the end '
  'of the class — or, where check-in shuts at the start (048), only up to that '
  'start. Opening late still gives a full check-in window, because 028 anchors '
  'that on whichever is later, the class start or the opening.';

-- ----------------------------------------------------------------------------
-- update_session — copied from 011, three settings wider
--
-- One session, for the day the lecturer wants the register shut at the door —
-- or the day it should not be. The weekly pattern is untouched, and
-- moved_manually still stops a later schedule save from undoing it.
--
-- The old seven-parameter version is dropped first, for the reason set out
-- under set_session_windows below: a second overload makes every existing call
-- ambiguous.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_session(
  uuid, date, time, integer, text, integer, integer);

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

REVOKE ALL ON FUNCTION public.update_session(
  uuid, date, time, integer, text, integer, integer, boolean, integer, boolean)
  FROM public;
GRANT EXECUTE ON FUNCTION public.update_session(
  uuid, date, time, integer, text, integer, integer, boolean, integer, boolean)
  TO authenticated;

-- ----------------------------------------------------------------------------
-- set_cohort_schedules — the same slots, three settings wider
--
-- The signature does not change: the slots arrive as jsonb, so this is new keys
-- rather than new parameters, and nothing needs dropping. A slot carrying none
-- of them inherits the class default, exactly as it already does for the three
-- windows beside them.
-- ----------------------------------------------------------------------------

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

  DELETE FROM public.cohort_schedules WHERE cohort_id = ANY (p_cohort_ids);

  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time,
    duration_minutes, auto_close_minutes, late_window_minutes,
    early_open_minutes, closes_at_start, grace_minutes, grace_counts_late)
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
    NULLIF(sl ->> 'grace_counts_late', '')::boolean
  FROM unnest(p_cohort_ids) AS c(cohort_id)
  CROSS JOIN jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
  ON CONFLICT (cohort_id, weekday, start_time) DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_created := v_added;

  RETURN v_created;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- generate_sessions — copied from 029, carrying the three new settings
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_sessions(
  p_class_id  uuid,
  p_cohort_id uuid DEFAULT NULL,
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class   public.classes%ROWTYPE;
  v_from    date;
  v_to      date;
  v_created integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  v_from := COALESCE(p_from, v_class.term_starts_on);
  v_to   := COALESCE(p_to,   v_class.term_ends_on);

  IF v_to < v_from THEN
    RAISE EXCEPTION 'generate_sessions: % is before %', v_to, v_from;
  END IF;

  WITH candidate AS (
    SELECT
      s.id   AS schedule_id,
      s.cohort_id,
      d::date AS on_date,
      -- Build the instant from the class's own wall clock, not the server's.
      ((d::date + s.start_time) AT TIME ZONE v_class.timezone) AS starts_at,
      COALESCE(s.duration_minutes,    v_class.default_duration_minutes)    AS duration_minutes,
      COALESCE(s.delivery_mode,       v_class.default_delivery_mode)       AS delivery_mode,
      COALESCE(s.auto_close_minutes,  v_class.default_auto_close_minutes)  AS auto_close_minutes,
      COALESCE(s.late_window_minutes, v_class.default_late_window_minutes) AS late_window_minutes,
      -- The slot's own, falling back to the class default when it has none —
      -- the same shape the other two windows already use.
      COALESCE(s.early_open_minutes, v_class.default_early_open_minutes)   AS early_open_minutes,
      -- 048, on that same path.
      COALESCE(s.closes_at_start,   v_class.default_closes_at_start)       AS closes_at_start,
      COALESCE(s.grace_minutes,     v_class.default_grace_minutes)         AS grace_minutes,
      COALESCE(s.grace_counts_late, v_class.default_grace_counts_late)     AS grace_counts_late
    FROM public.cohort_schedules s
    CROSS JOIN LATERAL generate_series(v_from, v_to, INTERVAL '1 day') AS d
    WHERE s.class_id = p_class_id
      AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
      AND EXTRACT(DOW FROM d)::smallint = s.weekday
      AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
      AND (s.effective_until IS NULL OR d::date <= s.effective_until)
  ),
  inserted AS (
    INSERT INTO public.class_sessions (
      class_id, cohort_id, schedule_id, starts_at, session_date,
      duration_minutes, delivery_mode, status, method,
      late_window_minutes, auto_close_minutes, early_open_minutes,
      closes_at_start, grace_minutes, grace_counts_late
    )
    SELECT
      p_class_id, c.cohort_id, c.schedule_id, c.starts_at, c.on_date,
      c.duration_minutes, c.delivery_mode, 'scheduled', v_class.default_method,
      c.late_window_minutes,
      c.auto_close_minutes,
      c.early_open_minutes,
      c.closes_at_start,
      c.grace_minutes,
      c.grace_counts_late
    FROM candidate c
    ON CONFLICT (cohort_id, starts_at) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- set_session_windows — the same bulk apply, three settings wider
--
-- The old four-parameter version is dropped first. Adding parameters with
-- defaults leaves the previous signature in place as a second overload, and a
-- call naming only the old parameters then matches both — which PostgREST
-- reports as "could not choose the best candidate function", on a screen that
-- was working the day before. The same lesson as update_class in 046.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.set_session_windows(uuid, uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.set_session_windows(
  p_class_id           uuid,
  p_cohort_id          uuid    DEFAULT NULL,
  p_auto_close_minutes integer DEFAULT NULL,
  p_early_open_minutes integer DEFAULT NULL,
  p_closes_at_start    boolean DEFAULT NULL,
  p_grace_minutes      integer DEFAULT NULL,
  p_grace_counts_late  boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_today    date;
  v_slots    integer := 0;
  v_sessions integer := 0;
  v_kept     integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that class does not exist';
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_auto_close_minutes IS NULL AND p_early_open_minutes IS NULL
     AND p_closes_at_start IS NULL AND p_grace_minutes IS NULL
     AND p_grace_counts_late IS NULL THEN
    RAISE EXCEPTION 'nothing to change: give a sign-up window, an early-open time, or a closing rule';
  END IF;

  -- Upper bounds catch a slipped digit. A 900-minute sign-up window is almost
  -- certainly a typo for 90, and it would leave check-in open all day.
  IF p_auto_close_minutes IS NOT NULL
     AND (p_auto_close_minutes < 1 OR p_auto_close_minutes > 600) THEN
    RAISE EXCEPTION 'the sign-up window must be between 1 and 600 minutes, not %',
      p_auto_close_minutes;
  END IF;

  IF p_early_open_minutes IS NOT NULL
     AND (p_early_open_minutes < 0 OR p_early_open_minutes > 600) THEN
    RAISE EXCEPTION 'opening early must be between 0 and 600 minutes, not %',
      p_early_open_minutes;
  END IF;

  -- 048. Narrow on purpose: a grace window is a way to take a register after a
  -- late start, and an hour of it is the behaviour this setting exists to stop.
  IF p_grace_minutes IS NOT NULL
     AND (p_grace_minutes < 1 OR p_grace_minutes > 30) THEN
    RAISE EXCEPTION 'the grace window must be between 1 and 30 minutes, not %',
      p_grace_minutes;
  END IF;

  IF p_cohort_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cohorts
    WHERE id = p_cohort_id AND class_id = p_class_id
  ) THEN
    RAISE EXCEPTION 'that cohort is not part of this class';
  END IF;

  -- Today in the class's timezone, not the server's. A class in Accra and a
  -- server in UTC disagree about the date for part of every day.
  v_today := (now() AT TIME ZONE v_class.timezone)::date;

  -- Class defaults, only when the whole class was chosen. A setting for one
  -- cohort must not become what every other cohort inherits.
  IF p_cohort_id IS NULL THEN
    UPDATE public.classes
       SET default_auto_close_minutes =
             COALESCE(p_auto_close_minutes, default_auto_close_minutes),
           default_early_open_minutes =
             COALESCE(p_early_open_minutes, default_early_open_minutes),
           default_closes_at_start =
             COALESCE(p_closes_at_start, default_closes_at_start),
           default_grace_minutes =
             COALESCE(p_grace_minutes, default_grace_minutes),
           default_grace_counts_late =
             COALESCE(p_grace_counts_late, default_grace_counts_late)
     WHERE id = p_class_id;
  END IF;

  UPDATE public.cohort_schedules
     SET auto_close_minutes = COALESCE(p_auto_close_minutes, auto_close_minutes),
         early_open_minutes = COALESCE(p_early_open_minutes, early_open_minutes),
         closes_at_start    = COALESCE(p_closes_at_start, closes_at_start),
         grace_minutes      = COALESCE(p_grace_minutes, grace_minutes),
         grace_counts_late  = COALESCE(p_grace_counts_late, grace_counts_late)
   WHERE class_id = p_class_id
     AND (p_cohort_id IS NULL OR cohort_id = p_cohort_id);
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  -- Counted before the update, so `kept` describes exactly the sessions the
  -- update is about to skip.
  SELECT count(*) INTO v_kept
  FROM public.class_sessions s
  WHERE s.class_id = p_class_id
    AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
    AND s.status = 'scheduled'
    AND s.session_date >= v_today
    AND EXISTS (SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id);

  UPDATE public.class_sessions s
     SET auto_close_minutes = COALESCE(p_auto_close_minutes, s.auto_close_minutes),
         early_open_minutes = COALESCE(p_early_open_minutes, s.early_open_minutes),
         closes_at_start    = COALESCE(p_closes_at_start, s.closes_at_start),
         grace_minutes      = COALESCE(p_grace_minutes, s.grace_minutes),
         grace_counts_late  = COALESCE(p_grace_counts_late, s.grace_counts_late)
   WHERE s.class_id = p_class_id
     AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
     AND s.status = 'scheduled'
     AND s.session_date >= v_today
     AND NOT EXISTS (
       SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
     );
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN jsonb_build_object(
    'slots',            v_slots,
    'sessions',         v_sessions,
    'kept',             v_kept,
    'defaults_updated', p_cohort_id IS NULL
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_session_windows(
  uuid, uuid, integer, integer, boolean, integer, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_session_windows(
  uuid, uuid, integer, integer, boolean, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_session_windows(
  uuid, uuid, integer, integer, boolean, integer, boolean) IS
  'Set the sign-up window, early-open time and closing rule (048) for one '
  'cohort, or the whole class when cohort is NULL: its weekly slots, its '
  'upcoming scheduled sessions, and — for a whole-class change — the class '
  'defaults. Sessions open, closed, past, or with attendance are left alone.';
