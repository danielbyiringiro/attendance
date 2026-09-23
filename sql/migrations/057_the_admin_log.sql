-- ============================================================================
-- 057 — a log only admins can read
--
-- Somewhere for the people who run this installation to write to each other:
-- what was done, when, and why. "Paused at nine to copy the database", "the
-- Tuesday lab moved rooms, ignore the empty register", "rotated the key".
--
-- WHY IT IS NOT FEEDBACK (051)
--
-- Feedback goes staff → admin and is a queue: it arrives, it gets handled, it
-- is done with. This goes admin → admin and is a record: nothing is ever
-- "handled", and the value is entirely in reading it back months later, when
-- whoever answers "why is there no register for 3 October?" was not there.
--
-- WHY NOT ONE OF THESE PER CLASS
--
-- Because the things worth writing down here are about the installation, not
-- about a class. A class-level note is what a session's `notes` column is for.
--
-- HIDDEN MEANS HIDDEN
--
-- Not "not shown to staff" — unreachable by them. The table has row-level
-- security on and no policy whatsoever, so the only way in is the three
-- functions below, and each one refuses anybody who is not an admin. A TA who
-- learns the table name and queries it directly gets nothing, exactly as they
-- get nothing from service_state (055) and from any other table 027 covers.
--
-- ENTRIES NOBODY TYPED
--
-- Pausing and resuming write their own entry. A log that only holds what
-- somebody remembered to write down is a log with the interesting evenings
-- missing — and the evening the app was paused for two hours is precisely the
-- one a reader will be asking about. `kind` tells the two apart so the screen
-- can, too.
--
-- Run AFTER 056. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'note'  somebody wrote it
  -- 'event' the app wrote it, because something happened
  kind       text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'event')),
  body       text NOT NULL CHECK (btrim(body) <> ''),
  -- Null once the account is removed (050). The entry stays: a record that
  -- disappears when somebody leaves is not a record.
  author_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  -- Kept as written, because author_id goes null when an account is deleted
  -- and "somebody" is a worse answer than a name that no longer has a login.
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_log_recent
  ON public.admin_log (created_at DESC);

COMMENT ON TABLE public.admin_log IS
  'Admin-to-admin record of what was done to this installation. Reachable only '
  'through admin_log_* functions, each of which refuses non-admins.';

-- No policy at all: RLS on and nothing granted, so the functions are the only
-- way in. See the header.
ALTER TABLE public.admin_log ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Writing an entry
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_log_write(
  p_body text,
  p_kind text DEFAULT 'note'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff public.staff%ROWTYPE;
  v_row   public.admin_log%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only an admin can write to the admin log';
  END IF;

  IF p_body IS NULL OR btrim(p_body) = '' THEN
    RAISE EXCEPTION 'an empty note says nothing — write what happened';
  END IF;

  IF p_kind NOT IN ('note', 'event') THEN
    RAISE EXCEPTION 'kind must be note or event, not %', p_kind;
  END IF;

  SELECT * INTO v_staff FROM public.staff WHERE id = public.current_staff_id();

  INSERT INTO public.admin_log (kind, body, author_id, author_name)
  VALUES (p_kind, btrim(p_body), v_staff.id,
          COALESCE(v_staff.display_name, v_staff.email))
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'kind', v_row.kind, 'body', v_row.body,
    'author', v_row.author_name, 'created_at', v_row.created_at);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Reading it back
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_log_list(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only an admin can read the admin log';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT l.id, l.kind, l.body, l.created_at,
           l.author_name AS author
    FROM public.admin_log l
    ORDER BY l.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 100), 1)
  ) e;

  RETURN v_rows;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Removing one
--
-- Any admin can remove any entry, including one the app wrote. This is a
-- shared notebook, not an audit trail with legal weight, and pretending
-- otherwise by making entries permanent would be a promise the database
-- cannot keep anyway — anyone with SQL access can delete a row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_log_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_gone integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only an admin can remove an entry from the admin log';
  END IF;

  DELETE FROM public.admin_log WHERE id = p_id;
  GET DIAGNOSTICS v_gone = ROW_COUNT;
  RETURN v_gone > 0;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_log_write(text, text) FROM public;
REVOKE ALL ON FUNCTION public.admin_log_list(integer) FROM public;
REVOKE ALL ON FUNCTION public.admin_log_delete(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_log_write(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_log_list(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_log_delete(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Pausing writes its own entry
--
-- Copied from 056 with the logging added. The evening the app was paused for
-- two hours is exactly the one somebody will ask about later, and it should
-- not depend on whoever paused it also remembering to write a note.
-- ----------------------------------------------------------------------------
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
DECLARE
  v_state jsonb;
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

  v_state := public.get_service_state();

  PERFORM public.admin_log_write(
    CASE v_state ->> 'state'
      WHEN 'scheduled' THEN
        'Pause scheduled for ' || to_char(p_starts_at, 'FMDay FMDD Mon HH24:MI')
      WHEN 'paused' THEN 'App paused'
      ELSE 'App resumed'
    END
    || COALESCE(' — ' || NULLIF(btrim(COALESCE(p_message, '')), ''), ''),
    'event');

  RETURN v_state;
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.admin_set_service_paused(boolean, text, timestamptz, timestamptz)
  FROM public;
GRANT EXECUTE ON FUNCTION
  public.admin_set_service_paused(boolean, text, timestamptz, timestamptz)
  TO authenticated;
