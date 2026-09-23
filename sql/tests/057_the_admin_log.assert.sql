-- ============================================================================
-- Migration 057 — a log only admins can read
--
-- "Hidden" is the claim worth testing, and it is not the same as "not shown".
-- An ordinary TA is tried three ways: the reader, the writer, and the table
-- itself. A screen that simply never renders the log would pass a test that
-- only checked the first.
--
-- What is checked:
--
--   an admin writes a note and reads it back, with their name on it
--   an ordinary TA cannot read, cannot write, and cannot reach the table
--   an empty note is refused
--   pausing writes its own entry, without anybody typing one
--   a private note on a pause reaches the log and NOT the student's notice
--   an entry can be removed
--   an entry outlives its author's account
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('57000000-0000-0000-0000-000000000050', 'admin@assert-057.test',
   'Admin Person', 'approved', true),
  ('57000000-0000-0000-0000-000000000051', 'ta@assert-057.test',
   'Ordinary TA', 'approved', false),
  ('57000000-0000-0000-0000-000000000052', 'leaver@assert-057.test',
   'Leaving Admin', 'approved', true)
ON CONFLICT (user_id) DO NOTHING;

-- ------------------------------------------- an admin writes, and reads back --
SET ROLE authenticated;
SET request.jwt.claim.sub = '57000000-0000-0000-0000-000000000050';

DO $writes$
DECLARE
  v_entry jsonb;
  v_list  jsonb;
BEGIN
  v_entry := public.admin_log_write('Rotated the key and redeployed.');

  IF v_entry ->> 'author' <> 'Admin Person' THEN
    RAISE EXCEPTION '057: the entry is credited to %', v_entry ->> 'author';
  END IF;
  IF v_entry ->> 'kind' <> 'note' THEN
    RAISE EXCEPTION '057: a written entry came back as %', v_entry ->> 'kind';
  END IF;

  v_list := public.admin_log_list(10);
  IF NOT (v_list @> jsonb_build_array(
            jsonb_build_object('body', 'Rotated the key and redeployed.'))) THEN
    RAISE EXCEPTION '057: the note is not in the log: %', v_list;
  END IF;

  RAISE NOTICE '057 ok: an admin writes a note and reads it back';
END;
$writes$;

-- --------------------------------------------------- an empty note says nothing --
DO $empty$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.admin_log_write('   ');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '057: an empty note was accepted';
  END IF;
  RAISE NOTICE '057 ok: an empty note is refused';
END;
$empty$;

-- ------------------------------------- pausing writes an entry nobody typed --
DO $event$
DECLARE
  v_list jsonb;
  v_hits integer;
BEGIN
  PERFORM public.admin_set_service_paused(true, 'Copying the database');

  v_list := public.admin_log_list(10);
  SELECT count(*) INTO v_hits
  FROM jsonb_array_elements(v_list) e
  WHERE e ->> 'kind' = 'event'
    AND e ->> 'body' LIKE 'App paused%Copying the database%';
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '057: pausing wrote % entries, expected 1: %', v_hits, v_list;
  END IF;

  PERFORM public.admin_set_service_paused(false);

  SELECT count(*) INTO v_hits
  FROM jsonb_array_elements(public.admin_log_list(10)) e
  WHERE e ->> 'kind' = 'event' AND e ->> 'body' LIKE 'App resumed%';
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '057: resuming wrote no entry';
  END IF;

  RAISE NOTICE '057 ok: pausing and resuming write their own entries';
END;
$event$;

-- -------------------- the private note lands in the log, and only there --
-- The whole point of having two boxes: one sentence is for the student and one
-- is for whoever reads this in March. A note that leaked into the public
-- message would be worse than having no note at all.
DO $private_note$
DECLARE
  v_state jsonb;
  v_hits  integer;
BEGIN
  v_state := public.admin_set_service_paused(
    true, 'Back shortly', NULL, NULL,
    'Copying to the new project; key rotates straight after.');

  SELECT count(*) INTO v_hits
  FROM jsonb_array_elements(public.admin_log_list(10)) e
  WHERE e ->> 'kind' = 'event'
    AND e ->> 'body' LIKE '%Back shortly%'
    AND e ->> 'body' LIKE '%key rotates straight after%';
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '057: the note did not reach the log with its pause';
  END IF;

  IF (v_state ->> 'message') <> 'Back shortly' THEN
    RAISE EXCEPTION
      '057: students would be shown "%" — the private note leaked into the public message',
      v_state ->> 'message';
  END IF;

  IF (public.get_service_state() ->> 'message') LIKE '%key rotates%' THEN
    RAISE EXCEPTION '057: the private note is readable from the student-facing state';
  END IF;

  PERFORM public.admin_set_service_paused(false);
  RAISE NOTICE '057 ok: a pause note reaches the log and never the student';
END;
$private_note$;

-- ------------------------------------------- an ordinary TA reaches none of it --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '57000000-0000-0000-0000-000000000051';

DO $hidden$
DECLARE
  ok     boolean;
  v_rows integer;
BEGIN
  BEGIN
    PERFORM public.admin_log_list(10);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '057: an ordinary TA read the admin log';
  END IF;

  BEGIN
    PERFORM public.admin_log_write('Let me in');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '057: an ordinary TA wrote to the admin log';
  END IF;

  -- Hidden, not merely unrendered: the table itself gives them nothing.
  SELECT count(*) INTO v_rows FROM public.admin_log;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '057: an ordinary TA read % rows straight from the table', v_rows;
  END IF;

  RAISE NOTICE '057 ok: an ordinary TA cannot read, write, or reach the table';
END;
$hidden$;

-- ------------------------------ an entry outlives the account that wrote it --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '57000000-0000-0000-0000-000000000052';

DO $leaver$
BEGIN
  PERFORM public.admin_log_write('Left a note on the way out.');
END;
$leaver$;

-- The id is read as superuser: staff carries RLS, and a lookup by email from
-- inside a role-scoped session returns nothing and hands admin_delete_staff a
-- null, which it reports as "no such account" — a refusal that looks like the
-- rule under test failing. 050's test reads ids the same way.
RESET ROLE;

DO $ids$
BEGIN
  -- Carried in a config setting rather than a temp table: a temp table created
  -- as superuser is not readable by `authenticated`, and 050 passes ids between
  -- roles exactly this way.
  PERFORM set_config('t057.leaver',
    (SELECT id::text FROM public.staff WHERE email = 'leaver@assert-057.test'),
    true);
END;
$ids$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '57000000-0000-0000-0000-000000000050';

DO $outlives$
DECLARE
  v_hits  integer;
  v_id    uuid;
BEGIN
  PERFORM public.admin_delete_staff(current_setting('t057.leaver')::uuid);

  SELECT count(*) INTO v_hits
  FROM jsonb_array_elements(public.admin_log_list(50)) e
  WHERE e ->> 'body' = 'Left a note on the way out.'
    AND e ->> 'author' = 'Leaving Admin';
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '057: the entry did not survive its author being removed, or lost their name';
  END IF;

  -- And an entry can be removed.
  SELECT (e ->> 'id')::uuid INTO v_id
  FROM jsonb_array_elements(public.admin_log_list(50)) e
  WHERE e ->> 'body' = 'Left a note on the way out.';

  IF NOT public.admin_log_delete(v_id) THEN
    RAISE EXCEPTION '057: removing an entry reported nothing removed';
  END IF;

  SELECT count(*) INTO v_hits
  FROM jsonb_array_elements(public.admin_log_list(50)) e
  WHERE (e ->> 'id')::uuid = v_id;
  IF v_hits <> 0 THEN
    RAISE EXCEPTION '057: the entry is still there after being removed';
  END IF;

  RAISE NOTICE '057 ok: an entry outlives its author, and can be removed';
END;
$outlives$;

ROLLBACK;
