-- ============================================================================
-- 028 — open check-in before class without spending the window on it
--
-- THE PROBLEM
--
-- The check-in window ran from the moment the TA pressed Open. A TA who opened
-- five minutes early so students could mark as they walked in lost five minutes
-- of the window, and one who opened fifteen minutes early lost the lot — the
-- session closed itself before the class had started.
--
-- So opening early was punished, and the setting that was supposed to allow it
-- did nothing at all: early_open_minutes has been written into every session
-- since 002 — inherited from classes.default_early_open_minutes, default 5 —
-- and never read by anything. A column carried through three migrations and
-- consulted by none of them.
--
-- THE RULE, IN ONE PLACE
--
-- Two helpers below define the window, and everything that asks "is check-in
-- live?" calls them. That is the point of writing it this way: the previous
-- arrangement had the same arithmetic inline in mark_attendance twice, in
-- open_session, and in get_open_session_summary, which is four chances for a
-- change to reach three of them.
--
--   opens  at  GREATEST(opened_at, starts_at - early_open_minutes)
--   closes at  GREATEST(opened_at, starts_at) + auto_close_minutes
--
-- Read the GREATEST in each case as "whichever is later".
--
--   Opened EARLY, 09:00 class, 15 minute window, opened 08:45:
--     opens 08:45 — students mark as they arrive
--     closes 09:15 — the window starts counting at the class, not at the click
--
--   Opened LATE, same class, opened 09:10:
--     opens 09:10, closes 09:25 — a full window from opening, which is what
--     006 already intended: a session opened late should still accept marks for
--     its whole length.
--
--   Opened EARLIER than early_open allows, opened 08:00 with early_open 15:
--     opens 08:45 — the setting is a permission, not just a convenience, so
--     the door does not open before the class says it may.
--
-- Lateness moves to the same anchor. Measured from opened_at, somebody marking
-- at 08:50 for a 09:00 class could be recorded LATE before the class had begun,
-- which is the kind of wrong nobody checks until a student disputes it.
--
-- Run AFTER 027. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- When check-in opens and closes
--
-- NULL opened_at means the session has never been opened. Both return NULL
-- there rather than guessing, and every caller already treats "not opened" as
-- its own case.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.session_opens_at(s public.class_sessions)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN s.opened_at IS NULL THEN NULL
    ELSE GREATEST(
           s.opened_at,
           s.starts_at - make_interval(mins => COALESCE(s.early_open_minutes, 0)))
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.session_closes_at(s public.class_sessions)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN s.opened_at IS NULL THEN NULL
    ELSE GREATEST(s.opened_at, s.starts_at)
         + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
  END;
$fn$;

/*
 * Is check-in live right now?
 *
 * A session that has never been opened is not live. One that is open is live
 * between the two times above. Kept as a function rather than repeated as a
 * predicate because it is asked in three places and got a different answer in
 * each of them before this.
 */
CREATE OR REPLACE FUNCTION public.session_is_live(s public.class_sessions)
RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT s.status = 'open'
     AND s.opened_at IS NOT NULL
     AND now() >= public.session_opens_at(s)
     AND now() <= public.session_closes_at(s);
$fn$;

COMMENT ON FUNCTION public.session_is_live(public.class_sessions) IS
  'Whether check-in is accepting marks. Opens early_open_minutes before the '
  'class starts, closes auto_close_minutes after it starts — so opening early '
  'does not spend the window, and opening late still gives a full one.';

-- ----------------------------------------------------------------------------
-- What the check-in page shows before anybody types
--
-- Same two keys as before: 026 asserts that this returns a count and a closing
-- time and nothing else, because it is readable by anyone who loads the page.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_open_session_summary()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'open_count', count(*),
    'closes_at',  min(public.session_closes_at(s))
  )
  FROM public.class_sessions s
  WHERE public.session_is_live(s);
$fn$;

REVOKE ALL ON FUNCTION public.get_open_session_summary() FROM public;
GRANT EXECUTE ON FUNCTION public.get_open_session_summary() TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- open_session reports the real closing time
--
-- It reported opened_at + auto_close, which after this is simply wrong for a
-- session opened early: the TA would be told 09:00 while the door stays open
-- until 09:15.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_session(
  p_session_id uuid,
  p_pin        text DEFAULT NULL,
  p_minutes    integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session  public.class_sessions%ROWTYPE;
  v_pin      text;
  v_try      integer := 0;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session';
  END IF;

  IF NOT public.can_manage_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to open this session';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RAISE EXCEPTION 'this session was cancelled; uncancel it before opening';
  END IF;

  IF p_pin IS NOT NULL AND btrim(p_pin) <> '' THEN
    UPDATE public.class_sessions
       SET status = 'open',
           pin = btrim(p_pin),
           auto_close_minutes = COALESCE(p_minutes, auto_close_minutes),
           opened_at = now()
     WHERE id = p_session_id;
  ELSE
    -- Retry against the partial unique index on open PINs rather than assuming
    -- a random five characters is free.
    LOOP
      v_try := v_try + 1;
      SELECT string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet))::int + 1), 1), '')
        INTO v_pin
      FROM generate_series(1, 5);

      BEGIN
        UPDATE public.class_sessions
           SET status = 'open',
               pin = v_pin,
               auto_close_minutes = COALESCE(p_minutes, auto_close_minutes),
               opened_at = now()
         WHERE id = p_session_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_try >= 10 THEN
          RAISE EXCEPTION 'could not find a free PIN after % attempts', v_try;
        END IF;
      END;
    END LOOP;
  END IF;

  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'session_id', v_session.id,
    'pin',        v_session.pin,
    'opened_at',  v_session.opened_at,
    -- Both, because "it is open but nobody can mark yet" is a state a TA who
    -- opened early needs to see rather than deduce from a silent room.
    'opens_at',   public.session_opens_at(v_session),
    'closes_at',  public.session_closes_at(v_session)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.open_session(uuid, text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.open_session(uuid, text, integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- Check-in, asking the same question everything else asks
--
-- The window arithmetic was inline here twice. It now calls session_is_live,
-- so a session that is live for the summary is live for a student too.
--
-- One refusal is added: "not open yet". A student who arrives before check-in
-- opens was previously told the code was wrong, which is both false and the
-- one refusal they cannot act on. It is decided PIN-only, like the other two
-- named refusals, so it still says nothing about who is asking.
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

  -- Late is measured from whichever is later, the class starting or the TA
  -- opening. From opened_at alone, somebody marking at 08:50 for a 09:00 class
  -- opened at 08:45 would be recorded LATE before the class had begun — the
  -- kind of wrong nobody notices until a student disputes it.
  v_state := CASE
    WHEN v_session.opened_at IS NOT NULL
         AND now() > GREATEST(v_session.opened_at, v_session.starts_at)
                     + make_interval(mins => v_session.late_window_minutes)
    THEN 'late'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;

  -- ON CONFLICT, not a prior read: close_session may have written an unexcused
  -- row for this student between the check above and this insert.
  INSERT INTO public.attendance_records (
    session_id, class_id, student_id, state, marked_at, marked_by_role, method_used
  )
  VALUES (v_session.id, v_session.class_id, v_student_id, v_state, now(),
          'student', v_session.method)
  ON CONFLICT (session_id, student_id) DO UPDATE
    SET state       = EXCLUDED.state,
        marked_at   = EXCLUDED.marked_at,
        method_used = EXCLUDED.method_used
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
