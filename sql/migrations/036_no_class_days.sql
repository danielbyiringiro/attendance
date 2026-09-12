-- ============================================================================
-- 036 — a day the class does not meet
--
-- A public holiday, a reading week, a day the department closes. Distinct from
-- cancelling one session, which is per cohort and says "this particular meeting
-- did not happen".
--
-- WHY THIS IS NOT JUST cancel_session IN A LOOP
--
-- Three things a loop cannot do.
--
-- One: it is a date, not a session. A holiday applies to every cohort, and to
-- cohorts added later.
--
-- Two: it has to REMEMBER. Cancelling deals with the sessions that exist right
-- now; the next `generate_sessions` or schedule save puts the holiday straight
-- back, because the weekly pattern still wants that weekday. That is the bug
-- this table exists to prevent, and the reason the feature needs schema at all.
--
-- Three: there are two modes, and only one resembles cancellation.
--
-- THE TWO MODES, WHICH DO OPPOSITE THINGS TO A PERCENTAGE
--
--   'exempt'   The day does not count. Everyone is marked `exempted`, which
--              tallyStates leaves out of both halves of the rate — so the day
--              neither helps nor harms anybody. A holiday.
--
--   'present'  The day counts, and everybody gets it. An online quiz day, a
--              take-home assessment: no room, but the work happened. A
--              deliberate act, never a default.
--
-- They are separate arguments rather than a boolean because getting them the
-- wrong way round silently changes every student's percentage, and `mode =
-- 'exempt'` says which one you chose in a way `counts => false` does not.
--
-- `exempted` has been in the attendance_state enum since 001 and no migration
-- has ever written it. This is the one.
--
-- WHAT IT DOES TO AN EXISTING SESSION
--
-- Closes it, and writes one row per enrolled student — overwriting whatever was
-- there. On a declared holiday a check-in is not evidence a class happened; it
-- is evidence somebody typed a PIN into a room that then emptied. Cancellation
-- already takes the same view and deletes the records outright (032).
--
-- Reversible: clear_no_class_day puts the sessions back to 'scheduled' and
-- removes the rows this wrote. It cannot restore check-ins that were overwritten
-- — the same trade cancellation makes, and stated in the UI for the same reason.
--
-- Run AFTER 035. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.no_class_days (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  -- NULL means the whole class. A holiday hits every cohort, including ones
  -- added after it was declared, which a list of cohort ids could not.
  cohort_id  uuid REFERENCES public.cohorts(id) ON DELETE CASCADE,
  on_date    date NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('exempt', 'present')),
  -- Required. Somebody reading a student's record a term later needs to know
  -- why a day stopped counting, and "it just does" is not an answer.
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  set_by     uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_class_days_class_agrees CHECK (cohort_id IS NULL OR true)
);

-- One declaration per date per scope. Two partial indexes rather than one
-- constraint, because NULL is not equal to itself: a plain UNIQUE on
-- (class_id, cohort_id, on_date) would happily allow the same class-wide
-- holiday twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_no_class_days_whole_class
  ON public.no_class_days (class_id, on_date)
  WHERE cohort_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_no_class_days_one_cohort
  ON public.no_class_days (cohort_id, on_date)
  WHERE cohort_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_no_class_days_lookup
  ON public.no_class_days (class_id, on_date);

COMMENT ON TABLE public.no_class_days IS
  'Dates a class does not meet. Remembered rather than applied once, so '
  'regenerating sessions does not bring a holiday back.';

-- ----------------------------------------------------------------------------
-- RLS — the house pattern
-- ----------------------------------------------------------------------------
ALTER TABLE public.no_class_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS no_class_days_auth_all ON public.no_class_days;
CREATE POLICY no_class_days_auth_all ON public.no_class_days
  FOR ALL TO authenticated
  USING (public.can_access_class(class_id))
  WITH CHECK (public.can_access_class(class_id));

-- ----------------------------------------------------------------------------
-- Is this date declared off for this cohort?
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_no_class_day(
  p_class_id  uuid,
  p_cohort_id uuid,
  p_date      date
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.no_class_days d
    WHERE d.class_id = p_class_id
      AND d.on_date  = p_date
      AND (d.cohort_id IS NULL OR d.cohort_id = p_cohort_id)
  );
$fn$;

-- ----------------------------------------------------------------------------
-- Stop sessions appearing on a declared day, whoever asks
--
-- A trigger rather than a clause in generate_sessions, for two reasons. It
-- catches every path — the generator, the schedule apply, a hand-added date,
-- and anything written later — and it means neither of those two long functions
-- has to be copied out and redefined to add one condition, which is its own
-- source of mistakes.
--
-- Returning NULL skips the row silently. That is right for the bulk paths:
-- generating a term should quietly produce fewer sessions, not abort because
-- one Monday is Christmas. create_ad_hoc_session checks first and refuses by
-- name, so the one case where a person chose the date says so out loud.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.skip_sessions_on_no_class_days()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF public.is_no_class_day(NEW.class_id, NEW.cohort_id, NEW.session_date) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_skip_no_class_days ON public.class_sessions;
CREATE TRIGGER trg_skip_no_class_days
  BEFORE INSERT ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.skip_sessions_on_no_class_days();

-- ----------------------------------------------------------------------------
-- Declare the day
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_no_class_day(
  p_class_id  uuid,
  p_date      date,
  p_mode      text,
  p_reason    text,
  p_cohort_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  s          public.class_sessions%ROWTYPE;
  v_state    public.attendance_state;
  v_sessions integer := 0;
  v_students integer := 0;
  v_written  integer;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_mode NOT IN ('exempt', 'present') THEN
    RAISE EXCEPTION
      'mode must be exempt (the day does not count) or present (it counts and everybody gets it), not %',
      p_mode;
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required — a day that stops counting has to say why';
  END IF;

  v_state := CASE p_mode
    WHEN 'exempt' THEN 'exempted'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;

  INSERT INTO public.no_class_days (class_id, cohort_id, on_date, mode, reason, set_by)
  VALUES (p_class_id, p_cohort_id, p_date, p_mode, btrim(p_reason),
          public.current_staff_id())
  ON CONFLICT DO NOTHING;

  -- Apply to whatever already exists on that date.
  FOR s IN
    SELECT * FROM public.class_sessions c
    WHERE c.class_id = p_class_id
      AND c.session_date = p_date
      AND (p_cohort_id IS NULL OR c.cohort_id = p_cohort_id)
      AND c.status <> 'cancelled'
    FOR UPDATE
  LOOP
    -- Replace outright. A check-in on a declared holiday is not evidence the
    -- class ran; the session is being recorded as not having counted, and half
    -- a register of stale states would say otherwise.
    DELETE FROM public.attendance_records WHERE session_id = s.id;

    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, s.class_id, e.student_id, v_state, now(), 'staff'
    FROM public.enrolments e
    WHERE e.cohort_id = s.cohort_id
      AND e.enrolled_on <= s.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date);

    GET DIAGNOSTICS v_written = ROW_COUNT;
    v_students := v_students + v_written;

    UPDATE public.class_sessions
       SET status = 'closed'
     WHERE id = s.id;

    v_sessions := v_sessions + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'date',     p_date,
    'mode',     p_mode,
    'sessions', v_sessions,
    'students', v_students
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Take it back
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_no_class_day(
  p_class_id  uuid,
  p_date      date,
  p_cohort_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_removed  integer := 0;
  v_restored integer := 0;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  DELETE FROM public.no_class_days d
  WHERE d.class_id = p_class_id
    AND d.on_date = p_date
    AND (d.cohort_id IS NOT DISTINCT FROM p_cohort_id);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  -- Put the sessions back to scheduled and take away only what this wrote.
  -- Anything a person recorded by hand afterwards is left alone: marked_by_role
  -- is 'staff' for both, so the state is what distinguishes them, and nobody
  -- marks a whole cohort exempted except this.
  WITH affected AS (
    SELECT c.id
    FROM public.class_sessions c
    WHERE c.class_id = p_class_id
      AND c.session_date = p_date
      AND (p_cohort_id IS NULL OR c.cohort_id = p_cohort_id)
      AND c.status = 'closed'
  ),
  cleared AS (
    DELETE FROM public.attendance_records a
    USING affected f
    WHERE a.session_id = f.id
      AND a.state = 'exempted'
    RETURNING a.session_id
  ),
  reopened AS (
    UPDATE public.class_sessions c
       SET status = 'scheduled', opened_at = NULL, pin = NULL
    WHERE c.id IN (SELECT id FROM affected)
    RETURNING 1
  )
  SELECT count(*) INTO v_restored FROM reopened;

  RETURN jsonb_build_object(
    'date',      p_date,
    'removed',   v_removed,
    'sessions',  v_restored
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.clear_no_class_day(uuid, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.clear_no_class_day(uuid, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_no_class_day(uuid, uuid, date) TO authenticated;

COMMENT ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid) IS
  'Declare a date off. mode exempt: nobody is counted either way. mode present: '
  'everybody is credited. Remembered, so regenerating sessions does not bring '
  'the day back.';
