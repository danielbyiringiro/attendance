-- ============================================================================
-- 061 — an announcement that asks to be read
--
-- 049 put announcements under Help with an unread dot, and said out loud that
-- "an announcement nobody notices is a changelog". The dot turns out to be
-- exactly that: somebody who never opens Help never sees it, and the things
-- worth announcing — the app will be down on Saturday, check-in closes when
-- class starts now — are the ones people need to have been told, not the ones
-- they could have found.
--
-- So an announcement can insist. It appears as a modal, and if it is not
-- acknowledged it comes back — but no more than once in a set period, because
-- a notice that appears on every page load is one people learn to dismiss
-- without reading, which is worse than the dot.
--
-- WHO SETS THE PERIOD
--
-- The admin who posts it, per announcement, in hours. Null means "do not
-- insist", which is what every announcement posted before this migration gets:
-- 049's announcements stay exactly as they are, in the list with a dot, and
-- nothing that has already been posted starts interrupting people because this
-- ran.
--
-- WHY NOT A COLUMN ON announcement_reads
--
-- Because in 049 the EXISTENCE of a row there means "this person has read
-- this", and get_help's unread count is a NOT EXISTS against it. A row written
-- to record "we showed them the modal and they said later" would be read as
-- "they have read it", silently clearing the dot for everybody who dismissed
-- one. Being shown something and having read it are different facts and they
-- get different tables.
--
-- Run AFTER 060. Idempotent.
-- ============================================================================

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS remind_every_hours integer;

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_reminder_sane;
ALTER TABLE public.announcements
  ADD CONSTRAINT announcements_reminder_sane
  CHECK (remind_every_hours IS NULL OR remind_every_hours BETWEEN 1 AND 8760);

COMMENT ON COLUMN public.announcements.remind_every_hours IS
  'How long to leave somebody alone between showing them this as a modal. '
  'Null — the default, and what every announcement from before 061 keeps — '
  'means it never interrupts anybody (061).';

-- One row per person per announcement, written when they are SHOWN it. Kept
-- apart from announcement_reads on purpose: see the header.
CREATE TABLE IF NOT EXISTS public.announcement_prompts (
  announcement_id uuid NOT NULL
    REFERENCES public.announcements(id) ON DELETE CASCADE,
  staff_id        uuid NOT NULL
    REFERENCES public.staff(id) ON DELETE CASCADE,
  last_shown_at   timestamptz NOT NULL DEFAULT now(),
  /* How many times they have been shown it and not acknowledged. An admin
     reading "shown six times, still unread" learns something the dot cannot
     tell them. */
  times_shown     integer NOT NULL DEFAULT 1,

  PRIMARY KEY (announcement_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_prompts_staff
  ON public.announcement_prompts (staff_id);

COMMENT ON TABLE public.announcement_prompts IS
  'When somebody was last shown an announcement as a modal. Being shown a '
  'thing is not the same as having read it — that is announcement_reads (061).';

GRANT SELECT, INSERT, UPDATE ON public.announcement_prompts TO authenticated;

ALTER TABLE public.announcement_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS announcement_prompts_own ON public.announcement_prompts;

-- Your own row, and only ever your own: when somebody else last saw a notice
-- is not a thing a colleague has any business reading or writing.
CREATE POLICY announcement_prompts_own ON public.announcement_prompts
  FOR ALL TO authenticated
  USING (staff_id = public.current_staff_id())
  WITH CHECK (staff_id = public.current_staff_id());

-- ----------------------------------------------------------------------------
-- due_announcements — what this person should be shown right now
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.due_announcements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff uuid := public.current_staff_id();
  v_rows  jsonb;
BEGIN
  -- Not an error: 020 means a pending account has no staff id, and somebody
  -- waiting to be approved has nothing to be told yet.
  IF v_staff IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',        a.id,
           'title',     a.title,
           'body',      a.body,
           'posted_at', a.posted_at)
         -- Newest first: if several are due at once, the one that matters most
         -- is almost always the one posted last.
         ORDER BY a.posted_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.announcements a
  LEFT JOIN public.announcement_prompts p
    ON p.announcement_id = a.id AND p.staff_id = v_staff
  WHERE a.remind_every_hours IS NOT NULL
    -- Read is read. Acknowledging it is what stops it coming back.
    AND NOT EXISTS (
      SELECT 1 FROM public.announcement_reads r
      WHERE r.announcement_id = a.id AND r.staff_id = v_staff)
    AND (
      p.last_shown_at IS NULL
      OR p.last_shown_at < now() - make_interval(hours => a.remind_every_hours)
    );

  RETURN v_rows;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- note_announcements_shown — "they have been shown it; leave them alone now"
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.note_announcements_shown(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff uuid := public.current_staff_id();
  v_count integer := 0;
BEGIN
  IF v_staff IS NULL OR p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH noted AS (
    INSERT INTO public.announcement_prompts (announcement_id, staff_id)
    SELECT a.id, v_staff
      FROM public.announcements a
     WHERE a.id = ANY(p_ids)
    ON CONFLICT (announcement_id, staff_id) DO UPDATE
      SET last_shown_at = now(),
          times_shown   = announcement_prompts.times_shown + 1
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM noted;

  RETURN v_count;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- get_help carries the period too
--
-- Same shape as 049, one key added. The admin screen edits announcements from
-- this list, and a form that cannot see the current value would reset every
-- reminder to "never" the first time somebody fixed a typo.
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
                 -- 061. Null when it never interrupts anybody.
                 'remind_every_hours', a.remind_every_hours,
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
-- Posting and editing carry the period
--
-- Both gain an argument with a default and the old signatures are dropped
-- rather than left beside the new ones, for the reason 059 spelled out: two
-- functions of a name, one taking a subset of the other's arguments, is how a
-- call becomes ambiguous. A client that has not been reloaded still posts
-- announcements that never interrupt anybody, which is the old behaviour.
--
-- The edit takes a separate "am I changing this" flag rather than reading NULL
-- as "leave it alone", because NULL is a meaningful value here — it is how an
-- announcement stops insisting. Without the flag there would be no way to turn
-- one off again.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.admin_post_announcement(text, text);

CREATE OR REPLACE FUNCTION public.admin_post_announcement(
  p_title text,
  p_body  text,
  p_remind_every_hours integer DEFAULT NULL
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

  IF p_remind_every_hours IS NOT NULL
     AND (p_remind_every_hours < 1 OR p_remind_every_hours > 8760) THEN
    RAISE EXCEPTION 'remind between 1 hour and a year, or not at all';
  END IF;

  INSERT INTO public.announcements (title, body, posted_by, remind_every_hours)
  VALUES (v_title, v_body, public.current_staff_id(), p_remind_every_hours)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

DROP FUNCTION IF EXISTS public.admin_edit_announcement(uuid, text, text);

CREATE OR REPLACE FUNCTION public.admin_edit_announcement(
  p_id    uuid,
  p_title text DEFAULT NULL,
  p_body  text DEFAULT NULL,
  p_remind_every_hours integer DEFAULT NULL,
  p_change_reminder    boolean DEFAULT false
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

  IF p_change_reminder AND p_remind_every_hours IS NOT NULL
     AND (p_remind_every_hours < 1 OR p_remind_every_hours > 8760) THEN
    RAISE EXCEPTION 'remind between 1 hour and a year, or not at all';
  END IF;

  -- posted_at is NOT touched: fixing a typo should not push a week-old notice
  -- back to the top of the list, and it must not un-read it for anybody.
  UPDATE public.announcements
     SET title = COALESCE(NULLIF(btrim(p_title), ''), title),
         body  = COALESCE(NULLIF(btrim(p_body), ''), body),
         remind_every_hours = CASE
           WHEN p_change_reminder THEN p_remind_every_hours
           ELSE remind_every_hours
         END
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'that announcement does not exist';
  END IF;

  RETURN v_row;
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.due_announcements()',
    'public.note_announcements_shown(uuid[])',
    'public.admin_post_announcement(text, text, integer)',
    'public.admin_edit_announcement(uuid, text, text, integer, boolean)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.due_announcements() IS
  'Announcements this person should be shown as a modal now: insisting, '
  'unread, and not shown again inside their own period (061).';
COMMENT ON FUNCTION public.note_announcements_shown(uuid[]) IS
  'Records that these were put in front of this person, which starts their '
  'period running again (061).';
