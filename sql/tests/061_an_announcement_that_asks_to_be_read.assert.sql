-- ============================================================================
-- Migration 061 — an announcement that asks to be read
--
-- What is checked:
--
--   an announcement with no period never becomes due — which is every
--     announcement posted before this migration, so running it must not start
--     interrupting anybody about week-old news
--   one with a period is due, once, and not again until the period is up
--   the period elapsing makes it due again, and counts the times shown
--   reading it stops it for good, however long the period is
--   being SHOWN it does not clear the unread dot: 049's unread count is a
--     NOT EXISTS on announcement_reads, and a prompt row written into that
--     table would silently mark everybody's announcements read
--   one person's prompts are invisible to another, and unwritable by them
--   an editor can turn the reminder off again — NULL is a value here, so an
--     edit that reads NULL as "leave alone" would make it one-way
--   an old client's two-argument post still works and never interrupts
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('61000000-0000-0000-0000-000000000061', 'admin@assert-061.test',
   'Admin Person', 'approved', true),
  ('61000000-0000-0000-0000-000000000062', 'ta@assert-061.test',
   'Reading TA', 'approved', false),
  ('61000000-0000-0000-0000-000000000063', 'other@assert-061.test',
   'Other TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

DO $seeded$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.staff WHERE email LIKE '%@assert-061.test';
  IF n <> 3 THEN
    RAISE EXCEPTION '061: seeded % of 3 accounts', n;
  END IF;

  PERFORM set_config('t061.ta',
    (SELECT id::text FROM public.staff WHERE email = 'ta@assert-061.test'), true);
  PERFORM set_config('t061.other',
    (SELECT id::text FROM public.staff WHERE email = 'other@assert-061.test'), true);
END;
$seeded$;

-- ---------------------------------------------------------- an admin posts --
SET ROLE authenticated;
SET request.jwt.claim.sub = '61000000-0000-0000-0000-000000000061';

DO $posts$
DECLARE
  v_quiet  public.announcements%ROWTYPE;
  v_loud   public.announcements%ROWTYPE;
BEGIN
  -- The old shape: two arguments, exactly as an unreloaded client sends them.
  v_quiet := public.admin_post_announcement(
               p_title := 'Quiet notice',
               p_body  := 'Filed under Updates, interrupting nobody.');

  IF v_quiet.remind_every_hours IS NOT NULL THEN
    RAISE EXCEPTION '061: a post with no period got one: %',
      v_quiet.remind_every_hours;
  END IF;

  v_loud := public.admin_post_announcement(
              'Downtime on Saturday',
              'The app will be paused from 9am.', 24);

  IF v_loud.remind_every_hours <> 24 THEN
    RAISE EXCEPTION '061: the period was stored as %', v_loud.remind_every_hours;
  END IF;

  PERFORM set_config('t061.quiet', v_quiet.id::text, true);
  PERFORM set_config('t061.loud', v_loud.id::text, true);

  RAISE NOTICE '061 ok: an old client still posts, and it interrupts nobody';
END;
$posts$;

-- ------------------------------------------------ what a TA is shown, when --
SET request.jwt.claim.sub = '61000000-0000-0000-0000-000000000062';

DO $due$
DECLARE
  v_due jsonb;
  n     integer;
BEGIN
  v_due := public.due_announcements();

  -- The loud one, and ONLY the loud one. The quiet one is the whole
  -- back-catalogue of announcements posted before 061.
  SELECT count(*) INTO n FROM jsonb_array_elements(v_due) e
   WHERE e ->> 'id' = current_setting('t061.loud');
  IF n <> 1 THEN
    RAISE EXCEPTION '061: the insisting announcement is not due: %', v_due;
  END IF;

  SELECT count(*) INTO n FROM jsonb_array_elements(v_due) e
   WHERE e ->> 'id' = current_setting('t061.quiet');
  IF n <> 0 THEN
    RAISE EXCEPTION '061: an announcement with no period was made due';
  END IF;

  -- Shown once; now leave them alone.
  IF public.note_announcements_shown(
       ARRAY[current_setting('t061.loud')::uuid]) <> 1 THEN
    RAISE EXCEPTION '061: being shown it was not recorded';
  END IF;

  v_due := public.due_announcements();
  SELECT count(*) INTO n FROM jsonb_array_elements(v_due) e
   WHERE e ->> 'id' = current_setting('t061.loud');
  IF n <> 0 THEN
    RAISE EXCEPTION '061: it came back inside its own period';
  END IF;

  RAISE NOTICE '061 ok: it is due once, and not again inside its period';
END;
$due$;

-- ------------------------------------- being shown it is not having read it --
DO $not_read$
DECLARE v_help jsonb;
BEGIN
  v_help := public.get_help();

  IF (v_help ->> 'unread')::integer < 2 THEN
    RAISE EXCEPTION
      '061: being shown an announcement cleared the unread dot (unread = %)',
      v_help ->> 'unread';
  END IF;

  RAISE NOTICE '061 ok: a prompt is not a read, and the dot survives it';
END;
$not_read$;

-- --------------------------------------------- the period runs out, it returns --
DO $later$
DECLARE
  v_due jsonb;
  n     integer;
  v_times integer;
BEGIN
  -- Rather than waiting a day: move the prompt back beyond the period.
  UPDATE public.announcement_prompts
     SET last_shown_at = now() - interval '25 hours'
   WHERE announcement_id = current_setting('t061.loud')::uuid
     AND staff_id = current_setting('t061.ta')::uuid;

  v_due := public.due_announcements();
  SELECT count(*) INTO n FROM jsonb_array_elements(v_due) e
   WHERE e ->> 'id' = current_setting('t061.loud');
  IF n <> 1 THEN
    RAISE EXCEPTION '061: it did not come back once its period had passed';
  END IF;

  PERFORM public.note_announcements_shown(
    ARRAY[current_setting('t061.loud')::uuid]);

  SELECT times_shown INTO v_times FROM public.announcement_prompts
   WHERE announcement_id = current_setting('t061.loud')::uuid
     AND staff_id = current_setting('t061.ta')::uuid;
  IF v_times <> 2 THEN
    RAISE EXCEPTION '061: shown twice but counted %', v_times;
  END IF;

  RAISE NOTICE '061 ok: the period elapsing brings it back, and it is counted';
END;
$later$;

-- ----------------------------------------------- reading it ends it for good --
DO $read$
DECLARE
  v_due jsonb;
  n     integer;
BEGIN
  PERFORM public.mark_announcements_read();

  -- Even with the period long past, a read announcement never returns.
  UPDATE public.announcement_prompts
     SET last_shown_at = now() - interval '400 hours'
   WHERE staff_id = current_setting('t061.ta')::uuid;

  v_due := public.due_announcements();
  SELECT count(*) INTO n FROM jsonb_array_elements(v_due) e
   WHERE e ->> 'id' = current_setting('t061.loud');
  IF n <> 0 THEN
    RAISE EXCEPTION '061: a read announcement came back';
  END IF;

  RAISE NOTICE '061 ok: reading it is what stops it, for good';
END;
$read$;

-- ------------------------------------------- one person's prompts are theirs --
SET request.jwt.claim.sub = '61000000-0000-0000-0000-000000000063';

DO $privacy$
DECLARE
  n  integer;
  ok boolean;
BEGIN
  SELECT count(*) INTO n FROM public.announcement_prompts
   WHERE staff_id = current_setting('t061.ta')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION '061: somebody else can read when a colleague was shown things';
  END IF;

  -- And the check above means something: this account can see its OWN rows.
  PERFORM public.note_announcements_shown(
    ARRAY[current_setting('t061.loud')::uuid]);
  SELECT count(*) INTO n FROM public.announcement_prompts
   WHERE staff_id = current_setting('t061.other')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION '061: this account cannot read its own prompts either';
  END IF;

  -- Writing one for somebody else is refused by the policy. An RLS-blocked
  -- INSERT raises rather than silently affecting nothing, unlike an UPDATE.
  BEGIN
    INSERT INTO public.announcement_prompts (announcement_id, staff_id)
    VALUES (current_setting('t061.loud')::uuid,
            current_setting('t061.ta')::uuid);
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '061: one account wrote a prompt row for another';
  END IF;

  RAISE NOTICE '061 ok: prompts are private to the person they are about';
END;
$privacy$;

-- ------------------------------------------ an admin can turn it off again --
SET request.jwt.claim.sub = '61000000-0000-0000-0000-000000000061';

DO $off$
DECLARE v_row public.announcements%ROWTYPE;
BEGIN
  -- An edit that does not mention the reminder leaves it alone.
  v_row := public.admin_edit_announcement(
             current_setting('t061.loud')::uuid, 'Downtime on Saturday (9am)');
  IF v_row.remind_every_hours <> 24 THEN
    RAISE EXCEPTION '061: fixing the title changed the period to %',
      v_row.remind_every_hours;
  END IF;

  -- And one that does can clear it. NULL is a value here, so this is the case
  -- a COALESCE-based edit would make impossible.
  v_row := public.admin_edit_announcement(
             p_id := current_setting('t061.loud')::uuid,
             p_remind_every_hours := NULL,
             p_change_reminder := true);
  IF v_row.remind_every_hours IS NOT NULL THEN
    RAISE EXCEPTION '061: the reminder could not be turned off';
  END IF;

  RAISE NOTICE '061 ok: a reminder can be left alone, and can be turned off';
END;
$off$;

RESET ROLE;
ROLLBACK;
