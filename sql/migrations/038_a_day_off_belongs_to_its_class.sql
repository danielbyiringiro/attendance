-- ============================================================================
-- 038 — a day off cannot name a cohort from another class
--
-- 036 shipped this constraint:
--
--   CONSTRAINT no_class_days_class_agrees CHECK (cohort_id IS NULL OR true)
--
-- which is a tautology. It reads like a guard and enforces nothing. I wrote it
-- as a placeholder and left it in, so the table has been accepting rows whose
-- class_id and cohort_id belong to different classes.
--
-- WHAT THAT DOES AND DOES NOT ALLOW
--
-- It is not a leak. is_no_class_day requires d.class_id to match before it even
-- looks at the cohort, so a mismatched row matches nothing and silently affects
-- no class at all. Nobody's sessions can be blocked or exempted by another
-- class's declaration.
--
-- What it does allow is junk: a row asserting that class A has a day off scoped
-- to a cohort of class B. It would list on A's screen under a cohort label that
-- does not resolve, do nothing, and resist explanation.
--
-- enrolments has had this exactly right since 001 — assert_enrolment_class, a
-- BEFORE trigger comparing the two — because the same pair of columns carries
-- the same risk there. This is that trigger, for this table. A CHECK cannot do
-- it: the answer lives in another row, in another table.
--
-- AND A SECOND THING, WHICH THE TEST FOUND
--
-- 036's own header claims create_ad_hoc_session "checks first and refuses by
-- name" on a declared day. It never did. The BEFORE INSERT trigger returns NULL
-- and skips the row silently — which is right for the bulk paths, where
-- generating a term should quietly produce fewer sessions — but
-- create_ad_hoc_session then ran `RETURNING id INTO v_id` against a row that was
-- never inserted, got NULL, and returned a perfectly ordinary-looking result
-- with a null session_id. The screen said "Session added" and nothing existed.
--
-- Silent skipping is correct for a generator and wrong for a person who chose
-- the date. The check the comment described is below.
--
-- Run AFTER 037. Idempotent.
-- ============================================================================

-- Drop the tautology. It never rejected anything, so nothing can fail here.
ALTER TABLE public.no_class_days
  DROP CONSTRAINT IF EXISTS no_class_days_class_agrees;

CREATE OR REPLACE FUNCTION public.assert_no_class_day_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_class_id uuid;
BEGIN
  -- NULL means the whole class, which is the common case and needs no check.
  IF NEW.cohort_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT class_id INTO v_class_id FROM public.cohorts WHERE id = NEW.cohort_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', NEW.cohort_id;
  END IF;

  IF NEW.class_id IS DISTINCT FROM v_class_id THEN
    RAISE EXCEPTION
      'a day off for class % cannot be scoped to cohort %, which belongs to class %',
      NEW.class_id, NEW.cohort_id, v_class_id;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_no_class_day_class ON public.no_class_days;
CREATE TRIGGER trg_no_class_day_class
  BEFORE INSERT OR UPDATE ON public.no_class_days
  FOR EACH ROW EXECUTE FUNCTION public.assert_no_class_day_class();

COMMENT ON FUNCTION public.assert_no_class_day_class() IS
  'A day off scoped to a cohort must name a cohort of its own class. The same '
  'guard assert_enrolment_class applies to enrolments, for the same reason: the '
  'agreement is between two tables, so a CHECK cannot express it.';

-- ----------------------------------------------------------------------------
-- Refuse, out loud, rather than returning a session that was never created
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_ad_hoc_session(
  p_cohort_id        uuid,
  p_date             date,
  p_start_time       time,
  p_duration_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class  public.classes%ROWTYPE;
  v_cohort public.cohorts%ROWTYPE;
  v_starts timestamptz;
  v_id     uuid;
  v_reason text;
BEGIN
  SELECT * INTO v_cohort FROM public.cohorts WHERE id = p_cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that cohort does not exist';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_cohort.class_id;

  IF NOT public.can_manage_class(v_class.id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_date IS NULL OR p_start_time IS NULL THEN
    RAISE EXCEPTION 'a date and a start time are both required';
  END IF;

  IF COALESCE(p_duration_minutes, v_class.default_duration_minutes) <= 0 THEN
    RAISE EXCEPTION 'a session has to last longer than zero minutes';
  END IF;

  -- The check 036 said was here. Named, with the reason the TA typed when they
  -- declared the day, because "that did not work" is not an answer to "why".
  IF public.is_no_class_day(v_class.id, p_cohort_id, p_date) THEN
    SELECT d.reason INTO v_reason
    FROM public.no_class_days d
    WHERE d.class_id = v_class.id
      AND d.on_date = p_date
      AND (d.cohort_id IS NULL OR d.cohort_id = p_cohort_id)
    LIMIT 1;

    RAISE EXCEPTION
      '% is set as a day this class does not meet (%). Remove the day off first.',
      p_date, COALESCE(v_reason, 'no reason recorded');
  END IF;

  v_starts := ((p_date + p_start_time) AT TIME ZONE v_class.timezone);

  IF EXISTS (
    SELECT 1 FROM public.class_sessions
    WHERE cohort_id = p_cohort_id AND starts_at = v_starts
  ) THEN
    RAISE EXCEPTION
      'this cohort already has a session at that time on %', p_date;
  END IF;

  INSERT INTO public.class_sessions (
    class_id, cohort_id, schedule_id, starts_at, session_date,
    duration_minutes, delivery_mode, status, method,
    late_window_minutes, auto_close_minutes, early_open_minutes,
    moved_manually
  )
  VALUES (
    v_class.id, p_cohort_id, NULL, v_starts, p_date,
    COALESCE(p_duration_minutes, v_class.default_duration_minutes),
    v_class.default_delivery_mode, 'scheduled', v_class.default_method,
    v_class.default_late_window_minutes,
    v_class.default_auto_close_minutes,
    v_class.default_early_open_minutes,
    true
  )
  RETURNING id INTO v_id;

  -- Belt and braces. The check above covers the known way a row gets skipped,
  -- and any future BEFORE trigger returning NULL would land here instead of
  -- handing back a result naming a session that does not exist.
  IF v_id IS NULL THEN
    RAISE EXCEPTION
      'the session was not created, and the database did not say why';
  END IF;

  RETURN jsonb_build_object(
    'session_id',   v_id,
    'starts_at',    v_starts,
    'session_date', p_date,
    'cohort',       v_cohort.label,
    'outside_term', p_date < v_class.term_starts_on
                 OR p_date > v_class.term_ends_on
  );
END;
$fn$;

COMMENT ON FUNCTION public.create_ad_hoc_session(uuid, date, time, integer) IS
  'One session on one date, outside the weekly pattern. Flagged moved_manually '
  'so a schedule change neither moves nor deletes it. Refuses a declared day '
  'off by name, and never returns an id for a row that was not inserted.';
