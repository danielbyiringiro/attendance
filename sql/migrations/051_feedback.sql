-- ============================================================================
-- 051 — staff can say what is wrong, where the work happens
--
-- 049 gave admins a way to tell staff things. This is the other direction, and
-- it was missing entirely: somebody using the app every day had nowhere to put
-- "the weekly pattern editor confuses me" except a corridor conversation.
--
-- WHY IN THE APP RATHER THAN A LINK
--
-- A link to a form elsewhere was the cheaper option and was rejected. A link
-- set up once rots quietly — the form's owner graduates, the sheet is moved,
-- the address stops working — and nothing in the app knows, so feedback simply
-- stops arriving and nobody notices it stopped. Stored feedback cannot rot like
-- that, and it lands on the same Admin screen where accounts and classes are
-- already handled.
--
-- WHO
--
-- Staff only, and it carries who sent it. Not anonymous: an admin reading "this
-- is broken" almost always needs to ask which class, and an anonymous note
-- makes that impossible. Deliberate, and the form says so.
--
-- Students have no account and no route here; their surface is an ID and a PIN.
--
-- WHAT HAPPENS TO IT
--
-- An admin marks it handled — not deletes it. Handled is the normal end state,
-- so a list that has been dealt with does not vanish and the same report does
-- not arrive twice unrecognised. Delete exists for genuine rubbish.
--
-- Feedback outlives its author by ON DELETE SET NULL, the way announcements do
-- (049): removing an account under 050 must not silently destroy a report that
-- is still worth acting on.
--
-- Run AFTER 050. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id   uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  body       text NOT NULL,
  /* Which screen they were on, when the form knows. Never required. */
  page       text,
  handled    boolean NOT NULL DEFAULT false,
  handled_by uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  handled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feedback_body_present CHECK (btrim(body) <> ''),
  -- Long enough for a real report, short enough that nobody pastes a log file
  -- into it and expects somebody to read the whole thing.
  CONSTRAINT feedback_body_sane CHECK (length(body) <= 4000)
);

CREATE INDEX IF NOT EXISTS idx_feedback_unhandled
  ON public.feedback (created_at DESC) WHERE NOT handled;
CREATE INDEX IF NOT EXISTS idx_feedback_staff
  ON public.feedback (staff_id);

COMMENT ON TABLE public.feedback IS
  'What staff report from inside the app. Not anonymous — an admin usually has '
  'to ask which class. Survives its author by SET NULL (051).';

-- ----------------------------------------------------------------------------
-- Grants and RLS
--
-- You may send feedback and read your own back. Admins read everything and are
-- the only ones who may mark it handled or remove it.
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT ON public.feedback TO authenticated;

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_own_or_admin ON public.feedback;
DROP POLICY IF EXISTS feedback_insert_self  ON public.feedback;
DROP POLICY IF EXISTS feedback_admin_writes ON public.feedback;

CREATE POLICY feedback_own_or_admin ON public.feedback
  FOR SELECT TO authenticated
  USING (staff_id = public.current_staff_id() OR public.is_admin());

-- Only ever as yourself. Without the WITH CHECK, one member of staff could file
-- a complaint under somebody else's name.
CREATE POLICY feedback_insert_self ON public.feedback
  FOR INSERT TO authenticated
  WITH CHECK (staff_id = public.current_staff_id());

CREATE POLICY feedback_admin_writes ON public.feedback
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ----------------------------------------------------------------------------
-- send_feedback
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_feedback(
  p_body text,
  p_page text DEFAULT NULL
)
RETURNS public.feedback
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff public.staff%ROWTYPE;
  v_body  text := btrim(COALESCE(p_body, ''));
  v_row   public.feedback%ROWTYPE;
BEGIN
  -- By user_id, NOT through current_staff_id(): 020 redefined that to return
  -- only APPROVED accounts, so looking the row up with it means a pending
  -- account falls into "no account" and the status check below never runs.
  -- The refusal would be right and the reason given would be a lie — somebody
  -- waiting for approval would be told they have no account at all.
  SELECT * INTO v_staff FROM public.staff WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'you need an account to send feedback';
  END IF;

  -- Pending and rejected accounts cannot: the queue is for accounts waiting to
  -- be let in, and an inbox anybody signed in can write to is a spam target.
  IF v_staff.status <> 'approved' THEN
    RAISE EXCEPTION 'your account is not approved yet';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'say what is wrong — an empty report cannot be acted on';
  END IF;

  IF length(v_body) > 4000 THEN
    RAISE EXCEPTION 'that is longer than 4000 characters; send the short version';
  END IF;

  INSERT INTO public.feedback (staff_id, body, page)
  VALUES (v_staff.id, v_body, NULLIF(btrim(COALESCE(p_page, '')), ''))
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- admin_list_feedback — with the sender resolved, because a report without a
-- name is one an admin cannot follow up.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_feedback(
  p_handled boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_rows jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',         f.id,
           'body',       f.body,
           'page',       f.page,
           'handled',    f.handled,
           'handled_at', f.handled_at,
           'created_at', f.created_at,
           -- Null once the account has gone (050). The report stays useful.
           'from_email', s.email,
           'from_name',  s.display_name)
         -- Unhandled first: that is the reason to open this.
         ORDER BY f.handled, f.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.feedback f
  LEFT JOIN public.staff s ON s.id = f.staff_id
  WHERE p_handled IS NULL OR f.handled = p_handled;

  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_feedback_handled(
  p_id      uuid,
  p_handled boolean DEFAULT true
)
RETURNS public.feedback
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_row public.feedback%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  UPDATE public.feedback
     SET handled    = p_handled,
         handled_by = CASE WHEN p_handled THEN public.current_staff_id() END,
         handled_at = CASE WHEN p_handled THEN now() END
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such feedback';
  END IF;

  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_delete_feedback(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  DELETE FROM public.feedback WHERE id = p_id;
  RETURN FOUND;
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.send_feedback(text, text)',
    'public.admin_list_feedback(boolean)',
    'public.admin_set_feedback_handled(uuid, boolean)',
    'public.admin_delete_feedback(uuid)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.send_feedback(text, text) IS
  'File a report from inside the app. Approved staff only, always as yourself '
  '(051).';
COMMENT ON FUNCTION public.admin_list_feedback(boolean) IS
  'Every report, unhandled first, with who sent it where the account still '
  'exists (051).';
