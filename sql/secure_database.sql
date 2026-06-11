-- ============================================================================
-- Cohort Check-in — full database lockdown
--
-- This replaces sql/secure_pin.sql (you can delete that file).
--
-- It does three things:
--   1. Locks every table with Row Level Security so the public (anon) API key
--      can no longer read or write them directly from the browser console.
--   2. Keeps the student check-in flow working through SECURITY DEFINER RPCs
--      (mark_attendance / get_student_attendance / flag_attendance), which run
--      with elevated rights and are the ONLY way anon can touch the data.
--   3. Gives real (authenticated) TA accounts full access.
--
-- ORDER OF OPERATIONS:
--   1. Create at least one TA login: Supabase Dashboard -> Authentication ->
--      Users -> "Add user" -> enter email + password, tick "Auto Confirm User".
--   2. Run this script: Dashboard -> SQL Editor -> New query -> paste -> Run.
--   3. Deploy the updated app code.
--
-- Safe to run more than once (idempotent).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PIN visibility: hidden from anon, readable by authenticated TAs.
-- ----------------------------------------------------------------------------
REVOKE SELECT (pin) ON public.session_state FROM anon;
GRANT  SELECT (pin) ON public.session_state TO authenticated;

-- ta_get_pin is no longer needed now that TAs authenticate for real.
DROP FUNCTION IF EXISTS public.ta_get_pin(text);

-- ----------------------------------------------------------------------------
-- RPC: mark_attendance — students check in here; the PIN is verified in the DB.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_attendance(
  p_student_id text,
  p_pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session public.session_state%ROWTYPE;
  v_student public.students%ROWTYPE;
  v_now_utc timestamp;
  v_elapsed numeric;
BEGIN
  SELECT * INTO v_session FROM public.session_state WHERE id = 1;
  IF NOT FOUND OR NOT v_session.is_open THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'The attendance window is closed.');
  END IF;

  v_now_utc := (now() AT TIME ZONE 'utc');
  v_elapsed := EXTRACT(EPOCH FROM (v_now_utc - v_session.session_start));
  IF v_elapsed > v_session.time_limit_seconds THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'The attendance window has closed.');
  END IF;

  IF v_session.pin IS DISTINCT FROM p_pin THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'The PIN you entered is incorrect.');
  END IF;

  SELECT * INTO v_student FROM public.students WHERE student_id = p_student_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'You are not registered for this course. Please contact your TA.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.present_students
    WHERE student_id = p_student_id
      AND timestamp::date = v_now_utc::date
  ) THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'You have already marked your attendance.');
  END IF;

  INSERT INTO public.present_students (student_id, cohort, timestamp)
  VALUES (p_student_id, v_student.cohort, v_now_utc);

  RETURN jsonb_build_object(
    'success', true, 'name', v_student.name, 'cohort', v_student.cohort);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_attendance(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_attendance(text, text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- RPC: get_student_attendance — returns ONE student's own data so the student
-- history page can be computed client-side, without exposing the whole table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('timestamp', ps.timestamp, 'cohort', ps.cohort)
               ORDER BY ps.timestamp DESC)
      FROM public.present_students ps
      WHERE ps.student_id = p_student_id), '[]'::jsonb),
    'cancelled', COALESCE((
      SELECT jsonb_agg(DISTINCT cs.date)
      FROM public.cancelled_sessions cs
      WHERE cs.is_cancelled), '[]'::jsonb),
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('session_date', f.session_date, 'status', f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- RPC: flag_attendance — students flag a record for TA review.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flag_attendance(
  p_student_id text,
  p_session_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM public.flagged
  WHERE student_id = p_student_id AND session_date = p_session_date;

  IF v_status IS NOT NULL AND v_status <> 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_pending');
  END IF;
  IF v_status = 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'denied');
  END IF;

  INSERT INTO public.flagged (student_id, session_date, status)
  VALUES (p_student_id, p_session_date, 'flagged');

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.flag_attendance(text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.flag_attendance(text, date) TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- Row Level Security
--
-- Helper pattern below: enable RLS, then (idempotently) create policies.
-- Tables with ONLY an "authenticated" policy are completely invisible to anon.
-- session_state additionally has a read-only anon policy so the public check-in
-- page can still show the countdown timer (the pin column stays hidden via the
-- column-level REVOKE above).
-- ----------------------------------------------------------------------------

-- session_state: anon may read (timer), authenticated may do everything.
ALTER TABLE public.session_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_state_anon_read ON public.session_state;
CREATE POLICY session_state_anon_read ON public.session_state
  FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS session_state_auth_all ON public.session_state;
CREATE POLICY session_state_auth_all ON public.session_state
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- All other tables: authenticated-only. anon has NO direct access and must go
-- through the SECURITY DEFINER RPCs above.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'students',
    'present_students',
    'flagged',
    'cancelled_sessions',
    'class_schedule',
    'class_dates',
    'flagged_resolutions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_auth_all ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Realtime: make sure the tables the dashboard subscribes to are published.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['session_state', 'students', 'present_students'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', t);
    END IF;
  END LOOP;
END $$;
