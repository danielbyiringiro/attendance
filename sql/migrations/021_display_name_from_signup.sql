-- ============================================================================
-- 021 — keep the name somebody typed when they asked for an account
--
-- The signup form asks for a name, saying "So the admin knows who is asking",
-- and then loses it. 020's ensure_staff only ever saw a name if the client
-- passed one, and the client calls ensureStaff() with no argument — so every
-- account created since 020 has a null display_name and the approval queue is
-- a list of bare email addresses.
--
-- Passing it from the client would not be enough. With email confirmation on,
-- signUp() returns no session: nothing runs, no staff row exists yet, and the
-- person comes back hours later through a link in their inbox, in a browser
-- that never saw the form. The typed name is gone from memory by then.
--
-- It is not gone from the database. supabase.auth.signUp() puts options.data
-- into auth.users.raw_user_meta_data, which is durable and is still there
-- whenever ensure_staff finally runs. So the fallback belongs here, on the
-- server, where it works in both configurations.
--
-- An explicitly passed p_display_name still wins — somebody editing their own
-- name later must not be overwritten by what they typed at signup.
--
-- Run AFTER 020. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Where a name might be hiding
--
-- display_name is what this app's signup form sends. full_name and name are
-- what OAuth providers use, so an account created any other way still gets a
-- name instead of a blank row. COALESCE order is deliberate: this app's own
-- field first.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.signup_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT NULLIF(btrim(COALESCE(
           u.raw_user_meta_data ->> 'display_name',
           u.raw_user_meta_data ->> 'full_name',
           u.raw_user_meta_data ->> 'name',
           '')), '')
  FROM auth.users u
  WHERE u.id = p_user_id;
$fn$;

COMMENT ON FUNCTION public.signup_display_name(uuid) IS
  'The name given to supabase.auth.signUp() in options.data, if any. Reads '
  'auth.users.raw_user_meta_data, which survives the email-confirmation round '
  'trip that loses the browser''s copy.';

REVOKE ALL ON FUNCTION public.signup_display_name(uuid) FROM public;

-- ----------------------------------------------------------------------------
-- ensure_staff, with the fallback
--
-- Otherwise unchanged from 020: same signature, same approval gate, same
-- refusal for an address outside the allowed domains, same rule that an
-- existing account keeps whatever status it already has.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_staff(p_display_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_email  text;
  v_name   text;
  v_domain text;
  v_staff  public.staff%ROWTYPE;
  v_open   boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  -- What the caller passed, else what was typed at signup. Never the empty
  -- string: a blank name column is easier to reason about than one holding ''.
  v_name := COALESCE(
    NULLIF(btrim(COALESCE(p_display_name, '')), ''),
    public.signup_display_name(v_uid));

  SELECT * INTO v_staff FROM public.staff WHERE user_id = v_uid;

  -- An existing account keeps whatever status it has: a domain removed from
  -- the list later must not silently revoke somebody already approved.
  IF FOUND THEN
    UPDATE public.staff
       SET email        = COALESCE(v_email, email),
           display_name = COALESCE(display_name, v_name),
           updated_at   = now()
     WHERE id = v_staff.id
    RETURNING * INTO v_staff;
  ELSE
    v_domain := lower(split_part(COALESCE(v_email, ''), '@', 2));

    SELECT EXISTS (
      SELECT 1 FROM public.allowed_email_domains d WHERE d.domain = v_domain
    ) INTO v_open;

    IF NOT v_open THEN
      RETURN jsonb_build_object(
        'staff_id', NULL,
        'email',    v_email,
        'status',   'domain_not_allowed',
        'is_admin', false);
    END IF;

    INSERT INTO public.staff (user_id, email, display_name, status)
    VALUES (v_uid, v_email, v_name, 'pending')
    RETURNING * INTO v_staff;
  END IF;

  RETURN jsonb_build_object(
    'staff_id',      v_staff.id,
    'email',         v_staff.email,
    'display_name',  v_staff.display_name,
    'status',        v_staff.status,
    'is_admin',      v_staff.is_admin,
    'decision_note', v_staff.decision_note);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ensure_staff(text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_staff(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Fill in the accounts that already lost their name
--
-- Anyone who signed up between 020 and this migration. Only fills nulls — an
-- admin who has since typed a name for somebody keeps it.
-- ----------------------------------------------------------------------------

UPDATE public.staff s
   SET display_name = public.signup_display_name(s.user_id)
 WHERE s.display_name IS NULL
   AND public.signup_display_name(s.user_id) IS NOT NULL;
