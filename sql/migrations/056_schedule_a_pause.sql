-- ============================================================================
-- 056 — schedule a pause, and warn before it starts
--
-- 055's switch is immediate: an admin presses it and every class stops mid-
-- afternoon. That is the right tool for an emergency and the wrong one for
-- planned work, where the people it interrupts could have been told first.
--
-- A pause now has a start time and an expected end, so:
--
--   scheduled  set for 21:00 tonight. Nothing is stopped yet. Students and
--              staff can see it coming, and the app can warn them as it nears.
--   paused     the start time has passed. Everything 055 stops is stopped.
--   running    no pause set.
--
-- WHY THE CLOCK LIVES IN THE DATABASE
--
-- The alternative is a browser noticing the time and calling "pause now",
-- which needs a browser to be open, on the right screen, with the right
-- account, at the right minute. The refusal is already a database trigger
-- (055), so the start time belongs beside it: at 21:00 the next write refuses,
-- whether or not anybody is looking.
--
-- WHY THE END TIME DOES NOT RESUME ANYTHING
--
-- It is what people are told to expect, not a timer. Work overruns, and an app
-- that un-paused itself halfway through a database copy would let check-ins
-- into a database that was about to be replaced. Resuming stays a deliberate
-- act; the end time only sets expectations, and the admin screen says so.
--
-- Run AFTER 055. Idempotent.
-- ============================================================================

ALTER TABLE public.service_state
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ends_at   timestamptz;

COMMENT ON COLUMN public.service_state.starts_at IS
  'When the pause takes effect. Null means immediately. In the future it is '
  'only a warning: nothing is refused until it passes.';
COMMENT ON COLUMN public.service_state.ends_at IS
  'When people are told to expect it back. Advisory only — nothing resumes on '
  'its own, because work overruns and an app that un-paused itself mid-copy '
  'would take check-ins into a database about to be replaced.';

-- ----------------------------------------------------------------------------
-- Paused means: set, and started
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_paused()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(
           (SELECT paused AND (starts_at IS NULL OR now() >= starts_at)
              FROM public.service_state WHERE id),
           false);
$fn$;

/**
 * What the app shows. Answered for anyone, signed in or not.
 *
 * `paused` is the effective answer — set AND started — so a screen never has to
 * work out the difference for itself. `state` is the same thing in words, for
 * the three screens that show something different in each case.
 */
CREATE OR REPLACE FUNCTION public.get_service_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
           'state', CASE
                      WHEN NOT COALESCE(s.paused, false) THEN 'running'
                      WHEN s.starts_at IS NOT NULL AND now() < s.starts_at
                        THEN 'scheduled'
                      ELSE 'paused'
                    END,
           'paused',    COALESCE(s.paused, false)
                        AND (s.starts_at IS NULL OR now() >= s.starts_at),
           'message',   s.message,
           'starts_at', s.starts_at,
           'ends_at',   s.ends_at,
           'since',     s.set_at)
  FROM public.service_state s
  WHERE s.id;
$fn$;

REVOKE ALL ON FUNCTION public.service_paused() FROM public;
REVOKE ALL ON FUNCTION public.get_service_state() FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_state() TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Setting it, now or later
--
-- The two-argument version from 055 is dropped rather than left beside this
-- one: with the new arguments defaulted, a two-argument call would match both
-- and Postgres would refuse it as ambiguous.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_set_service_paused(boolean, text);

CREATE OR REPLACE FUNCTION public.admin_set_service_paused(
  p_paused    boolean,
  p_message   text        DEFAULT NULL,
  p_starts_at timestamptz DEFAULT NULL,
  p_ends_at   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only an admin can pause or resume the app';
  END IF;

  IF p_paused AND p_ends_at IS NOT NULL
     AND p_ends_at <= COALESCE(p_starts_at, now()) THEN
    RAISE EXCEPTION
      'the app cannot be expected back before the pause starts — check the times';
  END IF;

  UPDATE public.service_state
     SET paused    = p_paused,
         message   = NULLIF(btrim(COALESCE(p_message, '')), ''),
         -- Resuming clears the schedule outright. A left-over start time would
         -- sit there and pause the app again at some hour nobody remembers
         -- setting.
         starts_at = CASE WHEN p_paused THEN p_starts_at ELSE NULL END,
         ends_at   = CASE WHEN p_paused THEN p_ends_at   ELSE NULL END,
         set_by    = public.current_staff_id(),
         set_at    = now()
   WHERE id;

  RETURN public.get_service_state();
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.admin_set_service_paused(boolean, text, timestamptz, timestamptz)
  FROM public;
GRANT EXECUTE ON FUNCTION
  public.admin_set_service_paused(boolean, text, timestamptz, timestamptz)
  TO authenticated;

COMMENT ON FUNCTION
  public.admin_set_service_paused(boolean, text, timestamptz, timestamptz) IS
  'Pause now (no start time), or schedule one. Nothing is refused until the '
  'start time passes. The end time is advisory: resuming is always deliberate.';
