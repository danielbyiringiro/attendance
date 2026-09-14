-- ============================================================================
-- Migration 043 — the weekly report's absence threshold, per class
--
-- The default has to be 2, because 2 is what the report used before this
-- existed: anything else silently changes every class's report on the day the
-- migration runs. The rest is who may change it, and to what.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE v_class uuid;
BEGIN
  v_class := (public.create_class('ASSERT-043', 'Threshold',
                CURRENT_DATE - 7, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  PERFORM set_config('t043.class', v_class::text, true);
END;
$setup$;

-- ---------------------------------------------------------- the default --
DO $default$
DECLARE
  v_new      smallint;
  v_existing integer;
BEGIN
  SELECT weekly_absence_threshold INTO v_new
  FROM public.classes WHERE id = current_setting('t043.class')::uuid;
  IF v_new IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '043: a new class reports from % absences, not the 2 the report always used', v_new;
  END IF;

  -- Every class that existed before the migration, too.
  SELECT count(*) INTO v_existing
  FROM public.classes WHERE weekly_absence_threshold <> 2;
  IF v_existing <> 0 THEN
    RAISE EXCEPTION '043: % existing class(es) had their weekly report threshold changed', v_existing;
  END IF;

  RAISE NOTICE '043 ok: every class, new and existing, starts at 2';
END;
$default$;

-- ------------------------------------------------------------ changing it --
DO $change$
DECLARE
  v_class   uuid := current_setting('t043.class')::uuid;
  v_stored  smallint;
  v_refused integer := 0;
BEGIN
  IF public.set_weekly_absence_threshold(v_class, 3) <> 3 THEN
    RAISE EXCEPTION '043: setting 3 did not report 3 back';
  END IF;
  SELECT weekly_absence_threshold INTO v_stored FROM public.classes WHERE id = v_class;
  IF v_stored <> 3 THEN
    RAISE EXCEPTION '043: the threshold was reported set but is stored as %', v_stored;
  END IF;

  -- Both ends of the range are allowed.
  PERFORM public.set_weekly_absence_threshold(v_class, 1);
  PERFORM public.set_weekly_absence_threshold(v_class, 10);

  BEGIN PERFORM public.set_weekly_absence_threshold(v_class, 0);
  EXCEPTION WHEN OTHERS THEN v_refused := v_refused + 1; END;

  BEGIN PERFORM public.set_weekly_absence_threshold(v_class, 11);
  EXCEPTION WHEN OTHERS THEN v_refused := v_refused + 1; END;

  BEGIN PERFORM public.set_weekly_absence_threshold(v_class, NULL);
  EXCEPTION WHEN OTHERS THEN v_refused := v_refused + 1; END;

  IF v_refused <> 3 THEN
    RAISE EXCEPTION '043: refused % of 3 out-of-range values (0, 11, nothing)', v_refused;
  END IF;

  SELECT weekly_absence_threshold INTO v_stored FROM public.classes WHERE id = v_class;
  IF v_stored <> 10 THEN
    RAISE EXCEPTION '043: a refused value still changed the stored threshold (now %)', v_stored;
  END IF;

  RAISE NOTICE '043 ok: 1 to 10 are stored, 0, 11 and nothing are refused';
END;
$change$;

-- ------------------------------------------------------------ who may --
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $outsider$
DECLARE v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.set_weekly_absence_threshold(current_setting('t043.class')::uuid, 5);
  EXCEPTION WHEN OTHERS THEN v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION '043: staff not on the class changed its weekly report threshold';
  END IF;

  IF has_function_privilege('anon', 'public.set_weekly_absence_threshold(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '043: anon can change a class''s weekly report threshold';
  END IF;

  RAISE NOTICE '043 ok: only staff on the class can change it';
END;
$outsider$;

ROLLBACK;
