-- ============================================================================
-- Migration 029 — a per-meeting early-open setting that actually arrives
--
-- The setting is only worth having if it reaches the sessions it governs, and
-- there are three places it can be dropped on the way: storing the slot,
-- generating sessions from it, and pushing a later change onto sessions that
-- already exist. The third is the one that goes wrong quietly — nothing else
-- about those rows differs, so a sync that compares the wrong columns skips
-- them and the edit vanishes.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $assert$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  n        bigint;
  v_early  integer;
BEGIN
  v_class := (public.create_class('ASSERT-030', 'Early Doors',
                CURRENT_DATE, CURRENT_DATE + 21) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  -- ==========================================================================
  -- Stored on the slot
  -- ==========================================================================
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00", "early_open_minutes": 20}]',
           EXTRACT(DOW FROM CURRENT_DATE + 1)::int)::jsonb);

  SELECT early_open_minutes INTO v_early
  FROM public.cohort_schedules WHERE cohort_id = v_cohort;

  IF v_early <> 20 THEN
    RAISE EXCEPTION 'the slot did not keep its early-open setting, got %',
      COALESCE(v_early::text, 'null');
  END IF;

  -- ==========================================================================
  -- Carried onto generated sessions
  --
  -- Not the class default of 5: the slot said 20.
  -- ==========================================================================
  PERFORM public.generate_sessions(v_class, NULL,
                                   CURRENT_DATE, CURRENT_DATE + 14);

  SELECT count(*) INTO n FROM public.class_sessions WHERE cohort_id = v_cohort;
  IF n = 0 THEN
    RAISE EXCEPTION 'fixture: no sessions were generated';
  END IF;

  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE cohort_id = v_cohort AND early_open_minutes <> 20;

  IF n <> 0 THEN
    RAISE EXCEPTION
      '% generated session(s) did not take the slot''s early-open setting — '
      'they fell back to the class default instead', n;
  END IF;

  -- ==========================================================================
  -- THE ONE THAT GOES QUIETLY: changing it reaches sessions already generated
  --
  -- Only this setting changes. If the sync compares just the time and the
  -- other two windows, every row looks unchanged and the edit never lands —
  -- the TA saves, sees no error, and the sessions keep the old value.
  -- ==========================================================================
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00", "early_open_minutes": 45}]',
           EXTRACT(DOW FROM CURRENT_DATE + 1)::int)::jsonb);

  PERFORM public.apply_schedule_to_future(v_class, ARRAY[v_cohort]);

  SELECT count(*) INTO n
  FROM public.class_sessions
  WHERE cohort_id = v_cohort
    AND status = 'scheduled'
    AND early_open_minutes <> 45;

  IF n <> 0 THEN
    RAISE EXCEPTION
      'changing only the early-open setting left % session(s) on the old value '
      '— the change was saved on the pattern and never reached the sessions', n;
  END IF;

  -- ==========================================================================
  -- Omitting it falls back to the class default, rather than to zero
  --
  -- Zero would mean "check-in opens exactly as the class starts", which is a
  -- different instruction from "I did not say".
  -- ==========================================================================
  PERFORM public.set_cohort_schedules(
    ARRAY[v_cohort],
    format('[{"weekday": %s, "start_time": "09:00"}]',
           EXTRACT(DOW FROM CURRENT_DATE + 2)::int)::jsonb);

  SELECT early_open_minutes INTO v_early
  FROM public.cohort_schedules WHERE cohort_id = v_cohort;

  IF v_early IS NOT NULL THEN
    RAISE EXCEPTION
      'an unset early-open was stored as % rather than left null to inherit',
      v_early;
  END IF;

  PERFORM public.generate_sessions(v_class, NULL,
                                   CURRENT_DATE, CURRENT_DATE + 14);

  SELECT count(*) INTO n
  FROM public.class_sessions s
  JOIN public.classes c ON c.id = s.class_id
  WHERE s.cohort_id = v_cohort
    AND s.session_date >= CURRENT_DATE
    AND s.early_open_minutes IS DISTINCT FROM c.default_early_open_minutes
    AND s.early_open_minutes <> 45;   -- the earlier day keeps what it was given

  IF n <> 0 THEN
    RAISE EXCEPTION
      '% session(s) from a slot with no early-open did not inherit the class '
      'default', n;
  END IF;

  -- ==========================================================================
  -- Negative is refused, before anything is deleted
  --
  -- set_cohort_schedules validates every slot before dropping the old ones, so
  -- a bad value cannot wipe a schedule and then fail.
  -- ==========================================================================
  DECLARE failed boolean := false;
  BEGIN
    BEGIN
      PERFORM public.set_cohort_schedules(
        ARRAY[v_cohort],
        '[{"weekday": 2, "start_time": "09:00", "early_open_minutes": -5}]'::jsonb);
    EXCEPTION WHEN others THEN failed := true;
    END;

    IF NOT failed THEN
      RAISE EXCEPTION 'a slot opening a negative number of minutes early was accepted';
    END IF;

    SELECT count(*) INTO n FROM public.cohort_schedules WHERE cohort_id = v_cohort;
    IF n = 0 THEN
      RAISE EXCEPTION
        'the refused slot took the existing schedule with it — validation has '
        'to happen before the delete';
    END IF;
  END;
END
$assert$;

DO $done$ BEGIN RAISE NOTICE '030 per-slot early-open assertions passed'; END $done$;

ROLLBACK;
