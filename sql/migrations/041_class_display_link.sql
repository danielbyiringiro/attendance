-- ============================================================================
-- 041 — show a class's check-in on another screen, with a link and a code
--
-- WHAT THIS IS FOR
--
-- The presenter tab at /present/:sessionId only works signed in as staff on the
-- class. That suits the laptop and not the screen it is meant for: a room PC, a
-- TV stick or a tablet by the door is nobody's account, and signing a TA in on a
-- shared machine leaves the whole dashboard open on it.
--
-- So a class gets one display link. Opened anywhere, it asks for an access code
-- the TA issued. With the right code it shows what the presenter shows — the
-- class, the live code, the countdown — for whichever session of the class is
-- current, and moves on to the next session by itself.
--
-- THE LINK AND THE CODE
--
--   token   64 hex characters from two gen_random_uuid() calls: about 244 bits
--           from the strong random source. random(), which mints the PINs, is
--           not that and is not used here. Stays the same when a new code is
--           issued, so a link already sent keeps working.
--
--   code    six characters with no 0, O, 1, I or L, typed on the screen. A new
--           code replaces the old one, which signs out every screen using it.
--
-- Ten wrong codes against a link lock it until the TA issues a new code. A
-- correct code does not reset the count: a screen polling with the right code
-- every 15 seconds would otherwise reset it for anybody guessing alongside.
--
-- WHAT IT EXPOSES, AND TO WHOM
--
-- get_class_display is callable by anon, because the screen is not signed in.
-- With a valid link and code it returns the class name and code, cohort labels,
-- session times, and the PIN of a session that is OPEN — what the projector
-- already shows the room. A scheduled session never carries its PIN, and
-- nothing about students or attendance is returned.
--
-- A wrong link and a wrong code get the same answer, so the endpoint cannot be
-- used to test links. "locked" is only ever said to a caller holding a real one.
--
-- The code is stored as issued, not hashed. Only staff on the class can read
-- the table, and they can already see the live PINs it guards; storing it lets
-- the panel show it again when the TA walks over to the other screen.
--
-- Run AFTER 040. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.class_display_links (
  -- One link per class. Issuing a new code updates this row in place.
  class_id        uuid PRIMARY KEY REFERENCES public.classes(id) ON DELETE CASCADE,
  token           text NOT NULL UNIQUE,
  access_code     text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  code_set_at     timestamptz NOT NULL DEFAULT now()
);

-- RLS on, and nothing for anon at all. The screen reaches this only through
-- get_class_display, which checks the code before returning anything.
ALTER TABLE public.class_display_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.class_display_links FROM anon;
-- Staff read their class's link; every change goes through the functions below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.class_display_links FROM authenticated;

DROP POLICY IF EXISTS class_display_links_read ON public.class_display_links;
CREATE POLICY class_display_links_read ON public.class_display_links
  FOR SELECT TO authenticated USING (public.can_access_class(class_id));

COMMENT ON TABLE public.class_display_links IS
  'One display link per class: an unguessable token for the URL and a short '
  'access code typed on the screen. See migration 041.';

-- ----------------------------------------------------------------------------
-- Issue a code: creates the link if there is none, otherwise keeps its token
-- and replaces the code, clearing the lock.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.issue_display_code(p_class_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- 31 characters. Nothing that reads as another on a projector or when typed.
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code  text;
  v_link  public.class_display_links%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
    RAISE EXCEPTION 'that class does not exist';
  END IF;

  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  -- The first six bytes of a version 4 uuid are all random; the version and
  -- variant bits sit in bytes 6 and 8. The modulo bias over 31 is 8 in 256,
  -- which a ten-attempt lock makes irrelevant.
  v_bytes := uuid_send(gen_random_uuid());
  SELECT string_agg(
           substr(v_alphabet, get_byte(v_bytes, i) % length(v_alphabet) + 1, 1),
           '' ORDER BY i)
    INTO v_code
  FROM generate_series(0, 5) AS i;

  INSERT INTO public.class_display_links (class_id, token, access_code, created_by)
  VALUES (
    p_class_id,
    replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    v_code,
    public.current_staff_id()
  )
  ON CONFLICT (class_id) DO UPDATE
     SET access_code     = EXCLUDED.access_code,
         failed_attempts = 0,
         code_set_at     = now()
  RETURNING * INTO v_link;

  RETURN jsonb_build_object(
    'token',       v_link.token,
    'code',        v_link.access_code,
    'created_at',  v_link.created_at,
    'code_set_at', v_link.code_set_at
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.issue_display_code(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.issue_display_code(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Turn the link off. A code issued afterwards comes with a new token, so the
-- old URL is dead for good, not just until the next code.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_display_link(p_class_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  DELETE FROM public.class_display_links WHERE class_id = p_class_id;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.revoke_display_link(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.revoke_display_link(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- What the screen shows.
--
-- Not STABLE: a wrong code writes to the attempt count, and PostgREST runs a
-- STABLE function in a read-only transaction.
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
               'late_window_minutes', s.late_window_minutes
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
  'PIN of any that is open. Ten wrong codes lock the link. See migration 041.';
