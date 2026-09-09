-- ============================================================================
-- Migration 021 — the name typed at signup reaches the approval queue
--
-- The defect this guards against is quiet: nothing errors, the account works,
-- and the admin simply sees a list of email addresses with no names against
-- them. So the assertion that matters is the last one — that admin_list_staff
-- actually carries the name — and the rest establish the rules it depends on.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $seed$
BEGIN
  INSERT INTO public.allowed_email_domains (domain) VALUES ('example.edu')
  ON CONFLICT (domain) DO NOTHING;

  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    -- Signed up through this app's form: display_name is what TALogin sends.
    ('d0000000-0000-0000-0000-00000000000d', 'named-022@example.edu',
     '{"display_name": "  Ama Mensah  "}'::jsonb),
    -- Nothing usable in the metadata at all.
    ('e0000000-0000-0000-0000-00000000000e', 'blank-022@example.edu',
     '{}'::jsonb),
    -- An OAuth provider's shape rather than this app's.
    ('f0000000-0000-0000-0000-00000000000f', 'oauth-022@example.edu',
     '{"full_name": "Kwame Boateng"}'::jsonb),
    -- Already has a staff row, with a name somebody set deliberately.
    ('a1000000-0000-0000-0000-00000000000a', 'settled-022@example.edu',
     '{"display_name": "From Metadata"}'::jsonb),
    -- Already has a staff row, created before 021, so its name was lost.
    ('a2000000-0000-0000-0000-00000000000b', 'lost-022@example.edu',
     '{"display_name": "Recovered Name"}'::jsonb),
    ('a3000000-0000-0000-0000-00000000000c', 'admin-022@example.edu',
     '{"display_name": "The Admin"}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
    ('a1000000-0000-0000-0000-00000000000a', 'settled-022@example.edu',
     'Chosen By Hand', 'approved', false),
    ('a2000000-0000-0000-0000-00000000000b', 'lost-022@example.edu',
     NULL, 'pending', false),
    ('a3000000-0000-0000-0000-00000000000c', 'admin-022@example.edu',
     'The Admin', 'approved', true)
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

-- ----------------------------------------------------------------------------
-- A new account keeps the name that was typed
-- ----------------------------------------------------------------------------

SET ROLE authenticated;
SET request.jwt.claim.sub = 'd0000000-0000-0000-0000-00000000000d';

DO $typed$
DECLARE r jsonb;
BEGIN
  -- No argument, exactly as Index.tsx calls it.
  r := public.ensure_staff();

  IF r ->> 'display_name' IS DISTINCT FROM 'Ama Mensah' THEN
    RAISE EXCEPTION
      'the name typed at signup did not reach the staff row: %', r;
  END IF;

  IF r ->> 'status' <> 'pending' THEN
    RAISE EXCEPTION 'reading the name changed the approval gate: %', r;
  END IF;
END
$typed$;

-- ----------------------------------------------------------------------------
-- No name anywhere is null, not the empty string
--
-- '' would sort, render and compare as a name that is merely invisible, which
-- is worse to debug than an honest NULL.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'e0000000-0000-0000-0000-00000000000e';

DO $blank$
DECLARE r jsonb;
BEGIN
  r := public.ensure_staff();

  IF r ->> 'display_name' IS NOT NULL THEN
    RAISE EXCEPTION
      'an account with no name in its metadata got %, expected null',
      r ->> 'display_name';
  END IF;

  IF (r ->> 'staff_id') IS NULL THEN
    RAISE EXCEPTION 'having no name stopped the account being created: %', r;
  END IF;
END
$blank$;

-- ----------------------------------------------------------------------------
-- An OAuth-shaped metadata still yields a name
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'f0000000-0000-0000-0000-00000000000f';

DO $oauth$
DECLARE r jsonb;
BEGIN
  r := public.ensure_staff();

  IF r ->> 'display_name' IS DISTINCT FROM 'Kwame Boateng' THEN
    RAISE EXCEPTION 'full_name was not used as a fallback: %', r;
  END IF;
END
$oauth$;

-- ----------------------------------------------------------------------------
-- An explicit argument beats the metadata
--
-- Otherwise a later rename would be undone on the next page load, silently,
-- by a value the person typed once months earlier.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a1000000-0000-0000-0000-00000000000a';

DO $settled$
DECLARE r jsonb;
BEGIN
  r := public.ensure_staff();

  IF r ->> 'display_name' IS DISTINCT FROM 'Chosen By Hand' THEN
    RAISE EXCEPTION
      'a name already on the row was overwritten from metadata: %', r;
  END IF;
END
$settled$;

-- ----------------------------------------------------------------------------
-- An account that already lost its name gets it back on the next load
--
-- This is the recovery path for everyone who signed up between 020 and 021,
-- and the same rule the migration's backfill applies in bulk.
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a2000000-0000-0000-0000-00000000000b';

DO $recover$
DECLARE r jsonb;
BEGIN
  r := public.ensure_staff();

  IF r ->> 'display_name' IS DISTINCT FROM 'Recovered Name' THEN
    RAISE EXCEPTION
      'an existing row with a null name was not filled in: %', r;
  END IF;

  IF r ->> 'status' <> 'pending' THEN
    RAISE EXCEPTION 'filling in a name changed the account''s status: %', r;
  END IF;
END
$recover$;

-- ----------------------------------------------------------------------------
-- THE POINT: the admin's approval queue shows names, not bare addresses
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = 'a3000000-0000-0000-0000-00000000000c';

DO $queue$
DECLARE
  v_pending jsonb := public.admin_list_staff('pending');
  v_name    text;
BEGIN
  SELECT row ->> 'display_name' INTO v_name
  FROM jsonb_array_elements(v_pending) AS row
  WHERE row ->> 'email' = 'named-022@example.edu';

  IF v_name IS DISTINCT FROM 'Ama Mensah' THEN
    RAISE EXCEPTION
      'the approval queue shows no name for a person who typed one: %',
      v_pending;
  END IF;
END
$queue$;

DO $done$ BEGIN RAISE NOTICE '022 signup display-name assertions passed'; END $done$;

ROLLBACK;
