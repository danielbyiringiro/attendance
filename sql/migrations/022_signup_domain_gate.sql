-- ============================================================================
-- 022 — refuse a disallowed domain at signup, not afterwards
--
-- 020 checks the domain in ensure_staff, which runs only once somebody is
-- already signed in. By then Supabase Auth has created the auth.users row and
-- emailed a confirmation to an address this installation never wanted to hear
-- from. The person is correctly refused — they get no staff row and see "That
-- email is not accepted here" — so this is not a security fix. It is a fix for
-- two practical problems: auth.users fills with accounts that can never do
-- anything, and every one of them spends a message from a mail quota that is
-- small on Supabase's built-in sender.
--
-- The check in TALogin only disables a button. Anyone can POST the signup
-- endpoint directly, so the rule has to live where GoTrue cannot go round it.
--
-- WHY A TRIGGER ON auth.users
--
-- That schema belongs to Supabase and is normally left alone. A BEFORE INSERT
-- trigger is the one supported exception — it is the same mechanism as the
-- handle_new_user pattern in Supabase's own docs. GoTrue surfaces the raised
-- exception as a failed signup, so no row and no email.
--
-- The cost is honesty about the error text: GoTrue reports a database failure
-- rather than the message below, so somebody bypassing the form sees something
-- unhelpful. That is the right way round. People using the form get TALogin's
-- clear refusal before they ever submit.
--
-- TO TURN IT OFF, if a GoTrue upgrade ever quarrels with it:
--   DROP TRIGGER IF EXISTS trg_signup_domain_gate ON auth.users;
-- Nothing else depends on it; 020's check in ensure_staff still stands and is
-- the one that actually decides access.
--
-- Run AFTER 021. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refuse_disallowed_signup_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_domain text := lower(split_part(COALESCE(NEW.email, ''), '@', 2));
BEGIN
  -- An empty list means the restriction is not in use. Fail open deliberately:
  -- an admin who removes the last domain has locked the door on a building
  -- they are still inside, and a trigger that refuses every signup including
  -- the one that would create the next admin is not recoverable from the UI.
  IF NOT EXISTS (SELECT 1 FROM public.allowed_email_domains) THEN
    RETURN NEW;
  END IF;

  -- No address at all: phone signups, anonymous sessions, and whatever
  -- Supabase adds later. Not this trigger's business.
  IF v_domain = '' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.allowed_email_domains d WHERE d.domain = v_domain
  ) THEN
    RAISE EXCEPTION 'email domain % is not accepted here', v_domain
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.refuse_disallowed_signup_domain() IS
  'BEFORE INSERT on auth.users: refuses an address outside '
  'allowed_email_domains so no account and no confirmation email is created '
  'for one. Fails open when the domain list is empty.';

REVOKE ALL ON FUNCTION public.refuse_disallowed_signup_domain() FROM public;

-- INSERT only. An existing account is never re-checked, so removing a domain
-- later does not lock out the people already using it — the same rule 020
-- applies in ensure_staff, and the reason the bootstrap admin's address does
-- not have to be in the list.
DROP TRIGGER IF EXISTS trg_signup_domain_gate ON auth.users;
CREATE TRIGGER trg_signup_domain_gate
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.refuse_disallowed_signup_domain();

-- ----------------------------------------------------------------------------
-- Adding somebody from outside, on purpose
--
-- There is no exemption for service_role: the dashboard's "Add user" goes
-- through GoTrue like everything else, so it is refused too. The escape hatch
-- is to widen the list, create the account, then narrow it again —
--
--   SELECT public.admin_set_domain('gmail.com', true);
--   -- create the account
--   SELECT public.admin_set_domain('gmail.com', false);
--
-- which works because neither this trigger nor ensure_staff re-checks an
-- account that already exists.
-- ----------------------------------------------------------------------------
