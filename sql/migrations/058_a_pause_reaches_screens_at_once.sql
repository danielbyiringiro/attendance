-- ============================================================================
-- 058 — a pause reaches open screens at once
--
-- Pausing left every dashboard looking normal until it next asked, which was
-- up to a minute later, or until somebody reloaded. The database refused
-- writes the whole time, so nothing was recorded that should not have been —
-- but a screen that still offers its buttons is a screen that is lying, and
-- the person pressing them learns it one failed action at a time.
--
-- The app already streams two tables to open dashboards (030). This adds the
-- switch to the same stream, so a pause lands on every signed-in screen the
-- moment it is set.
--
-- WHY STAFF AND NOT STUDENTS
--
-- Streaming a table means letting the client read it, and 027 holds that no
-- table in public is readable by an anonymous visitor. A student's page keeps
-- asking on a timer instead — and it asks again the moment the tab is looked
-- at, which covers the case that matters: a phone in a pocket during the
-- pause, opened at the door.
--
-- The only thing this exposes to a signed-in TA is what the app already shows
-- them: whether it is paused, the message, and the times. They see all of it
-- in the banner a second later anyway.
--
-- Run AFTER 057. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Signed-in staff may read the switch
--
-- 055 gave this table RLS with no policy at all, so only its functions could
-- reach it, and 055's own test asserted that a TA reading the table directly
-- got nothing. That assertion is reversed here on purpose: a stream is a read,
-- and there is no way to have one without the other. Anon is still given
-- nothing, which is the rule 027 actually enforces.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS service_state_read ON public.service_state;
CREATE POLICY service_state_read ON public.service_state
  FOR SELECT TO authenticated
  USING (true);

-- Writes stay with admin_set_service_paused, which is SECURITY DEFINER and
-- checks is_admin(). No policy grants INSERT, UPDATE or DELETE to anybody.

-- ----------------------------------------------------------------------------
-- Stream it
--
-- Guarded the way 030 guards its own: a database without the publication is a
-- bare Postgres one (the test harness), where the rest of this migration still
-- has to apply cleanly.
-- ----------------------------------------------------------------------------
DO $stream$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'service_state'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.service_state;
      RAISE NOTICE '058: service_state added to the realtime publication';
    END IF;
  ELSE
    RAISE NOTICE
      '058: no supabase_realtime publication here — screens fall back to '
      'asking on a timer, which is what a student page does anyway';
  END IF;
END;
$stream$;

-- Realtime sends the whole row to a client that may read it, so the row must
-- not carry anything staff should not see. It carries the pause, its message,
-- its times, who set it and when — all of which the banner shows them.
COMMENT ON TABLE public.service_state IS
  'One row. While paused is true, every table carrying the term''s record '
  'refuses writes. Readable by signed-in staff so a pause can be streamed to '
  'open dashboards (058); writable only through admin_set_service_paused.';
