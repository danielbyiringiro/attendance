-- ============================================================================
-- 063 — add time to check-in while it is open
--
-- A lecturer watching the countdown run out with half the room still queuing
-- at the door had two choices: let it close, or close it and open it again,
-- which mints a new PIN everybody then has to be shown. Neither is what they
-- wanted, which was "five more minutes".
--
-- WHY A COLUMN, AND NOT A BIGGER auto_close_minutes
--
-- Check-in closes under one of three rules (048): the sign-up window after the
-- later of opening and the start; at the start itself; or a grace window after
-- a late open. Only the first reads auto_close_minutes. Raising it would do
-- nothing at all to a class that closes at the start, and raising
-- grace_minutes runs into its 1-30 bound. extra_minutes is added on top of
-- whichever rule is in force, so "add five minutes" means the same thing for
-- every class.
--
-- Everything that decides whether check-in is open already asks
-- session_closes_at — mark_attendance through session_is_live, and the sweep's
-- closer (031) — so redefining it here is the whole of the change for them.
--
-- WHAT A MARK IN THE EXTRA TIME COUNTS AS
--
-- Whatever session_mark_state already says, unchanged. On the ordinary rule
-- that is late once late_window_minutes have passed, as it would be for any
-- mark that late. For a class that closes at the start, time added before the
-- start is on time and time added after it follows the same late window. In a
-- grace window it is whatever grace_counts_late says.
--
-- ADDING TIME AFTER IT RAN OUT
--
-- The sweep closes an expired session within the minute, but a click can land
-- in that minute. Extending a deadline that has already passed by five
-- minutes would leave it still in the past, so the added time is measured from
-- now when the window is already over: "five more minutes" is always five more
-- minutes from the click. Once the sweep has closed the session it is closed,
-- and this refuses — reopening is a different, deliberate act.
--
-- THE DISPLAY SCREEN
--
-- get_class_display hands a signed-out screen the fields it computes the
-- window from. It is redefined to carry extra_minutes, and also the three 048
-- fields it never did carry: a screen showing a class that closes at the start
-- was counting down to a closing time the server was not using.
--
-- Run AFTER 062. Idempotent.
-- ============================================================================

ALTER TABLE public.class_sessions
  ADD COLUMN IF NOT EXISTS extra_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE public.class_sessions DROP CONSTRAINT IF EXISTS class_sessions_extra_minutes_check;
ALTER TABLE public.class_sessions
  ADD CONSTRAINT class_sessions_extra_minutes_check
  CHECK (extra_minutes BETWEEN 0 AND 240);

COMMENT ON COLUMN public.class_sessions.extra_minutes IS
  'Minutes added to check-in while it was open (063), on top of whichever '
  'closing rule applies. 0-240.';

-- ----------------------------------------------------------------------------
-- When check-in closes — 048's rule, plus the added time
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
    -- Opened after it: a grace window measured from the click.
    ELSE s.opened_at + make_interval(mins => COALESCE(s.grace_minutes, 5))
  END
  -- 063: time added while it was open, whichever rule set the base.
  + make_interval(mins => COALESCE(s.extra_minutes, 0));
$fn$;

COMMENT ON FUNCTION public.session_closes_at(public.class_sessions) IS
  'When check-in stops accepting marks: auto_close_minutes after the later of '
  'opening and the class start, or — with closes_at_start (048) — at the class '
  'start, or grace_minutes after a session opened later than that; plus any '
  'extra_minutes added while it was open (063).';

-- ----------------------------------------------------------------------------
-- extend_check_in
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.extend_check_in(
  p_session_id uuid,
  p_minutes    integer
)
RETURNS public.class_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_closes  timestamptz;
  v_add     integer;
BEGIN
  -- Locked, so two people pressing "+5" at once add ten, not five.
  SELECT * INTO v_session FROM public.class_sessions
   WHERE id = p_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that session does not exist';
  END IF;

  IF NOT public.can_manage_class(v_session.class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF v_session.status <> 'open' OR v_session.opened_at IS NULL THEN
    RAISE EXCEPTION
      'check-in is not open for this session, so there is no time to add to';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 60 THEN
    RAISE EXCEPTION 'add between 1 and 60 minutes at a time, not %', p_minutes;
  END IF;

  v_closes := public.session_closes_at(v_session);

  -- Already past: measured from now, so the added time is all still to come.
  v_add := p_minutes + CASE
    WHEN v_closes < now()
    THEN ceil(extract(epoch FROM now() - v_closes) / 60)::integer
    ELSE 0
  END;

  IF v_session.extra_minutes + v_add > 240 THEN
    RAISE EXCEPTION
      'check-in has already been extended by % minutes; it cannot be extended past four hours in all',
      v_session.extra_minutes;
  END IF;

  UPDATE public.class_sessions
     SET extra_minutes = extra_minutes + v_add
   WHERE id = p_session_id
  RETURNING * INTO v_session;

  RETURN v_session;
END;
$fn$;

REVOKE ALL ON FUNCTION public.extend_check_in(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.extend_check_in(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.extend_check_in(uuid, integer) IS
  'Add 1-60 minutes to an open session''s check-in, keeping its PIN. Measured '
  'from now when the window has already run out. At most 240 minutes in all '
  '(063).';

-- ----------------------------------------------------------------------------
-- get_class_display — 044, with the fields that decide the closing time
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_class_display(p_token text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_max_attempts constant integer := 10;
  c_refused      constant jsonb   := jsonb_build_object('ok', false, 'reason', 'refused');
  v_link  public.class_display_links%ROWTYPE;
  v_class public.classes%ROWTYPE;
  v_today date;
BEGIN
  IF p_token IS NULL OR p_code IS NULL
     OR length(p_token) > 128 OR length(p_code) > 64 THEN
    RETURN c_refused;
  END IF;

  SELECT * INTO v_link FROM public.class_display_links WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN c_refused;
  END IF;

  IF v_link.failed_attempts >= c_max_attempts THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'locked');
  END IF;

  -- Forgiving about how it was typed: case, spaces and dashes do not matter.
  -- src/lib/classDisplay.ts normalises the same way, in the same order.
  IF upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g')) <> v_link.access_code THEN
    UPDATE public.class_display_links
       SET failed_attempts = failed_attempts + 1
     WHERE class_id = v_link.class_id;
    RETURN c_refused;
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_link.class_id;
  IF v_class.archived_at IS NOT NULL THEN
    RETURN c_refused;
  END IF;

  -- Today where the class is, not where the server is.
  v_today := (now() AT TIME ZONE v_class.timezone)::date;

  RETURN jsonb_build_object(
    'ok',         true,
    'class_name', v_class.name,
    'class_code', v_class.code,
    'timezone',   v_class.timezone,
    -- Anything open, whatever its date, and today's sessions not yet opened.
    -- Closed and cancelled sessions have nothing left to show.
    'sessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',                  s.id,
               'cohort_label',        co.label,
               'status',              s.status,
               -- The PIN only while open. A scheduled session's PIN is not yet
               -- a code anyone should be able to read.
               'pin',                 CASE WHEN s.status = 'open' THEN s.pin END,
               'starts_at',           s.starts_at,
               'opened_at',           s.opened_at,
               'closed_at',           s.closed_at,
               'duration_minutes',    s.duration_minutes,
               'early_open_minutes',  s.early_open_minutes,
               'auto_close_minutes',  s.auto_close_minutes,
               'late_window_minutes', s.late_window_minutes,
               -- 063: the 048 rule's fields, which this never carried, and the
               -- added time. Without them the screen counts down to the wrong
               -- moment.
               'closes_at_start',     s.closes_at_start,
               'grace_minutes',       s.grace_minutes,
               'grace_counts_late',   s.grace_counts_late,
               'extra_minutes',       s.extra_minutes,
               -- 044: students who checked themselves in, for the beep. A
               -- count only; a TA's mark is not a check-in arriving.
               'checked_in', (
                 SELECT count(*)
                 FROM public.attendance_records a
                 WHERE a.session_id = s.id
                   AND a.marked_by_role = 'student'
                   AND a.state IN ('present', 'late'))
             ) ORDER BY s.starts_at, co.label)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      WHERE s.class_id = v_class.id
        AND (s.status = 'open'
             OR (s.status = 'scheduled' AND s.session_date = v_today))
    ), '[]'::jsonb),
    -- So an idle screen can say when it will next have something to show.
    'next', (
      SELECT jsonb_build_object('starts_at', s.starts_at, 'cohort_label', co.label)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      WHERE s.class_id = v_class.id
        AND s.status = 'scheduled'
        AND s.starts_at > now()
      ORDER BY s.starts_at
      LIMIT 1
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_class_display(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_class_display(text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_class_display(text, text) IS
  'For a screen that is not signed in: with a class''s display token and its '
  'current access code, the class''s open and upcoming-today sessions, with the '
  'PIN of any that is open, how many students have checked in (044), and what '
  'decides when each closes (063). Ten wrong codes lock the link. See 041.';
