-- ============================================================================
-- 008 — a class belongs to the people on it, and nobody else
--
-- 003 shipped two escape hatches that were right for installing the machinery
-- and wrong to keep:
--
--   * is_admin() let an account see every class in the database.
--   * Every existing account was bootstrapped as an admin, so applying 003
--     changed nobody's access. That was the point — it made 003 safe to paste —
--     but it means nothing is actually scoped yet.
--
-- After this, one rule: you see a class if you are on it. No admin bypass, and
-- no roles. A person managing their classes is the whole model; owner /
-- supervisor / ta drew a distinction nobody asked for.
--
-- ORDER MATTERS IN THIS FILE. Existing accounts are attached to the classes
-- they have been working on BEFORE the bypass is removed. Reversing those two
-- steps locks everyone out of the backfilled class, which has no members at all
-- — migration 005 ran as postgres in the SQL editor with no JWT, so the
-- ownership trigger had no one to record.
--
-- Run AFTER 007. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rescue: put today's accounts on the classes that have nobody
--
-- Only classes with zero members are touched, so this cannot hand out access to
-- a class somebody has already claimed, and re-running it does nothing.
-- ----------------------------------------------------------------------------

DO $rescue$
DECLARE
  n_classes bigint;
  n_links   bigint;
BEGIN
  SELECT count(*) INTO n_classes
  FROM public.classes c
  WHERE NOT EXISTS (SELECT 1 FROM public.class_staff cs WHERE cs.class_id = c.id);

  IF n_classes = 0 THEN
    RAISE NOTICE 'every class already has at least one member — nothing to rescue';
  ELSE
    INSERT INTO public.class_staff (class_id, staff_id, role)
    SELECT c.id, s.id, 'owner'
    FROM public.classes c
    CROSS JOIN public.staff s
    WHERE NOT EXISTS (SELECT 1 FROM public.class_staff x WHERE x.class_id = c.id)
    ON CONFLICT (class_id, staff_id) DO NOTHING;

    GET DIAGNOSTICS n_links = ROW_COUNT;
    RAISE NOTICE
      'attached % existing account(s) to % memberless class(es)', n_links, n_classes;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.staff) THEN
    RAISE WARNING
      'There are no staff rows, so no one is on any class and the scoping below '
      'will deny everything. Sign in once to create your staff row via '
      'ensure_staff(), then add yourself to a class from the SQL editor.';
  END IF;
END
$rescue$;

-- ----------------------------------------------------------------------------
-- 2. Access is membership. Nothing else.
--
-- can_manage_class is kept as a separate name because 007 calls it in seven
-- places, but it now means exactly the same thing. There is one kind of person
-- on a class and they can do everything to it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_access_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    p_class_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.class_staff cs
      JOIN public.staff s ON s.id = cs.staff_id
      WHERE cs.class_id = p_class_id
        AND s.user_id = auth.uid()
    );
$fn$;

CREATE OR REPLACE FUNCTION public.can_manage_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT public.can_access_class(p_class_id);
$fn$;

-- is_admin() survives so nothing that references it breaks, but it no longer
-- grants access to anything and every account is reset to false. The column
-- stays for the overadmin role TODO.md describes; until that exists it is
-- deliberately inert, and honest about it rather than quietly load-bearing.
UPDATE public.staff SET is_admin = false WHERE is_admin;

COMMENT ON COLUMN public.staff.is_admin IS
  'Inert as of migration 008. Grants nothing: access is membership in '
  'class_staff. Reserved for the overadmin role described in TODO.md.';

-- ----------------------------------------------------------------------------
-- 3. Signing in gets you a staff row
--
-- Without this a newly provisioned Supabase account has no staff row, so
-- current_staff_id() is NULL and they cannot create a class — the bootstrap in
-- 003 only ever ran once, over the accounts that existed then.
--
-- Called by the app after login. Safe to call on every load.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_staff(p_display_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_email text;
  v_staff public.staff%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  INSERT INTO public.staff (user_id, email, display_name)
  VALUES (v_uid, v_email, NULLIF(btrim(COALESCE(p_display_name, '')), ''))
  ON CONFLICT (user_id) DO UPDATE
    SET email        = COALESCE(EXCLUDED.email, public.staff.email),
        display_name = COALESCE(public.staff.display_name, EXCLUDED.display_name)
  RETURNING * INTO v_staff;

  RETURN jsonb_build_object(
    'staff_id',     v_staff.id,
    'email',        v_staff.email,
    'display_name', v_staff.display_name);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ensure_staff(text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_staff(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Collaboration: add someone by their exact email
--
-- Not "list all staff and pick one". A member can add a colleague they can name
-- but cannot enumerate everyone with an account, which would turn the staff
-- table into a directory of the whole institution.
--
-- The person must already have signed in at least once, because there is no
-- public signup and a staff row is created on first login.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_class_member(
  p_class_id uuid,
  p_email    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff public.staff%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change who is on this class';
  END IF;

  SELECT * INTO v_staff
  FROM public.staff
  WHERE lower(btrim(email)) = lower(btrim(COALESCE(p_email, '')));

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'No account for %. They need to sign in once before they can be added.',
      btrim(p_email);
  END IF;

  INSERT INTO public.class_staff (class_id, staff_id, role)
  VALUES (p_class_id, v_staff.id, 'owner')
  ON CONFLICT (class_id, staff_id) DO NOTHING;

  RETURN jsonb_build_object(
    'staff_id', v_staff.id,
    'email',    v_staff.email,
    'added',    true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.remove_class_member(
  p_class_id uuid,
  p_staff_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_remaining integer;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change who is on this class';
  END IF;

  SELECT count(*) INTO v_remaining
  FROM public.class_staff WHERE class_id = p_class_id AND staff_id <> p_staff_id;

  -- Removing the last member would leave a class nobody can reach, and with no
  -- admin bypass there is no way back except the SQL editor. Delete the class
  -- instead if that is what you meant.
  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'That is the only person on this class. Add someone else first, or delete '
      'the class.';
  END IF;

  DELETE FROM public.class_staff
  WHERE class_id = p_class_id AND staff_id = p_staff_id;

  RETURN jsonb_build_object('removed', true, 'remaining', v_remaining);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.list_class_members(p_class_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.can_access_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to see who is on this class';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'staff_id',     s.id,
           'email',        s.email,
           'display_name', s.display_name,
           'is_you',       s.user_id = auth.uid(),
           'since',        cs.created_at) ORDER BY s.email), '[]'::jsonb)
    INTO v_rows
  FROM public.class_staff cs
  JOIN public.staff s ON s.id = cs.staff_id
  WHERE cs.class_id = p_class_id;

  RETURN v_rows;
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.add_class_member(uuid, text)',
    'public.remove_class_member(uuid, uuid)',
    'public.list_class_members(uuid)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

-- ----------------------------------------------------------------------------
-- 5. Policies without the admin bypass
-- ----------------------------------------------------------------------------

-- staff: you can read yourself, and anyone who shares a class with you, so the
-- collaborators list has names in it. Nothing wider — the staff table is not a
-- directory of everyone with an account. All writes go through ensure_staff().
--
-- The predicate has to be a SECURITY DEFINER function rather than a subquery.
-- A policy on `staff` whose USING clause reads `staff` re-enters its own policy
-- and Postgres raises "infinite recursion detected". Running as the owner
-- sidesteps RLS inside the function, which is the same reason
-- can_access_class() is defined that way.
CREATE OR REPLACE FUNCTION public.shares_a_class_with(p_staff_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.class_staff theirs
    JOIN public.class_staff mine ON mine.class_id = theirs.class_id
    JOIN public.staff me ON me.id = mine.staff_id
    WHERE theirs.staff_id = p_staff_id
      AND me.user_id = auth.uid()
  );
$fn$;

REVOKE ALL ON FUNCTION public.shares_a_class_with(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.shares_a_class_with(uuid) TO authenticated;

DROP POLICY IF EXISTS staff_select       ON public.staff;
DROP POLICY IF EXISTS staff_admin_writes ON public.staff;

CREATE POLICY staff_select ON public.staff
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.shares_a_class_with(id));

-- class_staff: readable by members of the class. Writes go through the three
-- RPCs above, which enforce "you must be on the class" and refuse to leave one
-- with nobody.
DROP POLICY IF EXISTS class_staff_select       ON public.class_staff;
DROP POLICY IF EXISTS class_staff_admin_writes ON public.class_staff;

CREATE POLICY class_staff_select ON public.class_staff
  FOR SELECT TO authenticated USING (public.can_access_class(class_id));

-- classes: INSERT has no policy at all now, so a direct insert is impossible for
-- everyone and create_class() is the only route. That is not a restriction so
-- much as the removal of a trap: a direct `insert().select()` could never have
-- worked anyway, because the SELECT policy runs against a row whose membership
-- has not been written yet.
DROP POLICY IF EXISTS classes_insert ON public.classes;

COMMENT ON TABLE public.class_staff IS
  'Membership. Being on a class is the only thing that grants access to it, and '
  'everyone on a class can do everything to it. The role column is retained for '
  'a future distinction but is not read by any policy.';
