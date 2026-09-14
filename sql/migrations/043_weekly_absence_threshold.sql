-- ============================================================================
-- 043 — how many absences in a week put a student on the weekly report
--
-- The Weekly Absences report, which a TA pastes into the faculty spreadsheet,
-- listed a student only when they were absent at least twice in a week. That 2
-- was written into the dashboard, so a class whose faculty wants every single
-- absence reported, or only three or more, had no way to say so.
--
-- It is now a setting on the class: one number for every cohort, set in the
-- Weekly Absences dialog itself, where its effect on the weeks can be seen.
-- The default is 2, so nothing changes for a class until somebody changes it.
--
-- Set through its own function rather than a new parameter on update_class.
-- update_class is called with named arguments from the app, and adding a
-- parameter means dropping and recreating it — a window in which saving a class
-- fails for anyone on the old signature. One small function has no such window.
--
-- Bounded 1 to 10. Zero would report every student who was ever on a register
-- with no absence at all, and a two-digit number is a typo for a class that
-- meets at most a few times a week.
--
-- Run AFTER 042. Idempotent.
-- ============================================================================

ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS weekly_absence_threshold smallint NOT NULL DEFAULT 2;

ALTER TABLE public.classes
  DROP CONSTRAINT IF EXISTS classes_weekly_absence_threshold_range;
ALTER TABLE public.classes
  ADD CONSTRAINT classes_weekly_absence_threshold_range
  CHECK (weekly_absence_threshold BETWEEN 1 AND 10);

COMMENT ON COLUMN public.classes.weekly_absence_threshold IS
  'Absences in one week that put a student on the Weekly Absences report. '
  'One number for every cohort of the class. See migration 043.';

CREATE OR REPLACE FUNCTION public.set_weekly_absence_threshold(
  p_class_id  uuid,
  p_threshold integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
    RAISE EXCEPTION 'that class does not exist';
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  -- Said in words rather than left to the CHECK constraint, whose message
  -- names a constraint nobody using the screen has heard of.
  IF p_threshold IS NULL OR p_threshold < 1 OR p_threshold > 10 THEN
    RAISE EXCEPTION 'the weekly report threshold must be between 1 and 10 absences, not %',
      COALESCE(p_threshold::text, 'nothing');
  END IF;

  UPDATE public.classes
     SET weekly_absence_threshold = p_threshold
   WHERE id = p_class_id;

  RETURN p_threshold;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_weekly_absence_threshold(uuid, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_weekly_absence_threshold(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.set_weekly_absence_threshold(uuid, integer) IS
  'Set how many absences in a week put a student on the class''s Weekly '
  'Absences report, 1 to 10. Staff on the class only. See migration 043.';
