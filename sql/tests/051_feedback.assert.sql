-- ============================================================================
-- Migration 051 — feedback from staff
--
-- Three accounts on ids nobody else in the suite uses: an admin, an approved
-- member of staff who reports something, and a pending account who may not.
--
-- What is checked:
--
--   approved staff can send, and it is attributed to them
--   a pending account cannot
--   nobody can file a report under somebody else's name
--   you read your own; you do not read anybody else's
--   an admin reads everything, with the sender resolved
--   handled is set and cleared, and clearing forgets the timestamp
--   an ordinary account cannot list, handle or delete
--   a report outlives its author (050 deletes the account, 051 keeps the text)
--
-- EVERY check runs as a session that can actually see the row. staff, feedback
-- and announcement_reads are all RLS-scoped, and a check asked from the wrong
-- session passes or fails for reasons that have nothing to do with the code —
-- which cost four rounds earlier in this branch.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('51000000-0000-0000-0000-000000000051', 'admin@assert-051.test',
   'Admin Person', 'approved', true),
  ('51000000-0000-0000-0000-000000000052', 'ta@assert-051.test',
   'Reporting TA', 'approved', false),
  ('51000000-0000-0000-0000-000000000053', 'waiting@assert-051.test',
   'Waiting Person', 'pending', false)
ON CONFLICT (user_id) DO NOTHING;

-- The seed landed, all three rows. ON CONFLICT DO NOTHING is silent by design,
-- so without this a skipped row shows up much later as a guard that appears to
-- work and does not.
DO $seeded$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.staff
   WHERE email LIKE '%@assert-051.test';
  IF n <> 3 THEN
    RAISE EXCEPTION '051: seeded % of 3 accounts — statuses present: %',
      n,
      (SELECT string_agg(email || '=' || status, ', ' ORDER BY email)
         FROM public.staff WHERE email LIKE '%@assert-051.test');
  END IF;
END;
$seeded$;

DO $ids$
BEGIN
  PERFORM set_config('t051.admin',
    (SELECT id::text FROM public.staff WHERE email = 'admin@assert-051.test'), true);
  PERFORM set_config('t051.ta',
    (SELECT id::text FROM public.staff WHERE email = 'ta@assert-051.test'), true);
  PERFORM set_config('t051.waiting',
    (SELECT id::text FROM public.staff WHERE email = 'waiting@assert-051.test'), true);
END;
$ids$;

-- ----------------------------------------------------------------------------
-- An approved member of staff reports something
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = '51000000-0000-0000-0000-000000000052';

DO $sends$
DECLARE
  v_row public.feedback%ROWTYPE;
  ok    boolean;
BEGIN
  v_row := public.send_feedback(
    'The weekly pattern editor is confusing when a cohort meets twice.',
    'class/pattern');
  PERFORM set_config('t051.report', v_row.id::text, true);

  IF v_row.staff_id IS DISTINCT FROM current_setting('t051.ta')::uuid THEN
    RAISE EXCEPTION '051: the report was not attributed to the person who sent it';
  END IF;

  IF v_row.handled THEN
    RAISE EXCEPTION '051: a new report arrived already handled';
  END IF;

  IF v_row.page <> 'class/pattern' THEN
    RAISE EXCEPTION '051: the screen it came from was lost: %', v_row.page;
  END IF;

  -- Nothing to act on.
  BEGIN
    PERFORM public.send_feedback('   ');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '051: an empty report was accepted';
  END IF;

  -- Under somebody else's name. The INSERT policy is the only thing stopping
  -- this, so it is worth asking directly rather than through the RPC.
  BEGIN
    INSERT INTO public.feedback (staff_id, body)
    VALUES (current_setting('t051.admin')::uuid, 'Not mine to file');
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '051: one account filed a report under another account''s name';
  END IF;

  -- They read their own back.
  IF NOT EXISTS (
    SELECT 1 FROM public.feedback
    WHERE id = current_setting('t051.report')::uuid
  ) THEN
    RAISE EXCEPTION '051: somebody cannot see the report they just sent';
  END IF;

  RAISE NOTICE '051 ok: approved staff report as themselves, and read their own back';
END;
$sends$;

-- ----------------------------------------------------------------------------
-- A pending account cannot
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '51000000-0000-0000-0000-000000000053';

DO $pending$
DECLARE
  ok    boolean;
  v_msg text;
BEGIN
  -- The fixture first. A block whose account was never seeded refuses
  -- everything for want of a staff row and reports that as a pass, which is
  -- how a guard stops being load-bearing without anybody noticing.
  --
  -- By user_id, NOT current_staff_id(): that function is approved-only since
  -- 020, so for a PENDING account it is always NULL and this guard would fire
  -- every time, saying the row is missing when it is sitting right there.
  -- staff_select lets an account see its own row, so this is readable here.
  IF NOT EXISTS (SELECT 1 FROM public.staff WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION
      '051: the waiting account is not in staff — every check below would pass '
      'for the wrong reason';
  END IF;

  BEGIN
    PERFORM public.send_feedback('Let me in');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
    v_msg := SQLERRM;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '051: an account still waiting for approval sent feedback';
  END IF;

  -- And refused for BEING UNAPPROVED, not for some unrelated reason. Without
  -- this the assertion above passes on any error at all.
  IF v_msg NOT LIKE '%not approved%' THEN
    RAISE EXCEPTION
      '051: the pending account was refused, but not for being unapproved: %',
      v_msg;
  END IF;

  -- And sees nothing of anybody else's.
  IF EXISTS (SELECT 1 FROM public.feedback) THEN
    RAISE EXCEPTION '051: a pending account can read other people''s reports';
  END IF;

  BEGIN
    PERFORM public.admin_list_feedback();
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '051: a non-admin listed everybody''s feedback';
  END IF;

  RAISE NOTICE '051 ok: a pending account cannot send, read or list';
END;
$pending$;

-- ----------------------------------------------------------------------------
-- The admin
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '51000000-0000-0000-0000-000000000051';

DO $admin_reads$
DECLARE
  v_all  jsonb := public.admin_list_feedback();
  v_one  jsonb;
  v_row  public.feedback%ROWTYPE;
BEGIN
  SELECT x INTO v_one
  FROM jsonb_array_elements(v_all) AS x
  WHERE x ->> 'id' = current_setting('t051.report')
  LIMIT 1;

  IF v_one IS NULL THEN
    RAISE EXCEPTION '051: the admin cannot see a report that was sent';
  END IF;

  IF (v_one ->> 'from_email') <> 'ta@assert-051.test' THEN
    RAISE EXCEPTION '051: the sender was not resolved: %', v_one ->> 'from_email';
  END IF;

  -- Handled, then not. The timestamp has to go when it is cleared, or a report
  -- reopened later carries a date saying it was already dealt with.
  v_row := public.admin_set_feedback_handled(
    current_setting('t051.report')::uuid, true);
  IF NOT v_row.handled OR v_row.handled_at IS NULL THEN
    RAISE EXCEPTION '051: marking it handled did not take: % / %',
      v_row.handled, v_row.handled_at;
  END IF;

  IF v_row.handled_by IS DISTINCT FROM current_setting('t051.admin')::uuid THEN
    RAISE EXCEPTION '051: handled_by is not the admin who handled it';
  END IF;

  v_row := public.admin_set_feedback_handled(
    current_setting('t051.report')::uuid, false);
  IF v_row.handled OR v_row.handled_at IS NOT NULL THEN
    RAISE EXCEPTION '051: reopening it left the handled date behind: %',
      v_row.handled_at;
  END IF;

  -- Filtering, which is what the screen actually calls.
  IF jsonb_array_length(public.admin_list_feedback(true)) <> 0 THEN
    RAISE EXCEPTION '051: something is listed as handled when nothing is';
  END IF;
  IF jsonb_array_length(public.admin_list_feedback(false)) = 0 THEN
    RAISE EXCEPTION '051: the unhandled list is empty with an open report in it';
  END IF;

  RAISE NOTICE '051 ok: an admin reads everything with the sender, and handled is set and cleared';
END;
$admin_reads$;

-- ----------------------------------------------------------------------------
-- A report outlives the person who sent it
--
-- 050 removes the account; 051 holds the sender by SET NULL. Deleting somebody
-- must not destroy a report still worth acting on.
-- ----------------------------------------------------------------------------

DO $outlives$
DECLARE v_body text;
BEGIN
  PERFORM public.admin_delete_staff(current_setting('t051.ta')::uuid);

  SELECT body INTO v_body
  FROM public.feedback WHERE id = current_setting('t051.report')::uuid;

  IF v_body IS NULL THEN
    RAISE EXCEPTION '051: deleting the sender destroyed their report';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.feedback
    WHERE id = current_setting('t051.report')::uuid AND staff_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '051: the report still points at an account that is gone';
  END IF;

  -- And the admin list copes with an author who no longer exists.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.admin_list_feedback()) AS x
    WHERE x ->> 'id' = current_setting('t051.report')
      AND x ->> 'from_email' IS NULL
  ) THEN
    RAISE EXCEPTION '051: the orphaned report is missing or still claims a sender';
  END IF;

  RAISE NOTICE '051 ok: a report survives its author, holding no name';
END;
$outlives$;

DO $removing$
BEGIN
  IF NOT public.admin_delete_feedback(current_setting('t051.report')::uuid) THEN
    RAISE EXCEPTION '051: deleting a report reported that it was not there';
  END IF;

  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.feedback
              WHERE id = current_setting('t051.report')::uuid) THEN
    RAISE EXCEPTION '051: the deleted report is still there';
  END IF;
  SET ROLE authenticated;

  RAISE NOTICE '051 ok: rubbish can be removed outright';
END;
$removing$;

ROLLBACK;
