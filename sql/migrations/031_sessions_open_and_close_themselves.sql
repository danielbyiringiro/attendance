-- ============================================================================
-- 031 — sessions open and close without anyone pressing a button
--
-- WHAT WAS ACTUALLY MISSING
--
-- 028 made the check-in window honest: opening early stopped costing window
-- time, and `session_is_live` became the one place that decides whether a mark
-- is accepted. What it did not do — and what reads as the feature being broken —
-- is make anything happen on its own.
--
-- A session sat at 'scheduled' until a TA pressed Open, and at 'open' forever
-- after the window passed, because `status` only ever changed when a human
-- clicked. `early_open_minutes` was a permission to click early rather than an
-- instruction to open, and there was no auto-close at all: check-in quietly
-- stopped accepting marks while the dashboard still showed a PIN.
--
-- The second half is the one that costs data. close_session is what writes the
-- explicit `unexcused` row for everyone who did not mark — "absence is a stored
-- fact, not a calculation" is migration 004's whole premise. If nobody presses
-- Close, those rows are never written, and the absence silently does not exist.
--
-- TWO TRIGGERS, DELIBERATELY
--
-- pg_cron runs the sweep every minute where the extension is available, which
-- is what makes closing reliable: it has to happen whether or not anyone is
-- looking at a screen.
--
-- `sync_sessions` is the same sweep exposed as an RPC, called by the dashboard.
-- That covers the case where pg_cron is not enabled on the project, and it also
-- makes the dashboard feel immediate rather than up-to-a-minute-stale. Running
-- both is harmless: the sweep is idempotent, and the second caller finds
-- nothing to do.
--
-- The functions are SECURITY DEFINER and deliberately do NOT call
-- can_manage_class. They act as the system on a schedule, and a cron job has no
-- auth.uid() to check. They only ever do what the class's own configured times
-- already said would happen.
--
-- A NOTE ON WHAT THIS CHANGES SOCIALLY
--
-- Auto-open means a PIN goes live for a class whose TA never turned up. That is
-- the behaviour the schedule describes, so it is the behaviour implemented, but
-- it is worth knowing before a term starts rather than after.
--
-- Run AFTER 030. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- One place that mints a PIN
--
-- The retry loop existed only inside open_session. Auto-open needs the same
-- thing, and a second copy of "generate five characters and retry on the unique
-- index" is a second chance to get the alphabet or the retry limit wrong.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mint_session_pin(p_session_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_pin      text;
  v_try      integer := 0;
  -- No I, O, 0 or 1. A PIN is read off a projector and typed by a hundred
  -- people at once, and those four are where that goes wrong.
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  LOOP
    v_try := v_try + 1;
    SELECT string_agg(
             substr(v_alphabet, (floor(random() * length(v_alphabet))::int + 1), 1), '')
      INTO v_pin
    FROM generate_series(1, 5);

    BEGIN
      UPDATE public.class_sessions
         SET pin = v_pin,
             status = 'open',
             opened_at = COALESCE(opened_at, now())
       WHERE id = p_session_id;
      RETURN v_pin;
    EXCEPTION WHEN unique_violation THEN
      -- idx_sessions_open_pin is partial on status = 'open', so a collision is
      -- only ever with another session that is open right now.
      IF v_try >= 10 THEN
        RAISE EXCEPTION 'could not find a free PIN after % attempts', v_try;
      END IF;
    END;
  END LOOP;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Open anything whose early-open moment has arrived
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_due_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id     uuid;
  v_opened integer := 0;
BEGIN
  FOR v_id IN
    SELECT s.id
    FROM public.class_sessions s
    WHERE s.status = 'scheduled'
      -- The same allowance 028 defined. Read: we have reached the point where
      -- opening costs nothing.
      AND now() >= s.starts_at - make_interval(mins => COALESCE(s.early_open_minutes, 0))
      -- And NOT one whose window has already been and gone. Without this, a
      -- weekend of downtime would come back up and open every missed class at
      -- once, minting live PINs for lectures that finished days ago.
      AND now() <= s.starts_at + make_interval(mins => COALESCE(s.auto_close_minutes, 0))
    ORDER BY s.starts_at
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM public.mint_session_pin(v_id);
    v_opened := v_opened + 1;
  END LOOP;

  RETURN v_opened;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Close anything past its window, and record the absences
--
-- This is the half that writes data. Everyone enrolled who has no record gets
-- an explicit 'unexcused' row, exactly as close_session does — the same query,
-- because the definition of "absent" must not have two versions.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_due_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  s        public.class_sessions%ROWTYPE;
  v_closed integer := 0;
BEGIN
  FOR s IN
    SELECT *
    FROM public.class_sessions c
    WHERE c.status = 'open'
      AND c.opened_at IS NOT NULL
      AND now() > public.session_closes_at(c)
    ORDER BY c.starts_at
    FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, s.class_id, e.student_id, 'unexcused', now(), 'system'
    FROM public.enrolments e
    WHERE e.cohort_id = s.cohort_id
      AND e.enrolled_on <= s.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date)
    ON CONFLICT (session_id, student_id) DO NOTHING;

    UPDATE public.class_sessions
       SET status = 'closed'
     WHERE id = s.id;

    v_closed := v_closed + 1;
  END LOOP;

  RETURN v_closed;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Both, as one call
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

  RETURN jsonb_build_object('closed', v_closed, 'opened', v_opened);
END;
$fn$;

-- Any signed-in member of staff may trigger the sweep. It reveals nothing —
-- two integers — and does only what the schedule already said would happen at
-- that moment. Not granted to anon: a student should not be able to open a
-- class by loading the check-in page early.
REVOKE ALL ON FUNCTION public.sync_sessions() FROM public;
GRANT EXECUTE ON FUNCTION public.sync_sessions() TO authenticated;
REVOKE ALL ON FUNCTION public.open_due_sessions() FROM public;
REVOKE ALL ON FUNCTION public.close_due_sessions() FROM public;
REVOKE ALL ON FUNCTION public.mint_session_pin(uuid) FROM public;

COMMENT ON FUNCTION public.sync_sessions() IS
  'Opens sessions whose early-open moment has arrived and closes those past '
  'their window, recording an explicit unexcused row for anyone unmarked. Safe '
  'to call repeatedly; run by pg_cron every minute and by the TA dashboard.';

-- ----------------------------------------------------------------------------
-- Schedule it, where there is a scheduler
--
-- pg_cron is available on Supabase but not in a bare postgres image, so this is
-- guarded rather than assumed: the test harness runs the functions directly and
-- asserts on their behaviour, which is the part that can actually be wrong.
--
-- Without cron the RPC still runs the sweep whenever a TA has the dashboard
-- open, so opening keeps working. Closing is the one that then depends on
-- somebody looking, which is the reason to enable the extension in production.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    -- Re-scheduling the same name replaces the old entry, so this is safe to
    -- run twice.
    PERFORM cron.schedule(
      'sync-sessions',
      '* * * * *',
      $job$SELECT public.sync_sessions()$job$);

    RAISE NOTICE '031: scheduled sync_sessions every minute via pg_cron';
  ELSE
    RAISE NOTICE
      '031: pg_cron is not available here — sync_sessions exists and must be '
      'called by the app. Enable the extension in production so sessions close '
      'even when nobody has the dashboard open.';
  END IF;
END $$;
