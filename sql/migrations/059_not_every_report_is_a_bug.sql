-- ============================================================================
-- 059 — a report says which kind of report it is
--
-- 051 built one box headed "Tell us what is wrong", and that heading turned out
-- to be the whole problem: the thing staff most wanted to send was not a fault
-- at all. "It would help if the roster remembered my cohort" is not broken, so
-- the form quietly told them it did not belong, and an admin reading the queue
-- had no way to tell a fault that is costing somebody their morning from an
-- idea that can wait for the holidays.
--
-- So a report now carries its kind. Two of them, because two is what the
-- difference is:
--
--   bug   something is not working
--   idea  something could be better — a suggestion, a feature, a wish
--
-- Deliberately NOT a longer list. A third bucket ("other", "question") is the
-- one everything lands in the moment somebody is unsure, and a queue where most
-- items say "other" sorts no better than a queue with no kinds at all.
--
-- WHY 'bug' IS THE DEFAULT
--
-- Every row written before this migration came through a form headed "Tell us
-- what is wrong". Defaulting them to 'bug' is not a guess, it is what the
-- screen asked for. Defaulting to 'idea' would retitle history.
--
-- ANONYMOUS, AND WHAT THAT WORD IS PROMISED TO MEAN
--
-- 051 made feedback deliberately not anonymous, and the reason was good: an
-- admin reading "this is broken" almost always has to ask which class. That
-- reason is weaker for a suggestion, and the cost is real — the ideas people
-- keep to themselves are exactly the ones about somebody senior's screen.
--
-- So a report may be sent anonymously, and anonymous here means the row NEVER
-- CARRIES WHO SENT IT. staff_id is left null at the insert, not stored and
-- hidden from one screen: a name that is in the table is a name that a SQL
-- console, an export or a future join will eventually show, and a promise the
-- database can break is worse than no promise. The form says the same thing in
-- the same words.
--
-- Two consequences, both accepted:
--
--   nobody can come back to you about it, including to say it is fixed. The
--   form warns, and warns harder for a fault than for an idea.
--
--   you cannot read your own anonymous report back — the SELECT policy from
--   051 matches on staff_id, and there is no staff_id to match. That is what
--   not storing it costs.
--
-- Sending is still gated on an approved account, so this is anonymous, not
-- unauthenticated: the inbox does not become a spam target.
--
-- OLD CLIENTS
--
-- send_feedback and admin_list_feedback each gain one argument with a default,
-- and the old signature is dropped rather than left beside the new one — two
-- functions of the same name, one taking a subset of the other's arguments, is
-- how a call becomes ambiguous and starts failing for nobody's benefit. A
-- client that has not been reloaded still calls by name without the new
-- argument, the default fills it in, and the call goes through.
--
-- Run AFTER 058. Idempotent.
-- ============================================================================

ALTER TABLE public.feedback
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bug';

-- Kept as its own column rather than read off "staff_id IS NULL", which by 051
-- also means "the account was removed afterwards" (ON DELETE SET NULL). An
-- admin reading the queue needs those two to look different: one is a report
-- somebody chose not to sign, the other is a signed report whose author has
-- since left.
ALTER TABLE public.feedback
  ADD COLUMN IF NOT EXISTS anonymous boolean NOT NULL DEFAULT false;

-- Recreated rather than guarded, so running this after the set of kinds has
-- changed corrects the constraint instead of leaving the old one in place.
ALTER TABLE public.feedback DROP CONSTRAINT IF EXISTS feedback_kind_known;
ALTER TABLE public.feedback
  ADD CONSTRAINT feedback_kind_known CHECK (kind IN ('bug', 'idea'));

COMMENT ON COLUMN public.feedback.anonymous IS
  'Sent without a name. The row genuinely does not carry one — staff_id was '
  'never written, not written and hidden (059).';
COMMENT ON COLUMN public.feedback.kind IS
  'bug = something is not working, idea = something could be better. Rows from '
  'before 059 are bugs: that is what the form they were sent from asked for.';

-- Open faults are the thing an admin comes to this screen for, so they get the
-- index. Ideas are read a term at a time, not at eight in the morning.
CREATE INDEX IF NOT EXISTS idx_feedback_unhandled_kind
  ON public.feedback (kind, created_at DESC) WHERE NOT handled;

-- ----------------------------------------------------------------------------
-- send_feedback — now says which kind
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.send_feedback(text, text);

CREATE OR REPLACE FUNCTION public.send_feedback(
  p_body text,
  p_page text DEFAULT NULL,
  p_kind text DEFAULT 'bug',
  p_anonymous boolean DEFAULT false
)
RETURNS public.feedback
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff public.staff%ROWTYPE;
  v_body  text := btrim(COALESCE(p_body, ''));
  v_kind  text := lower(btrim(COALESCE(p_kind, 'bug')));
  v_anon  boolean := COALESCE(p_anonymous, false);
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

  -- An empty string arrives from a form field that was never filled in, and
  -- that is a bug report by default, not a refusal.
  IF v_kind = '' THEN
    v_kind := 'bug';
  END IF;

  IF v_kind NOT IN ('bug', 'idea') THEN
    RAISE EXCEPTION 'a report is either a bug or an idea, not %', v_kind;
  END IF;

  -- The account was found and checked above; it is simply not written down.
  -- Anonymous means the row has no author, not that the sender was not one.
  INSERT INTO public.feedback (staff_id, body, page, kind, anonymous)
  VALUES (CASE WHEN v_anon THEN NULL ELSE v_staff.id END,
          v_body, NULLIF(btrim(COALESCE(p_page, '')), ''), v_kind, v_anon)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- admin_list_feedback — returns the kind, and can be asked for one of them
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.admin_list_feedback(boolean);

CREATE OR REPLACE FUNCTION public.admin_list_feedback(
  p_handled boolean DEFAULT NULL,
  p_kind    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows jsonb;
  v_kind text := NULLIF(lower(btrim(COALESCE(p_kind, ''))), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  -- An unknown kind returns nothing rather than everything. A filter that
  -- silently stops filtering is how somebody concludes there are no open bugs.
  IF v_kind IS NOT NULL AND v_kind NOT IN ('bug', 'idea') THEN
    RAISE EXCEPTION 'there is no such kind of report: %', v_kind;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',         f.id,
           'body',       f.body,
           'page',       f.page,
           'kind',       f.kind,
           'anonymous',  f.anonymous,
           'handled',    f.handled,
           'handled_at', f.handled_at,
           'created_at', f.created_at,
           -- Null when the account has gone (050) AND when nobody signed it
           -- (059) — which is why 'anonymous' is sent alongside, so the screen
           -- can tell "they chose not to say" from "they have left".
           'from_email', s.email,
           'from_name',  s.display_name)
         -- Unhandled first, then faults before wishes: both halves of "what
         -- should I look at next" in one order.
         ORDER BY f.handled, (f.kind <> 'bug'), f.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.feedback f
  LEFT JOIN public.staff s ON s.id = f.staff_id
  WHERE (p_handled IS NULL OR f.handled = p_handled)
    AND (v_kind IS NULL OR f.kind = v_kind);

  RETURN v_rows;
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.send_feedback(text, text, text, boolean)',
    'public.admin_list_feedback(boolean, text)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.send_feedback(text, text, text, boolean) IS
  'File a report from inside the app — a bug or an idea, signed or anonymous. '
  'Approved staff only; anonymous rows never carry a staff_id (051, 059).';
COMMENT ON FUNCTION public.admin_list_feedback(boolean, text) IS
  'Every report, open first and faults before wishes, with who sent it where '
  'the account still exists (051, 059).';
