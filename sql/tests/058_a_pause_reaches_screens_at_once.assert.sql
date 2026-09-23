-- ============================================================================
-- Migration 058 — a pause reaches open screens at once
--
-- Two claims, and the second is the one that could quietly go wrong: staff can
-- now read the switch, and an anonymous visitor still cannot. Opening a table
-- for streaming is exactly the kind of change that takes anon along with it,
-- and 027 sweeps for that across every table — this checks the new one
-- directly as well, so the failure names itself.
--
-- What is checked:
--
--   a signed-in TA can read the switch (without it, nothing streams)
--   an anonymous visitor still cannot
--   neither of them can write it, however they try
--   the admin path still works
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('58000000-0000-0000-0000-000000000050', 'admin@assert-058.test',
   'Admin Person', 'approved', true),
  ('58000000-0000-0000-0000-000000000051', 'ta@assert-058.test',
   'Ordinary TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

-- ------------------------------------------- staff can read, and only read --
SET ROLE authenticated;
SET request.jwt.claim.sub = '58000000-0000-0000-0000-000000000051';

DO $staff_reads$
DECLARE
  v_rows    integer;
  v_changed integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.service_state;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      '058: a signed-in TA read % rows of the switch — realtime sends nothing it cannot read',
      v_rows;
  END IF;

  -- Blocked by RLS means zero rows, not an exception.
  UPDATE public.service_state SET paused = true WHERE id;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed <> 0 OR (public.get_service_state() ->> 'paused')::boolean THEN
    RAISE EXCEPTION
      '058: a TA paused the app by writing the table directly (% rows)', v_changed;
  END IF;

  RAISE NOTICE '058 ok: staff can read the switch, and cannot write it';
END;
$staff_reads$;

-- --------------------------------------------- anon is still given nothing --
RESET ROLE;
SET ROLE anon;

DO $anon_blocked$
DECLARE
  v_rows integer;
  ok     boolean;
BEGIN
  BEGIN
    SELECT count(*) INTO v_rows FROM public.service_state;
    ok := v_rows = 0;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION
      '058: an anonymous visitor read the switch — opening a table for streaming took anon with it';
  END IF;

  -- The function is still their way in, and still answers.
  IF (public.get_service_state() ->> 'state') IS NULL THEN
    RAISE EXCEPTION '058: a student can no longer ask whether the app is paused';
  END IF;

  RAISE NOTICE '058 ok: anon reads nothing from the table, and still gets an answer';
END;
$anon_blocked$;

-- ------------------------------------------------- the admin path is intact --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '58000000-0000-0000-0000-000000000050';

DO $admin_path$
BEGIN
  IF NOT (public.admin_set_service_paused(true, 'Still works') ->> 'paused')::boolean THEN
    RAISE EXCEPTION '058: an admin can no longer pause';
  END IF;
  IF (public.admin_set_service_paused(false) ->> 'paused')::boolean THEN
    RAISE EXCEPTION '058: an admin can no longer resume';
  END IF;
  RAISE NOTICE '058 ok: an admin can still pause and resume';
END;
$admin_path$;

ROLLBACK;
