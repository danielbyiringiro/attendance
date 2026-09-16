-- ============================================================================
-- Migration 049 — help videos and announcements
--
-- Two accounts: an admin who posts, and an ordinary member of staff who reads.
-- The interesting half is the split between them, and the fact that read state
-- belongs to one person rather than to a browser.
--
-- What is checked:
--
--   an admin can add a video and post a notice
--   a video link must be http(s)              the hazard this feature adds
--   an ordinary account can read both         and cannot write either
--   unread counts per account                 not per browser, not globally
--   reading clears the dot and only for you
--   reading twice is not a second event
--   an edit does not un-read or reorder       posted_at is left alone
--   deleting a notice takes its reads with it
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- Both accounts are seeded here, before any SET ROLE, the way 021 does it.
--
-- Not through ensure_staff and an UPDATE: staff_admin_writes (003) means an
-- account cannot make ITSELF an admin, which is the policy working correctly.
-- The first admin of an installation is made outside the app, so a test that
-- needs one seeds it the same way.
--
-- Ids nobody else uses. Every assert file shares one database and its seeds
-- are still there when the next one runs, so 11111111-… and 22222222-… are
-- already taken — staff.user_id is UNIQUE, and this collided on it.
--
-- DO NOTHING rather than plain INSERT: if a later file ever claims these, this
-- one should still describe its own accounts rather than fail on somebody
-- else's row.
INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('49000000-0000-0000-0000-000000000049', 'admin@assert-049.test',
   'Admin Person', 'approved', true),
  ('49000000-0000-0000-0000-00000000004a', 'reader@assert-049.test',
   'Ordinary Person', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

SET ROLE authenticated;
SET request.jwt.claim.sub = '49000000-0000-0000-0000-000000000049';

DO $setup_admin$
BEGIN
  PERFORM set_config('t049.admin',
    (SELECT id::text FROM public.staff
      WHERE user_id = '49000000-0000-0000-0000-000000000049'), true);

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '049: the seeded admin is not an admin — the test is wrong, not the migration';
  END IF;
END;
$setup_admin$;

DO $admin_writes$
DECLARE
  v_video public.help_videos%ROWTYPE;
  v_note  public.announcements%ROWTYPE;
  ok      boolean;
BEGIN
  v_video := public.admin_set_help_video(
    p_title       := 'How this works',
    p_url         := 'https://www.youtube.com/watch?v=dummy1',
    p_description := 'The five minute overview',
    p_sort_order  := 0);
  PERFORM set_config('t049.video', v_video.id::text, true);

  IF v_video.added_by IS DISTINCT FROM current_setting('t049.admin')::uuid THEN
    RAISE EXCEPTION '049: the video was not attributed to the admin who added it';
  END IF;

  -- The hazard: a link every member of staff will click.
  BEGIN
    PERFORM public.admin_set_help_video(
      p_title := 'Bad', p_url := 'javascript:alert(1)');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '049: a javascript: link was accepted as a help video';
  END IF;

  BEGIN
    INSERT INTO public.help_videos (title, url) VALUES ('Bad', 'ftp://elsewhere');
    ok := false;
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '049: the column accepted a link that is not http(s)';
  END IF;

  v_note := public.admin_post_announcement(
    'Check-in can close at the start now',
    'Set it on Class then Settings. Off by default.');
  PERFORM set_config('t049.note', v_note.id::text, true);

  BEGIN
    PERFORM public.admin_post_announcement('   ', 'body');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '049: an announcement with no title was posted';
  END IF;

  RAISE NOTICE '049 ok: an admin adds videos and posts notices, and a bad link is refused';
END;
$admin_writes$;

-- ----------------------------------------------------------------------------
-- An ordinary member of staff
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '49000000-0000-0000-0000-00000000004a';

DO $setup_reader$
BEGIN
  PERFORM set_config('t049.reader',
    (SELECT id::text FROM public.staff
      WHERE user_id = '49000000-0000-0000-0000-00000000004a'), true);

  IF public.is_admin() THEN
    RAISE EXCEPTION '049: the ordinary account came out as an admin';
  END IF;
END;
$setup_reader$;

DO $reader_reads$
DECLARE
  h  jsonb := public.get_help();
  ok boolean;
BEGIN
  IF jsonb_array_length(h -> 'videos') <> 1 THEN
    RAISE EXCEPTION '049: an ordinary account sees % videos, expected 1',
      jsonb_array_length(h -> 'videos');
  END IF;

  IF (h ->> 'unread')::int <> 1 THEN
    RAISE EXCEPTION '049: a notice they have never seen counts as % unread, expected 1',
      h ->> 'unread';
  END IF;

  IF (h -> 'announcements' -> 0 ->> 'read')::boolean THEN
    RAISE EXCEPTION '049: an unread notice came back marked read';
  END IF;

  -- Readable, not writable.
  BEGIN
    PERFORM public.admin_post_announcement('Not mine to post', 'body');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '049: an ordinary account posted an announcement';
  END IF;

  BEGIN
    INSERT INTO public.help_videos (title, url)
    VALUES ('Mine', 'https://example.com/x');
    ok := false;
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '049: an ordinary account wrote straight to help_videos';
  END IF;

  RAISE NOTICE '049 ok: staff read the videos and notices, and cannot write either';
END;
$reader_reads$;

DO $reading$
DECLARE
  v_marked integer;
  h        jsonb;
BEGIN
  v_marked := public.mark_announcements_read();
  IF v_marked <> 1 THEN
    RAISE EXCEPTION '049: marking everything read recorded % rows, expected 1', v_marked;
  END IF;

  h := public.get_help();
  IF (h ->> 'unread')::int <> 0 THEN
    RAISE EXCEPTION '049: the dot did not clear: % unread', h ->> 'unread';
  END IF;

  -- Still there. "Read" is a state on it, not a reason to hide it.
  IF jsonb_array_length(h -> 'announcements') <> 1 THEN
    RAISE EXCEPTION '049: a notice disappeared once it was read';
  END IF;
  IF NOT (h -> 'announcements' -> 0 ->> 'read')::boolean THEN
    RAISE EXCEPTION '049: a notice that was read did not come back marked read';
  END IF;

  -- Reading twice is not a second event.
  v_marked := public.mark_announcements_read();
  IF v_marked <> 0 THEN
    RAISE EXCEPTION '049: reading the same notice again recorded % more rows', v_marked;
  END IF;

  RAISE NOTICE '049 ok: reading clears the dot, the notice stays, and it cannot be read twice';
END;
$reading$;

-- ----------------------------------------------------------------------------
-- Back to the admin: their own dot is untouched by somebody else reading
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '49000000-0000-0000-0000-000000000049';

DO $per_account$
DECLARE
  h jsonb := public.get_help();
BEGIN
  IF (h ->> 'unread')::int <> 1 THEN
    RAISE EXCEPTION '049: one person reading a notice cleared it for somebody else (% unread)',
      h ->> 'unread';
  END IF;

  -- Through get_help, not the table: announcement_reads_own means a direct
  -- SELECT here can only ever see the caller's own rows, so querying it for
  -- somebody else's would be a check that cannot fail.
  IF (h -> 'announcements' -> 0 ->> 'read')::boolean THEN
    RAISE EXCEPTION '049: the admin was told they had read their own notice';
  END IF;

  RAISE NOTICE '049 ok: read state belongs to one account, not to everybody';
END;
$per_account$;

DO $editing$
DECLARE
  v_before timestamptz;
  v_after  public.announcements%ROWTYPE;
BEGIN
  SELECT posted_at INTO v_before
  FROM public.announcements WHERE id = current_setting('t049.note')::uuid;

  v_after := public.admin_edit_announcement(
    current_setting('t049.note')::uuid,
    p_title := 'Check-in can close at the start');

  IF v_after.posted_at <> v_before THEN
    RAISE EXCEPTION '049: fixing a typo moved the notice back to the top of the list';
  END IF;

  RAISE NOTICE '049 ok: an edit leaves the date alone';
END;
$editing$;

-- Whether the edit un-read it is a question only the reader can answer: RLS
-- hides their row from everybody else, so this has to be asked as them, and
-- through get_help — which is the path the screen itself uses.
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '49000000-0000-0000-0000-00000000004a';

DO $still_read$
DECLARE
  h jsonb := public.get_help();
BEGIN
  IF (h ->> 'unread')::int <> 0 THEN
    RAISE EXCEPTION '049: editing a notice made it unread again (% unread)',
      h ->> 'unread';
  END IF;

  IF NOT (h -> 'announcements' -> 0 ->> 'read')::boolean THEN
    RAISE EXCEPTION '049: editing a notice un-read it for somebody who had read it';
  END IF;

  IF (h -> 'announcements' -> 0 ->> 'title') <> 'Check-in can close at the start' THEN
    RAISE EXCEPTION '049: the edit did not reach the reader: %',
      h -> 'announcements' -> 0 ->> 'title';
  END IF;

  RAISE NOTICE '049 ok: the edit reached everybody and un-read it for nobody';
END;
$still_read$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '49000000-0000-0000-0000-000000000049';

DO $deleting$
BEGIN
  PERFORM public.admin_delete_announcement(current_setting('t049.note')::uuid);

  -- As superuser: RLS would hide the reader's row from this session, so the
  -- check would pass whether or not the cascade fired. A check that cannot
  -- fail is worse than no check.
  RESET ROLE;
  IF EXISTS (
    SELECT 1 FROM public.announcement_reads
    WHERE announcement_id = current_setting('t049.note')::uuid
  ) THEN
    RAISE EXCEPTION '049: deleting a notice left its read rows behind';
  END IF;
  SET ROLE authenticated;

  IF NOT public.admin_delete_help_video(current_setting('t049.video')::uuid) THEN
    RAISE EXCEPTION '049: deleting a video reported that it was not there';
  END IF;

  IF jsonb_array_length(public.get_help() -> 'videos') <> 0 THEN
    RAISE EXCEPTION '049: a deleted video is still on the Help screen';
  END IF;

  RAISE NOTICE '049 ok: deleting a notice takes its read rows, and a video goes cleanly';
END;
$deleting$;

ROLLBACK;
