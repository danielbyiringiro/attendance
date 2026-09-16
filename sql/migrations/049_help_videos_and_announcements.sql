-- ============================================================================
-- 049 — help videos, and announcements people can actually be told about
--
-- WHAT IS MISSING TODAY
--
-- The only guidance anywhere in this app is the words "No classes yet" and one
-- toast saying "Set when each one meets, then generate sessions". The README
-- explains the setup order and cannot be reached from inside the app. A new TA
-- lands on a class with no meeting days, no sessions, no students and four tabs
-- that all look equally plausible.
--
-- WHY VIDEOS RATHER THAN A GUIDED TOUR
--
-- A tour is markup that describes other markup, so it rots the moment a screen
-- moves — and these screens moved twice in one week. A video is re-recorded and
-- the link repasted, which costs nothing to keep current. It also survives the
-- thing a first-run tour cannot: being watched again in week six.
--
-- Videos LINK OUT. Nothing is embedded: an iframe would mean admitting a player
-- and its scripts into a page that has deliberately stayed dependency-free, and
-- none of this reaches the student check-in page at all.
--
-- ANNOUNCEMENTS, AND WHY READ STATE IS PER ACCOUNT
--
-- An announcement nobody notices is a changelog. The unread marker is the whole
-- feature, so it has to follow the person: per browser (localStorage, the way
-- the sound toggle works) means the same person sees it twice on a laptop and a
-- phone, and loses it entirely on a new machine. announcement_reads is one row
-- per person per announcement, and it is also the only way to know whether
-- anybody actually read the thing.
--
-- Announcements stay readable after they are read. They are listed in Help
-- under "Updates"; "new" is a state on one of them, not a place things live in.
-- People forget what changed.
--
-- WHO SEES WHAT
--
-- Staff only, both. The student surface is an ID and a PIN, and adding a
-- notices board to it would be the first thing on that page that is not about
-- checking in.
--
-- Any approved member of staff reads; only an admin writes. That is the
-- existing is_admin() split, and the same policy shape 003 uses for staff.
--
-- URLS ARE CHECKED
--
-- Every staff member clicks these, and an admin pasting `javascript:` into one
-- is the only genuine hazard this feature introduces. http and https only,
-- refused at the door rather than sanitised on the way out — a link stored
-- wrong is a link some other screen renders wrong later.
--
-- Run AFTER 048. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.help_videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  url         text NOT NULL,
  /** Shown under the title. Optional: a good title often needs no gloss. */
  description text,
  /** Ascending. The overview is whichever an admin puts first. */
  sort_order  integer NOT NULL DEFAULT 0,
  added_by    uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT help_videos_title_present CHECK (btrim(title) <> ''),
  CONSTRAINT help_videos_url_is_web CHECK (url ~* '^https?://')
);

CREATE INDEX IF NOT EXISTS idx_help_videos_order
  ON public.help_videos (sort_order, created_at);

CREATE TABLE IF NOT EXISTS public.announcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  body       text NOT NULL,
  posted_by  uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  posted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT announcements_title_present CHECK (btrim(title) <> ''),
  CONSTRAINT announcements_body_present  CHECK (btrim(body)  <> '')
);

CREATE INDEX IF NOT EXISTS idx_announcements_posted
  ON public.announcements (posted_at DESC);

-- One row per person per announcement. The primary key is the whole point:
-- reading something twice is not an event, so it cannot be recorded twice.
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  announcement_id uuid NOT NULL
    REFERENCES public.announcements(id) ON DELETE CASCADE,
  staff_id        uuid NOT NULL
    REFERENCES public.staff(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (announcement_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_staff
  ON public.announcement_reads (staff_id);

DROP TRIGGER IF EXISTS trg_help_videos_touch ON public.help_videos;
CREATE TRIGGER trg_help_videos_touch
  BEFORE UPDATE ON public.help_videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_announcements_touch ON public.announcements;
CREATE TRIGGER trg_announcements_touch
  BEFORE UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.help_videos IS
  'Videos linked from the Help screen. Admin-managed, staff-readable, never '
  'embedded — the app links out to them (049).';
COMMENT ON TABLE public.announcements IS
  'Notices from an admin to staff, listed in Help under Updates (049).';
COMMENT ON TABLE public.announcement_reads IS
  'Who has read which announcement. Per account rather than per browser, so '
  'the unread marker follows the person between devices (049).';

-- ----------------------------------------------------------------------------
-- Grants, said out loud
--
-- RLS only ever narrows what a table-level grant already allows, so a table
-- with policies and no grant is a table nobody can read. Supabase grants these
-- by default for tables the owner creates, and the local harness does the same
-- through ALTER DEFAULT PRIVILEGES in its shim — which is exactly why it is
-- worth writing here: the test cannot tell the difference between "granted on
-- purpose" and "granted by a default", so a missing grant would only ever
-- surface on the live project.
--
-- anon gets nothing. None of this reaches the student check-in page.
-- ----------------------------------------------------------------------------

GRANT SELECT ON public.help_videos   TO authenticated;
GRANT SELECT ON public.announcements TO authenticated;
-- Insert and delete, not update: marking a thing read is adding a row, and
-- changing your mind is removing it. There is nothing in between to amend.
GRANT SELECT, INSERT, DELETE ON public.announcement_reads TO authenticated;

-- ----------------------------------------------------------------------------
-- RLS — staff read, admins write, and you only ever mark yourself as having
-- read something. The shape is 003's: a _select policy for readers and a FOR
-- ALL _admin_writes gated on is_admin().
--
-- The admin write policies need no extra grant: every admin RPC below is
-- SECURITY DEFINER and runs as the owner, so the policies are a second lock on
-- the direct path rather than the only one.
-- ----------------------------------------------------------------------------

ALTER TABLE public.help_videos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS help_videos_select       ON public.help_videos;
DROP POLICY IF EXISTS help_videos_admin_writes ON public.help_videos;

CREATE POLICY help_videos_select ON public.help_videos
  FOR SELECT TO authenticated USING (true);

CREATE POLICY help_videos_admin_writes ON public.help_videos
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS announcements_select       ON public.announcements;
DROP POLICY IF EXISTS announcements_admin_writes ON public.announcements;

CREATE POLICY announcements_select ON public.announcements
  FOR SELECT TO authenticated USING (true);

CREATE POLICY announcements_admin_writes ON public.announcements
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Your own reads, and nobody else's. An admin has no business reading this
-- table row by row either: "who has read it" is a count, and the RPC below is
-- where that lives.
DROP POLICY IF EXISTS announcement_reads_own ON public.announcement_reads;

CREATE POLICY announcement_reads_own ON public.announcement_reads
  FOR ALL TO authenticated
  USING (staff_id = public.current_staff_id())
  WITH CHECK (staff_id = public.current_staff_id());

-- ----------------------------------------------------------------------------
-- get_help — everything the Help screen shows, in one call
--
-- Including the caller's own unread count, because the sidebar needs it to
-- decide whether to show a dot and a second round trip for one integer is a
-- second thing to get wrong.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_help()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff uuid := public.current_staff_id();
BEGIN
  -- Not signed in as staff at all. Returns empty rather than raising: the
  -- screen asking is one anybody signed in can reach, and an error there would
  -- be a bug report about nothing.
  IF v_staff IS NULL THEN
    RETURN jsonb_build_object(
      'videos', '[]'::jsonb, 'announcements', '[]'::jsonb, 'unread', 0);
  END IF;

  RETURN jsonb_build_object(
    'videos', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'id',          v.id,
                 'title',       v.title,
                 'url',         v.url,
                 'description', v.description)
               ORDER BY v.sort_order, v.created_at)
      FROM public.help_videos v), '[]'::jsonb),
    'announcements', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'id',        a.id,
                 'title',     a.title,
                 'body',      a.body,
                 'posted_at', a.posted_at,
                 -- Read stays readable; this only decides the dot.
                 'read',      r.staff_id IS NOT NULL)
               ORDER BY a.posted_at DESC)
      FROM public.announcements a
      LEFT JOIN public.announcement_reads r
        ON r.announcement_id = a.id AND r.staff_id = v_staff), '[]'::jsonb),
    'unread', (
      SELECT count(*)
      FROM public.announcements a
      WHERE NOT EXISTS (
        SELECT 1 FROM public.announcement_reads r
        WHERE r.announcement_id = a.id AND r.staff_id = v_staff))
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- mark_announcements_read — the dot clears
--
-- Everything, or the ones named. ON CONFLICT DO NOTHING because reading twice
-- is not a second event, and two tabs open on Help would otherwise collide.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_announcements_read(
  p_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff uuid := public.current_staff_id();
  v_read  integer := 0;
BEGIN
  IF v_staff IS NULL THEN
    RETURN 0;
  END IF;

  WITH marked AS (
    INSERT INTO public.announcement_reads (announcement_id, staff_id)
    SELECT a.id, v_staff
    FROM public.announcements a
    WHERE p_ids IS NULL OR a.id = ANY (p_ids)
    ON CONFLICT (announcement_id, staff_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_read FROM marked;

  RETURN v_read;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Admin: the videos
--
-- One upsert rather than separate add and edit. The screen has a list and a
-- form, and "which of the two RPCs is this" is a decision the screen should not
-- have to make.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_help_video(
  p_id          uuid    DEFAULT NULL,
  p_title       text    DEFAULT NULL,
  p_url         text    DEFAULT NULL,
  p_description text    DEFAULT NULL,
  p_sort_order  integer DEFAULT NULL
)
RETURNS public.help_videos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_video public.help_videos%ROWTYPE;
  v_title text := btrim(COALESCE(p_title, ''));
  v_url   text := btrim(COALESCE(p_url, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF p_id IS NULL THEN
    IF v_title = '' OR v_url = '' THEN
      RAISE EXCEPTION 'a video needs a title and a link';
    END IF;

    -- Checked here as well as by the constraint, so the message is one a person
    -- can act on rather than a constraint name.
    IF v_url !~* '^https?://' THEN
      RAISE EXCEPTION
        'a video link must start with http:// or https:// — paste the address '
        'from the browser, not a file path';
    END IF;

    INSERT INTO public.help_videos (title, url, description, sort_order, added_by)
    VALUES (v_title, v_url, NULLIF(btrim(COALESCE(p_description, '')), ''),
            COALESCE(p_sort_order, 0), public.current_staff_id())
    RETURNING * INTO v_video;

    RETURN v_video;
  END IF;

  IF p_url IS NOT NULL AND v_url !~* '^https?://' THEN
    RAISE EXCEPTION
      'a video link must start with http:// or https:// — paste the address '
      'from the browser, not a file path';
  END IF;

  UPDATE public.help_videos
     SET title       = COALESCE(NULLIF(v_title, ''), title),
         url         = COALESCE(NULLIF(v_url, ''), url),
         -- Cleared on purpose when an empty string is sent, kept when NULL is:
         -- "remove the description" has to be expressible.
         description = CASE
                         WHEN p_description IS NULL THEN description
                         ELSE NULLIF(btrim(p_description), '')
                       END,
         sort_order  = COALESCE(p_sort_order, sort_order)
   WHERE id = p_id
  RETURNING * INTO v_video;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'that video does not exist';
  END IF;

  RETURN v_video;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_delete_help_video(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  DELETE FROM public.help_videos WHERE id = p_id;
  RETURN FOUND;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Admin: the announcements
--
-- Posting one is deliberately not an upsert. An announcement is an event with a
-- date, and "edit the one I posted last week" and "post a new one" are
-- different acts — conflating them is how somebody silently rewrites what
-- people have already read.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_post_announcement(
  p_title text,
  p_body  text
)
RETURNS public.announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row   public.announcements%ROWTYPE;
  v_title text := btrim(COALESCE(p_title, ''));
  v_body  text := btrim(COALESCE(p_body, ''));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF v_title = '' OR v_body = '' THEN
    RAISE EXCEPTION 'an announcement needs a title and something to say';
  END IF;

  INSERT INTO public.announcements (title, body, posted_by)
  VALUES (v_title, v_body, public.current_staff_id())
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_edit_announcement(
  p_id    uuid,
  p_title text DEFAULT NULL,
  p_body  text DEFAULT NULL
)
RETURNS public.announcements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.announcements%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  -- posted_at is NOT touched: fixing a typo should not push a week-old notice
  -- back to the top of the list, and it must not un-read it for anybody.
  UPDATE public.announcements
     SET title = COALESCE(NULLIF(btrim(p_title), ''), title),
         body  = COALESCE(NULLIF(btrim(p_body), ''), body)
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'that announcement does not exist';
  END IF;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_delete_announcement(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  -- announcement_reads cascades, which is right: the notice is gone, so who
  -- read it is not a fact about anything any more.
  DELETE FROM public.announcements WHERE id = p_id;
  RETURN FOUND;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.get_help()',
    'public.mark_announcements_read(uuid[])',
    'public.admin_set_help_video(uuid, text, text, text, integer)',
    'public.admin_delete_help_video(uuid)',
    'public.admin_post_announcement(text, text)',
    'public.admin_edit_announcement(uuid, text, text)',
    'public.admin_delete_announcement(uuid)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.get_help() IS
  'The Help screen in one call: the videos, every announcement with whether the '
  'caller has read it, and their unread count for the sidebar dot (049).';
COMMENT ON FUNCTION public.mark_announcements_read(uuid[]) IS
  'Mark announcements read for the calling member of staff. NULL means all of '
  'them. Reading twice is not a second event (049).';
