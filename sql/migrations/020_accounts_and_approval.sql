-- ============================================================================
-- 020 — anyone can ask for an account; an admin decides
--
-- Until now accounts were provisioned by hand in the Supabase dashboard, and
-- `isTA = !!session` meant anybody with a session was a TA. This adds the two
-- gates that were missing: which email addresses may create an account at all,
-- and who decides whether a new account can do anything.
--
-- ORDER MATTERS IN THIS FILE, for the same reason it did in 008. Every existing
-- staff row is marked approved BEFORE current_staff_id() starts requiring
-- approval. Reversing those two steps locks out every account in the
-- installation, including the one applying the migration.
--
-- WHAT ADMIN IS, AND IS NOT
--
-- 008 removed the admin bypass on class data deliberately: you see a class if
-- you are on it. That rule is untouched here. can_access_class and
-- can_manage_class are not modified, and no admin check is added to them.
--
-- Admin instead gets its OWN functions, prefixed admin_, covering exactly two
-- jobs: approving accounts, and repairing class membership when somebody has
-- locked themselves out. An admin can see that a class exists and who is on it,
-- can add or remove a member, and can delete a class. An admin cannot see a
-- roster, a session, or anybody's attendance.
--
-- Separate functions rather than widening the existing predicates, so there is
-- no path by which admin reach leaks into attendance because a WHERE clause
-- quietly broadened later.
--
-- Run AFTER 019. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Which addresses may sign up
--
-- A table rather than a constant: the domain list is something an admin edits,
-- not something that needs a migration and a deploy.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.allowed_email_domains (
  domain     text PRIMARY KEY,
  added_by   uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT allowed_email_domains_lowercase CHECK (domain = lower(domain)),
  CONSTRAINT allowed_email_domains_shape CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$')
);

INSERT INTO public.allowed_email_domains (domain) VALUES ('ashesi.edu.gh')
ON CONFLICT (domain) DO NOTHING;

ALTER TABLE public.allowed_email_domains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allowed_email_domains_read ON public.allowed_email_domains;
-- Readable by anyone signed in so the signup screen can say which domains are
-- accepted before somebody types an address that will be refused. Writing goes
-- through the admin RPCs.
CREATE POLICY allowed_email_domains_read ON public.allowed_email_domains
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.allowed_email_domains IS
  'Email domains permitted to create an account. Empty means nobody new can '
  'sign up, which is a valid state.';

-- ----------------------------------------------------------------------------
-- Approval state on staff
-- ----------------------------------------------------------------------------

DO $enum$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staff_status') THEN
    CREATE TYPE public.staff_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END
$enum$;

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS status public.staff_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS decision_note text;

CREATE INDEX IF NOT EXISTS idx_staff_status ON public.staff (status);

-- ---- FIRST: everybody who already exists is approved --------------------
-- They have been running classes. Gating current_staff_id() before this runs
-- would lock out the entire installation.
DO $grandfather$
DECLARE n integer;
BEGIN
  UPDATE public.staff SET status = 'approved', decided_at = now()
   WHERE status = 'pending' AND created_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE
    '020: % existing account(s) marked approved — they predate approval and '
    'must not be locked out', n;
END
$grandfather$;

-- ---- THEN: the first admin ----------------------------------------------
--
-- EDIT ME. Chicken and egg: approving accounts requires an admin, and there is
-- none. Set this to the email of the account that should be able to approve the
-- rest. Matched case-insensitively against an existing staff row; if no row
-- matches, the migration warns and changes nothing.
--
-- A plpgsql variable rather than a psql \set: psql does not interpolate its
-- variables inside a dollar-quoted block, so :'name' here is a syntax error.
--
-- The address below is a placeholder and matches nothing. Replace it in your
-- own copy when you run this; do not commit a real one back.
DO $bootstrap$
DECLARE
  v_email text := lower(btrim('first.admin@example.edu'));
  n integer;
BEGIN
  UPDATE public.staff SET is_admin = true
   WHERE lower(btrim(email)) = v_email;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n = 0 THEN
    RAISE WARNING
      'no staff row matches % — nobody is an admin, so no account can ever be '
      'approved. Set v_email in this bootstrap block to an address that has '
      'signed in at least once, and re-apply.', v_email;
  ELSE
    RAISE NOTICE '020: % is now an admin', v_email;
  END IF;
END
$bootstrap$;

COMMENT ON COLUMN public.staff.is_admin IS
  'Live again as of migration 020, and scoped: it grants the admin_ functions '
  '(approving accounts, repairing class membership) and nothing else. It does '
  'NOT grant access to any class''s roster, sessions or attendance — 008''s '
  'rule that you see a class if you are on it is untouched.';

-- ----------------------------------------------------------------------------
-- is_admin — live, and honest about what it means
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.user_id = auth.uid()
      AND s.is_admin
      AND s.status = 'approved'
  );
$fn$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

COMMENT ON FUNCTION public.is_admin() IS
  'Whether the caller may use the admin_ functions. Deliberately NOT consulted '
  'by can_access_class or can_manage_class: admin is not a way into a class.';

-- ----------------------------------------------------------------------------
-- current_staff_id — approval is the gate
--
-- One choke point. Everything that asks "who am I" goes through this, so a
-- pending or rejected account cannot create a class, be added to one, or reach
-- anything scoped by membership — without a check having to be remembered in
-- each of those places.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_staff_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT s.id FROM public.staff s
  WHERE s.user_id = auth.uid() AND s.status = 'approved';
$fn$;

REVOKE ALL ON FUNCTION public.current_staff_id() FROM public;
GRANT EXECUTE ON FUNCTION public.current_staff_id() TO authenticated;

-- ----------------------------------------------------------------------------
-- ensure_staff — creates a PENDING row, and refuses a domain nobody allowed
--
-- Supabase has already created the auth.users row by the time this runs: the
-- signup itself cannot be prevented from here. What can be prevented is the
-- account meaning anything, so an address outside the allowed domains gets no
-- staff row at all and is told why.
--
-- Returns the status rather than raising, so the screen can say "waiting for
-- approval" instead of showing an error to somebody who has done nothing wrong.
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
  v_domain text;
  v_staff  public.staff%ROWTYPE;
  v_open   boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  SELECT * INTO v_staff FROM public.staff WHERE user_id = v_uid;

  -- An existing account keeps whatever status it has: a domain removed from
  -- the list later must not silently revoke somebody already approved.
  IF FOUND THEN
    UPDATE public.staff
       SET email        = COALESCE(v_email, email),
           display_name = COALESCE(display_name,
                            NULLIF(btrim(COALESCE(p_display_name, '')), '')),
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
    VALUES (v_uid, v_email,
            NULLIF(btrim(COALESCE(p_display_name, '')), ''), 'pending')
    RETURNING * INTO v_staff;
  END IF;

  RETURN jsonb_build_object(
    'staff_id',     v_staff.id,
    'email',        v_staff.email,
    'display_name', v_staff.display_name,
    'status',       v_staff.status,
    'is_admin',     v_staff.is_admin,
    'decision_note', v_staff.decision_note);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ensure_staff(text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_staff(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- An unapproved account cannot be added to a class either
--
-- current_staff_id() gates the caller; this gates the person being added, who
-- is somebody else entirely.
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

  IF v_staff.status <> 'approved' THEN
    RAISE EXCEPTION
      'That account is still waiting to be approved. An admin has to approve % '
      'before they can be given a class.', btrim(p_email);
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

REVOKE ALL ON FUNCTION public.add_class_member(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.add_class_member(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Admin: accounts
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_staff(p_status text DEFAULT NULL)
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
           'staff_id',      s.id,
           'email',         s.email,
           'display_name',  s.display_name,
           'status',        s.status,
           'is_admin',      s.is_admin,
           'created_at',    s.created_at,
           'decided_at',    s.decided_at,
           'decision_note', s.decision_note,
           'classes',       (SELECT count(*) FROM public.class_staff cs
                             WHERE cs.staff_id = s.id))
         -- Pending first: the queue is the reason to open this screen.
         ORDER BY (s.status = 'pending') DESC, s.created_at DESC), '[]'::jsonb)
    INTO v_rows
  FROM public.staff s
  WHERE p_status IS NULL OR s.status::text = p_status;

  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_decide_staff(
  p_staff_id uuid,
  p_approve  boolean,
  p_note     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me    uuid := public.current_staff_id();
  v_staff public.staff%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  -- An admin who rejects themselves loses the ability to undo it, and if they
  -- are the only admin nobody can ever approve anybody again.
  IF p_staff_id = v_me AND NOT p_approve THEN
    RAISE EXCEPTION
      'That is you. Rejecting your own account would remove your access and, '
      'if you are the only admin, leave nobody able to approve anyone.';
  END IF;

  UPDATE public.staff
     SET status        = (CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END)
                           ::public.staff_status,
         decided_by    = v_me,
         decided_at    = now(),
         decision_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
         updated_at    = now()
   WHERE id = p_staff_id
  RETURNING * INTO v_staff;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such account';
  END IF;

  RETURN jsonb_build_object(
    'staff_id', v_staff.id,
    'email',    v_staff.email,
    'status',   v_staff.status);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_admin(
  p_staff_id uuid,
  p_is_admin boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me        uuid := public.current_staff_id();
  v_remaining integer;
  v_staff     public.staff%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF NOT p_is_admin THEN
    SELECT count(*) INTO v_remaining
    FROM public.staff
    WHERE is_admin AND status = 'approved' AND id <> p_staff_id;

    -- The same shape as the last-member guard on a class: an installation with
    -- no admin has no way back except the SQL editor.
    IF v_remaining = 0 THEN
      RAISE EXCEPTION
        'That is the only admin. Make somebody else an admin first.';
    END IF;
  END IF;

  UPDATE public.staff
     SET is_admin = p_is_admin, updated_at = now()
   WHERE id = p_staff_id
  RETURNING * INTO v_staff;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such account';
  END IF;

  RETURN jsonb_build_object(
    'staff_id', v_staff.id,
    'email',    v_staff.email,
    'is_admin', v_staff.is_admin,
    'was_self', p_staff_id = v_me);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- Admin: the allowed domains
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_domain(
  p_domain text,
  p_allow  boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_domain text := lower(btrim(COALESCE(p_domain, '')));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' THEN
    RAISE EXCEPTION
      '% does not look like a domain. Enter it without the @, for example '
      'ashesi.edu.gh', p_domain;
  END IF;

  IF p_allow THEN
    INSERT INTO public.allowed_email_domains (domain, added_by)
    VALUES (v_domain, public.current_staff_id())
    ON CONFLICT (domain) DO NOTHING;
  ELSE
    DELETE FROM public.allowed_email_domains WHERE domain = v_domain;
  END IF;

  RETURN jsonb_build_object('domain', v_domain, 'allowed', p_allow);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_staff(text)          FROM public;
REVOKE ALL ON FUNCTION public.admin_decide_staff(uuid, boolean, text) FROM public;
REVOKE ALL ON FUNCTION public.admin_set_admin(uuid, boolean)  FROM public;
REVOKE ALL ON FUNCTION public.admin_set_domain(text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_list_staff(text)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_staff(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_admin(uuid, boolean)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_domain(text, boolean) TO authenticated;

-- ----------------------------------------------------------------------------
-- Admin: repairing a class nobody can reach
--
-- The case this exists for happened during development: a TA removed a
-- collaborator, the members list had reordered under them, and they removed
-- themselves instead. 018 made that much harder, but "much harder" is not
-- "impossible" — the last member can still be removed by two people racing, and
-- a class whose only member deletes their account is unreachable by anyone.
--
-- These four functions are the way back, and they are carefully narrow. An
-- admin can see WHICH classes exist and WHO is on them, and can change that.
-- An admin cannot see a roster, a session, or a single attendance record: none
-- of these functions returns any, and can_access_class is not modified, so
-- every existing read still requires membership.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_classes()
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
           'class_id',    k.id,
           'code',        k.code,
           'name',        k.name,
           'archived',    k.archived_at IS NOT NULL,
           'members',     (SELECT count(*) FROM public.class_staff cs
                           WHERE cs.class_id = k.id),
           -- Deliberately a COUNT and not the people. An admin repairing
           -- membership does not need to know who is enrolled.
           'enrolments',  (SELECT count(*) FROM public.enrolments e
                           WHERE e.class_id = k.id))
         -- Unreachable classes first: that is what this screen is for.
         ORDER BY (SELECT count(*) FROM public.class_staff cs
                   WHERE cs.class_id = k.id) ASC, k.code), '[]'::jsonb)
    INTO v_rows
  FROM public.classes k;

  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_list_class_members(p_class_id uuid)
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
           'staff_id',     s.id,
           'email',        s.email,
           'display_name', s.display_name,
           'since',        cs.created_at) ORDER BY s.email), '[]'::jsonb)
    INTO v_rows
  FROM public.class_staff cs
  JOIN public.staff s ON s.id = cs.staff_id
  WHERE cs.class_id = p_class_id;

  RETURN v_rows;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_class_member(
  p_class_id uuid,
  p_email    text,
  p_member   boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff     public.staff%ROWTYPE;
  v_remaining integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
    RAISE EXCEPTION 'no such class';
  END IF;

  SELECT * INTO v_staff FROM public.staff
  WHERE lower(btrim(email)) = lower(btrim(COALESCE(p_email, '')));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No account for %.', btrim(p_email);
  END IF;

  IF p_member THEN
    IF v_staff.status <> 'approved' THEN
      RAISE EXCEPTION
        'That account is not approved yet. Approve % first.', btrim(p_email);
    END IF;

    INSERT INTO public.class_staff (class_id, staff_id, role)
    VALUES (p_class_id, v_staff.id, 'owner')
    ON CONFLICT (class_id, staff_id) DO NOTHING;
  ELSE
    SELECT count(*) INTO v_remaining
    FROM public.class_staff
    WHERE class_id = p_class_id AND staff_id <> v_staff.id;

    -- Admin can repair an unreachable class; it should not be able to create
    -- one by accident. Deleting the class is the deliberate way to end it.
    IF v_remaining = 0 THEN
      RAISE EXCEPTION
        'That is the only person on this class. Removing them would leave it '
        'reachable by nobody — add somebody else first, or delete the class.';
    END IF;

    DELETE FROM public.class_staff
    WHERE class_id = p_class_id AND staff_id = v_staff.id;
  END IF;

  RETURN jsonb_build_object(
    'class_id', p_class_id,
    'staff_id', v_staff.id,
    'email',    v_staff.email,
    'member',   p_member);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_delete_class(
  p_class_id     uuid,
  p_confirm_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such class';
  END IF;

  -- The same confirmation the owner's own deletion requires. An admin deleting
  -- somebody else's class should have to type its code just as they would.
  IF lower(btrim(COALESCE(p_confirm_code, ''))) <> lower(btrim(v_class.code)) THEN
    RAISE EXCEPTION
      'confirmation does not match: type the class code (%) exactly', v_class.code;
  END IF;

  -- Everything cascades, and students whose only enrolment was this class go
  -- with it, exactly as in delete_class. flagged is cleared by hand for the
  -- same reason: no foreign key from students.
  DROP TABLE IF EXISTS tmp_admin_orphans;
  CREATE TEMP TABLE tmp_admin_orphans ON COMMIT DROP AS
  SELECT DISTINCT e.student_id
  FROM public.enrolments e
  WHERE e.class_id = p_class_id
    AND NOT EXISTS (
      SELECT 1 FROM public.enrolments o
      WHERE o.student_id = e.student_id AND o.class_id <> p_class_id);

  DELETE FROM public.classes WHERE id = p_class_id;

  DELETE FROM public.flagged f
   USING tmp_admin_orphans o WHERE f.student_id = o.student_id;

  DELETE FROM public.students s
   USING tmp_admin_orphans o
   WHERE s.student_id = o.student_id
     AND NOT EXISTS (
       SELECT 1 FROM public.enrolments e WHERE e.student_id = s.student_id);

  DROP TABLE IF EXISTS tmp_admin_orphans;

  RETURN jsonb_build_object('deleted', true, 'code', v_class.code);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_classes()                    FROM public;
REVOKE ALL ON FUNCTION public.admin_list_class_members(uuid)          FROM public;
REVOKE ALL ON FUNCTION public.admin_set_class_member(uuid, text, boolean) FROM public;
REVOKE ALL ON FUNCTION public.admin_delete_class(uuid, text)          FROM public;
GRANT EXECUTE ON FUNCTION public.admin_list_classes()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_class_members(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_class_member(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_class(uuid, text)          TO authenticated;
