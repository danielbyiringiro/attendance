-- ============================================================================
-- Migration 022 — a disallowed address never becomes an account
--
-- The rule this pins down is narrow: no auth.users row, therefore no
-- confirmation email. Access was already refused by 020; what is new is that
-- the refusal happens before Supabase spends anything on it.
--
-- The fail-open case matters as much as the refusal. A trigger that rejects
-- every signup when the domain list is empty would be unrecoverable — there
-- would be no way to create the account that could add a domain back.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
ON CONFLICT (domain) DO NOTHING;

-- ----------------------------------------------------------------------------
-- An allowed domain is untouched
-- ----------------------------------------------------------------------------

DO $allowed$
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES ('b0230000-0000-0000-0000-00000000000a', 'fine-023@example.edu');

  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'fine-023@example.edu'
  ) THEN
    RAISE EXCEPTION 'an allowed address was not created';
  END IF;
END
$allowed$;

-- ----------------------------------------------------------------------------
-- A disallowed one is refused, and leaves nothing behind
-- ----------------------------------------------------------------------------

DO $refused$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email)
    VALUES ('b0230000-0000-0000-0000-00000000000b', 'nope-023@elsewhere.com');
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION
      'an address outside the allowed domains created an auth account — '
      'Supabase would have emailed it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'nope-023@elsewhere.com'
  ) THEN
    RAISE EXCEPTION 'the refused signup left a row behind';
  END IF;
END
$refused$;

-- ----------------------------------------------------------------------------
-- Case and whitespace do not get somebody in
-- ----------------------------------------------------------------------------

DO $case$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email)
    VALUES ('b0230000-0000-0000-0000-00000000000c', 'Nope-023@ELSEWHERE.com');
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'an uppercase disallowed domain was let through';
  END IF;
END
$case$;

-- ----------------------------------------------------------------------------
-- An address that is already allowed in a different case still works
-- ----------------------------------------------------------------------------

DO $upper_ok$
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES ('b0230000-0000-0000-0000-00000000000d', 'Mixed-023@Example.Edu');

  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'Mixed-023@Example.Edu'
  ) THEN
    RAISE EXCEPTION 'an allowed domain in mixed case was refused';
  END IF;
END
$upper_ok$;

-- ----------------------------------------------------------------------------
-- No email address at all is none of this trigger's business
--
-- Phone signups and anonymous sessions must keep working.
-- ----------------------------------------------------------------------------

DO $no_email$
BEGIN
  INSERT INTO auth.users (id, email)
  VALUES ('b0230000-0000-0000-0000-00000000000e', NULL);
END
$no_email$;

-- ----------------------------------------------------------------------------
-- THE RECOVERY CASE: an empty domain list fails open
--
-- Otherwise an admin who removes the last domain can never create the account
-- that would add one back, and the installation is bricked.
-- ----------------------------------------------------------------------------

DO $fail_open$
DECLARE n bigint;
BEGIN
  DELETE FROM public.allowed_email_domains;

  INSERT INTO auth.users (id, email)
  VALUES ('b0230000-0000-0000-0000-00000000000f', 'rescue-023@anywhere.org');

  SELECT count(*) INTO n
  FROM auth.users WHERE email = 'rescue-023@anywhere.org';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'with no domains configured the gate still refused a signup — an '
      'installation in this state could never create another account';
  END IF;
END
$fail_open$;

-- ----------------------------------------------------------------------------
-- Existing accounts are never re-checked
--
-- Which is why the bootstrap admin's address does not have to be in the list,
-- and why removing a domain does not evict the people already using it.
-- ----------------------------------------------------------------------------

DO $existing$
BEGIN
  INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
  ON CONFLICT (domain) DO NOTHING;

  UPDATE auth.users
     SET email = 'renamed-023@elsewhere.com'
   WHERE id = 'b0230000-0000-0000-0000-00000000000a';

  IF NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email = 'renamed-023@elsewhere.com'
  ) THEN
    RAISE EXCEPTION 'the gate fired on an update, not just an insert';
  END IF;
END
$existing$;

DO $done$ BEGIN RAISE NOTICE '023 signup domain-gate assertions passed'; END $done$;

ROLLBACK;
