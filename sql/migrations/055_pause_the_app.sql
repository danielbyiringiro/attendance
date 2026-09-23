-- ============================================================================
-- 055 — pause the app
--
-- An admin switch that stops the term's record changing, and says so to whoever
-- is looking. For an evening of maintenance, a database move, or any moment
-- where the data has to hold still while something is copied.
--
-- WHY A TRIGGER AND NOT A CHECK IN EACH FUNCTION
--
-- The obvious place is mark_attendance. It is 162 lines, and copying it whole
-- to add one `IF paused` is how a function and its copy drift apart. Worse, it
-- is not the only writer: close_session materialises an absence for everybody
-- unmarked, the sweep opens and closes on a timer, and a TA can mark by hand.
-- A check inside one of them is a pause with holes.
--
-- So the refusal sits on the tables, as a statement-level trigger, and every
-- path reaches it — including one added next year by somebody who never read
-- this file.
--
-- WHAT IS DELIBERATELY NOT FROZEN
--
--   staff, class_staff        an admin must be able to sign in and unpause.
--                             ensure_staff writes a staff row on every sign-in,
--                             so freezing it would lock everybody out,
--                             including the person holding the switch.
--   announcement_reads        a "seen it" marker. Losing one costs nothing.
--   allowed_email_domains     tiny, and needed for anyone to sign in at all.
--   service_state             the switch itself.
--
-- Everything else that carries the term's record is frozen: attendance and its
-- corrections, sessions, classes, cohorts, timetables, enrolments, students,
-- days off, flags, report settings, Canvas mappings, feedback, and the Help
-- content.
--
-- A pause is not a lock on the database. Anyone with direct SQL access can
-- still write — including whoever set it. For a copy that must be exact,
-- pause the app AND set the database read-only for the few minutes it takes:
--
--   ALTER DATABASE postgres SET default_transaction_read_only = on;   -- then off
--
-- THE SWEEP
--
-- sync_sessions runs every minute under pg_cron. Left alone it would hit the
-- trigger on class_sessions and raise once a minute for the length of the
-- pause, filling the logs with alarming nothing. It now returns early and says
-- it was paused, which is also what a TA watching the dashboard should see.
--
-- Run AFTER 054. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The switch: one row, and only ever one
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_state (
  -- A boolean primary key that must be true is the smallest honest way to say
  -- "there is exactly one of these". A second row cannot be inserted.
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused  boolean NOT NULL DEFAULT false,
  -- Shown to students and staff. Null falls back to wording in the app, so a
  -- pause set in a hurry still explains itself.
  message text,
  set_by  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  set_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.service_state (id, paused) VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.service_state IS
  'One row. While paused is true, every table carrying the term''s record '
  'refuses writes, and the app says so instead of failing oddly.';

-- RLS on, and no policy at all: nothing reaches this table directly, not even
-- a signed-in TA. Both ways in are the functions below, which is what keeps
-- 027 (anon reaches nothing) true.
ALTER TABLE public.service_state ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Reading the switch
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_paused()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE((SELECT paused FROM public.service_state WHERE id), false);
$fn$;

/**
 * What the app shows. Answered for anyone, signed in or not: a student who
 * cannot check in is exactly who needs to be told why.
 */
CREATE OR REPLACE FUNCTION public.get_service_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
           'paused',  COALESCE(s.paused, false),
           'message', s.message,
           'since',   s.set_at)
  FROM public.service_state s
  WHERE s.id;
$fn$;

REVOKE ALL ON FUNCTION public.service_paused() FROM public;
REVOKE ALL ON FUNCTION public.get_service_state() FROM public;
GRANT EXECUTE ON FUNCTION public.get_service_state() TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Setting it
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_service_paused(
  p_paused  boolean,
  p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.service_state%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'only an admin can pause or resume the app';
  END IF;

  UPDATE public.service_state
     SET paused  = p_paused,
         message = NULLIF(btrim(COALESCE(p_message, '')), ''),
         set_by  = public.current_staff_id(),
         set_at  = now()
   WHERE id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'paused', v_row.paused, 'message', v_row.message, 'since', v_row.set_at);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_set_service_paused(boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_set_service_paused(boolean, text)
  TO authenticated;

-- ----------------------------------------------------------------------------
-- The refusal, and the tables it sits on
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_when_paused()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF public.service_paused() THEN
    RAISE EXCEPTION
      'attendance is paused right now, so nothing can be recorded or changed. An admin can resume it.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;  -- statement-level: the return value is ignored
END;
$fn$;

COMMENT ON FUNCTION public.refuse_when_paused() IS
  'Raises while the app is paused. Attached to every table carrying the term''s '
  'record, so no write path can miss it — not even one added later.';

DO $attach$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'attendance_records', 'attendance_corrections', 'class_sessions',
    'classes', 'cohorts', 'cohort_schedules', 'enrolments', 'students',
    'no_class_days', 'flagged', 'report_settings', 'canvas_row_mappings',
    'feedback', 'announcements', 'help_videos'
  ]
  LOOP
    -- Only what this database actually has: the legacy tables come and go
    -- across 001–054, and a missing one here should not stop the migration.
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_paused ON public.%I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_%s_paused '
        'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_when_paused()',
        t, t);
    END IF;
  END LOOP;
END;
$attach$;

-- ----------------------------------------------------------------------------
-- The sweep stands down while paused
--
-- Copied from 031 with an early return. Without it the every-minute job hits
-- the trigger on class_sessions and raises for the whole length of the pause.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_closed integer;
  v_opened integer;
BEGIN
  IF public.service_paused() THEN
    RETURN jsonb_build_object('closed', 0, 'opened', 0, 'paused', true);
  END IF;

  -- plpgsql with named steps rather than two calls inside jsonb_build_object:
  -- Postgres does not promise the order it evaluates function arguments in, and
  -- a sweep whose two halves run in an unspecified order is a sweep nobody can
  -- reason about later.
  --
  -- Close first. It cannot create work for the opener — a closed session is
  -- 'closed', never back to 'scheduled' — whereas doing it the other way round
  -- would have the opener and closer looking at an overlapping set.
  v_closed := public.close_due_sessions();
  v_opened := public.open_due_sessions();

  RETURN jsonb_build_object('closed', v_closed, 'opened', v_opened,
                            'paused', false);
END;
$fn$;
