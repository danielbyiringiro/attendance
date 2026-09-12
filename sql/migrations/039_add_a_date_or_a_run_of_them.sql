-- ============================================================================
-- 039 — add one date, or the same weekday over a range
--
-- 035 adds a single session on a single date. Wanting the same slot every
-- Tuesday for the rest of term then means opening the dialog eleven times, and
-- the weekly pattern is not the answer either: that editor replaces a cohort's
-- slots wholesale and regenerates, which is a much larger hammer than "also
-- meet on Tuesday afternoons from here on".
--
-- So: the same call, with an end date. One session per matching weekday from
-- p_from to p_to inclusive. p_to = p_from is exactly 035's single date, which
-- is why this replaces it rather than sitting beside it.
--
-- STILL INSTANCES, NOT A RULE
--
-- Every session it creates is flagged moved_manually with no schedule_id, the
-- same as a single hand-added date. That is deliberate and it is the line
-- between the two screens:
--
--   the Schedule editor  owns the weekly RULE. Change it and every future
--                        session follows.
--   the calendar         owns INSTANCES. What it creates is immune to a later
--                        pattern change, because the pattern never knew about
--                        it.
--
-- Somebody who wants a managed weekly slot should add it to the pattern. This
-- is for a run of dates that the pattern should not touch — a replacement
-- series after a strike, a lab that runs for three weeks only.
--
-- ONE ROUND TRIP
--
-- A client loop over eleven Tuesdays is eleven requests, and a failure halfway
-- leaves half a series. The same argument as upsert_enrolments.
--
-- WHAT IT SKIPS, AND SAYS SO
--
-- Two things silently produce fewer sessions than dates asked for, and both are
-- correct: a declared day off (036's trigger refuses the insert) and a date
-- where the cohort already has a session at that exact time. The result
-- separates them, because "created 9 of 11" with no reason is the kind of
-- answer that gets read as a bug.
--
-- Run AFTER 038. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_ad_hoc_sessions(
  p_cohort_id        uuid,
  p_from             date,
  p_start_time       time,
  p_to               date    DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class      public.classes%ROWTYPE;
  v_cohort     public.cohorts%ROWTYPE;
  v_to         date;
  v_duration   integer;
  v_created    integer := 0;
  v_candidates integer := 0;
  v_days_off   integer := 0;
  v_existing   integer := 0;
  v_first      uuid;
  d            date;
  v_starts     timestamptz;
  v_id         uuid;
BEGIN
  SELECT * INTO v_cohort FROM public.cohorts WHERE id = p_cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that cohort does not exist';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = v_cohort.class_id;

  IF NOT public.can_manage_class(v_class.id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_from IS NULL OR p_start_time IS NULL THEN
    RAISE EXCEPTION 'a date and a start time are both required';
  END IF;

  -- No end date means the single date. 035's behaviour, unchanged.
  v_to := COALESCE(p_to, p_from);

  IF v_to < p_from THEN
    RAISE EXCEPTION 'the last date (%) is before the first (%)', v_to, p_from;
  END IF;

  v_duration := COALESCE(p_duration_minutes, v_class.default_duration_minutes);
  IF v_duration <= 0 THEN
    RAISE EXCEPTION 'a session has to last longer than zero minutes';
  END IF;

  -- Weekly on the weekday of the first date. Not every day in the range: a TA
  -- picking Tuesday the 14th and "to the end of term" means Tuesdays, and a
  -- daily reading would silently create sixty sessions.
  d := p_from;
  WHILE d <= v_to LOOP
    v_candidates := v_candidates + 1;
    v_starts := ((d + p_start_time) AT TIME ZONE v_class.timezone);

    IF public.is_no_class_day(v_class.id, p_cohort_id, d) THEN
      v_days_off := v_days_off + 1;
    ELSIF EXISTS (
      SELECT 1 FROM public.class_sessions
      WHERE cohort_id = p_cohort_id AND starts_at = v_starts
    ) THEN
      v_existing := v_existing + 1;
    ELSE
      INSERT INTO public.class_sessions (
        class_id, cohort_id, schedule_id, starts_at, session_date,
        duration_minutes, delivery_mode, status, method,
        late_window_minutes, auto_close_minutes, early_open_minutes,
        moved_manually
      )
      VALUES (
        v_class.id, p_cohort_id, NULL, v_starts, d,
        v_duration, v_class.default_delivery_mode, 'scheduled',
        v_class.default_method,
        v_class.default_late_window_minutes,
        v_class.default_auto_close_minutes,
        v_class.default_early_open_minutes,
        true
      )
      RETURNING id INTO v_id;

      -- A BEFORE trigger returning NULL leaves v_id NULL and inserts nothing.
      -- 036's day-off trigger is handled above; this catches anything added
      -- later rather than counting a session that does not exist.
      IF v_id IS NOT NULL THEN
        v_created := v_created + 1;
        v_first := COALESCE(v_first, v_id);
      END IF;
    END IF;

    d := d + 7;
  END LOOP;

  IF v_created = 0 AND v_candidates = 1 THEN
    -- The single-date case deserves the specific refusal 038 gave it, rather
    -- than a summary saying nothing happened.
    IF v_days_off = 1 THEN
      RAISE EXCEPTION
        '% is set as a day this class does not meet. Remove the day off first.',
        p_from;
    ELSE
      RAISE EXCEPTION
        'this cohort already has a session at that time on %', p_from;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'session_id',   v_first,
    'cohort',       v_cohort.label,
    'from',         p_from,
    'to',           v_to,
    'weekday',      to_char(p_from, 'Day'),
    'candidates',   v_candidates,
    'created',      v_created,
    'skipped_days_off', v_days_off,
    'skipped_existing', v_existing,
    'outside_term', p_from < v_class.term_starts_on
                 OR v_to   > v_class.term_ends_on
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_ad_hoc_sessions(uuid, date, time, date, integer)
  FROM public;
GRANT EXECUTE ON FUNCTION public.create_ad_hoc_sessions(uuid, date, time, date, integer)
  TO authenticated;

COMMENT ON FUNCTION public.create_ad_hoc_sessions(uuid, date, time, date, integer) IS
  'Sessions on one date, or weekly on that weekday through to an end date. '
  'Flagged moved_manually, so the weekly pattern neither manages nor removes '
  'them. Reports what it skipped and why.';
