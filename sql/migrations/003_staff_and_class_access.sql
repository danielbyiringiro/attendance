-- ============================================================================
-- 003 — staff, and per-class access control
--
-- Until now every table in this database has carried the same policy:
--
--     FOR ALL TO authenticated USING (true) WITH CHECK (true)
--
-- RLS is enabled, but it filters nothing. It means "any logged-in account", not
-- "the people who run this class". That was defensible while there was one
-- implicit class and `isTA` was literally `!!session`. It stops being defensible
-- the moment a TA can create a class, because it also means any account can
-- read, edit and delete someone else's class and its entire roster.
--
-- This migration installs the machinery. Deliberately, it does NOT change who
-- can do what today: every account that already exists is enrolled as an admin,
-- so applying this is behaviourally a no-op. You tighten afterwards, by
-- demoting people, rather than by being locked out first.
--
-- Run AFTER 002, and BEFORE the attendance tables in 004 — retrofitting scoping
-- onto tables that already hold backfilled rows means rewriting data rather
-- than adding a predicate.
--
-- Idempotent.
-- ============================================================================

DO $enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'class_staff_role') THEN
    CREATE TYPE public.class_staff_role AS ENUM ('owner', 'supervisor', 'ta');
  END IF;
END
$enums$;

-- ----------------------------------------------------------------------------
-- staff — a person who can sign in
--
-- One row per auth.users row. The app has never had this: `isTA` is !!session,
-- so there is currently no way to ask WHICH teaching assistant is acting.
--
-- is_admin is the escape hatch that keeps a real institution workable: an admin
-- sees every class without needing a row per class.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL UNIQUE,      -- auth.users.id; no FK, that schema is Supabase's
  email        text,
  display_name text,
  is_admin     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_user ON public.staff (user_id);
CREATE INDEX IF NOT EXISTS idx_staff_admin ON public.staff (id) WHERE is_admin;

DROP TRIGGER IF EXISTS trg_staff_touch ON public.staff;
CREATE TRIGGER trg_staff_touch
  BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- class_staff — who runs which class
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.class_staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  staff_id   uuid NOT NULL REFERENCES public.staff(id)   ON DELETE CASCADE,
  role       public.class_staff_role NOT NULL DEFAULT 'ta',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT class_staff_unique UNIQUE (class_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_class_staff_class ON public.class_staff (class_id);
CREATE INDEX IF NOT EXISTS idx_class_staff_staff ON public.class_staff (staff_id);

-- ----------------------------------------------------------------------------
-- The predicates
--
-- All SECURITY DEFINER. This is not incidental: a policy on class_staff that
-- consulted class_staff through RLS would recurse forever. Running as the owner
-- sidesteps RLS inside the function, which is exactly what a policy helper needs.
--
-- STABLE so the planner can call them once per statement rather than per row.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_staff_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT s.id FROM public.staff s WHERE s.user_id = auth.uid();
$fn$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(
    (SELECT s.is_admin FROM public.staff s WHERE s.user_id = auth.uid()),
    false);
$fn$;

CREATE OR REPLACE FUNCTION public.can_access_class(p_class_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT
    p_class_id IS NOT NULL
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.class_staff cs
        JOIN public.staff s ON s.id = cs.staff_id
        WHERE cs.class_id = p_class_id
          AND s.user_id = auth.uid()
      )
    );
$fn$;

REVOKE ALL ON FUNCTION public.current_staff_id()          FROM public;
REVOKE ALL ON FUNCTION public.is_admin()                  FROM public;
REVOKE ALL ON FUNCTION public.can_access_class(uuid)      FROM public;
GRANT EXECUTE ON FUNCTION public.current_staff_id()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_class(uuid)   TO authenticated;

-- ----------------------------------------------------------------------------
-- Creating a class makes you its owner
--
-- Skipped when there is no JWT — the backfill in 005 and any SQL Editor session
-- run as postgres with no auth.uid(), and must not fail for want of a staff row.
--
-- This trigger alone is NOT enough to make a plain INSERT work for a non-admin,
-- which is why create_class() below exists. Postgres applies the SELECT policy
-- to the rows an `INSERT ... RETURNING` gives back, and at that moment the
-- class_staff row does not exist yet — an AFTER trigger has not fired. A plain
-- INSERT succeeds and the same statement with RETURNING fails, which would show
-- up as supabase-js `.insert().select()` mysteriously erroring.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_new_class()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff uuid;
BEGIN
  v_staff := public.current_staff_id();
  IF v_staff IS NOT NULL THEN
    INSERT INTO public.class_staff (class_id, staff_id, role)
    VALUES (NEW.id, v_staff, 'owner')
    ON CONFLICT (class_id, staff_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_classes_claim ON public.classes;
CREATE TRIGGER trg_classes_claim
  AFTER INSERT ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.claim_new_class();

-- ----------------------------------------------------------------------------
-- Bootstrap: everyone who already has an account becomes an admin
--
-- This is what makes applying this migration safe on a live database. Scoping
-- switches on, but nobody's access narrows, because every existing account is
-- an admin and admins see everything. Demote them afterwards and the scoping
-- starts biting — at a moment you choose, not at the moment you paste this.
--
-- Only ever grants on a first run: the ON CONFLICT means re-running will not
-- re-promote someone you have since demoted.
-- ----------------------------------------------------------------------------

DO $bootstrap$
DECLARE
  v_existing bigint;
  v_added    bigint;
BEGIN
  SELECT count(*) INTO v_existing FROM public.staff;

  IF v_existing > 0 THEN
    RAISE NOTICE 'staff already populated (% rows) — bootstrap skipped', v_existing;
    RETURN;
  END IF;

  INSERT INTO public.staff (user_id, email, is_admin)
  SELECT u.id, u.email, true
  FROM auth.users u
  ON CONFLICT (user_id) DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'bootstrapped % existing account(s) as admin', v_added;

  IF v_added = 0 THEN
    RAISE WARNING
      'No rows in auth.users, so no admin was created. Until a staff row exists '
      'with is_admin = true, per-class policies will deny everything. Add one '
      'before relying on this.';
  END IF;
END
$bootstrap$;

-- ----------------------------------------------------------------------------
-- Policies
--
-- classes needs INSERT split from the rest: on INSERT there is no class_staff
-- row yet (the trigger above adds it after), so the check is "are you staff at
-- all", while SELECT/UPDATE/DELETE ask "can you access this class".
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS classes_auth_all ON public.classes;
DROP POLICY IF EXISTS classes_select   ON public.classes;
DROP POLICY IF EXISTS classes_insert   ON public.classes;
DROP POLICY IF EXISTS classes_update   ON public.classes;
DROP POLICY IF EXISTS classes_delete   ON public.classes;

CREATE POLICY classes_select ON public.classes
  FOR SELECT TO authenticated USING (public.can_access_class(id));

-- Direct INSERT is admins only. Everyone else creates through create_class(),
-- for the RETURNING reason above. Restricting it here rather than allowing both
-- keeps visibility resting on exactly one mechanism — class_staff — so that
-- removing someone from a class actually removes their access, which a
-- "creator can always see it" rule would quietly undermine.
CREATE POLICY classes_insert ON public.classes
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY classes_update ON public.classes
  FOR UPDATE TO authenticated
  USING (public.can_access_class(id)) WITH CHECK (public.can_access_class(id));

CREATE POLICY classes_delete ON public.classes
  FOR DELETE TO authenticated USING (public.can_access_class(id));

-- Everything hanging off a class is scoped by the class it belongs to. This is
-- the payoff for carrying class_id on every table rather than joining for it.
DO $scope$
DECLARE
  t text;
  tables text[] := ARRAY['cohorts', 'enrolments', 'cohort_schedules', 'class_sessions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_scoped ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_scoped ON public.%I FOR ALL TO authenticated '
      'USING (public.can_access_class(class_id)) '
      'WITH CHECK (public.can_access_class(class_id));', t, t);
  END LOOP;
END
$scope$;

-- staff: you can always read yourself, admins read everyone, and only admins
-- may create or modify staff rows. Without the self-read, current_staff_id()
-- would be the only way an account could learn it exists.
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_select       ON public.staff;
DROP POLICY IF EXISTS staff_admin_writes ON public.staff;

CREATE POLICY staff_select ON public.staff
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY staff_admin_writes ON public.staff
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- class_staff: visible to anyone who can access the class; writable by admins.
-- Deliberately NOT writable by a class owner yet — "an owner may add a TA"
-- needs an invite flow to be useful, and that is a later phase.
ALTER TABLE public.class_staff ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS class_staff_select       ON public.class_staff;
DROP POLICY IF EXISTS class_staff_admin_writes ON public.class_staff;

CREATE POLICY class_staff_select ON public.class_staff
  FOR SELECT TO authenticated USING (public.can_access_class(class_id));

CREATE POLICY class_staff_admin_writes ON public.class_staff
  FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE ALL ON public.staff       FROM anon;
REVOKE ALL ON public.class_staff FROM anon;

-- ----------------------------------------------------------------------------
-- create_class — the supported way for a non-admin to create a class
--
-- SECURITY DEFINER, so it sidesteps the RETURNING problem described above and
-- can write the owner row in the same transaction as the class. The caller must
-- be staff; that is the only gate, because accounts here are provisioned in the
-- Supabase dashboard and there is no public signup.
--
-- Also does the cohorts, since "a class with N cohorts" is one intent and
-- splitting it across two round trips leaves a class with no sections if the
-- second fails. p_cohort_labels wins when supplied; otherwise p_cohort_count
-- generates A, B, C...
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_class(
  p_code           text,
  p_name           text,
  p_term_starts_on date,
  p_term_ends_on   date,
  p_timezone       text    DEFAULT 'Africa/Accra',
  p_cohort_count   integer DEFAULT 1,
  p_cohort_labels  text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff  uuid;
  v_class  uuid;
  v_labels text[];
BEGIN
  v_staff := public.current_staff_id();
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'only staff can create a class';
  END IF;

  IF p_cohort_labels IS NOT NULL AND array_length(p_cohort_labels, 1) > 0 THEN
    v_labels := p_cohort_labels;
  ELSE
    IF p_cohort_count IS NULL OR p_cohort_count < 1 OR p_cohort_count > 26 THEN
      RAISE EXCEPTION 'cohort count must be between 1 and 26, got %', p_cohort_count;
    END IF;
    SELECT array_agg(chr(64 + i) ORDER BY i)
      INTO v_labels
    FROM generate_series(1, p_cohort_count) i;
  END IF;

  INSERT INTO public.classes (code, name, term_starts_on, term_ends_on, timezone)
  VALUES (btrim(p_code), btrim(p_name), p_term_starts_on, p_term_ends_on,
          COALESCE(NULLIF(btrim(p_timezone), ''), 'Africa/Accra'))
  RETURNING id INTO v_class;

  -- The AFTER INSERT trigger already claimed ownership when there is a JWT;
  -- this makes it certain even when there is not.
  INSERT INTO public.class_staff (class_id, staff_id, role)
  VALUES (v_class, v_staff, 'owner')
  ON CONFLICT (class_id, staff_id) DO NOTHING;

  INSERT INTO public.cohorts (class_id, label)
  SELECT v_class, btrim(l)
  FROM unnest(v_labels) l
  WHERE btrim(l) <> ''
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'class_id', v_class,
    'cohorts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'label', label) ORDER BY label)
      FROM public.cohorts WHERE class_id = v_class), '[]'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_class(text, text, date, date, text, integer, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.create_class(text, text, date, date, text, integer, text[]) TO authenticated;

-- ----------------------------------------------------------------------------
-- The legacy tables are deliberately left on the old blanket policy
--
-- students, present_students, cancelled_sessions, class_dates, class_schedule,
-- excused_absences, flagged and report_settings still carry `_auth_all`. They
-- are read by the dashboard and the exporter as they stand today, and tightening
-- them before those readers are ported would break the running app.
--
-- students is a special case and will stay broad by design: it is the global
-- person registry, so a student exists independently of any one class. What it
-- should eventually gain is visibility limited to students enrolled in a class
-- you can access — which cannot be expressed until the roster upload writes
-- through a SECURITY DEFINER RPC, because a brand-new student has no enrolment
-- at the instant they are inserted.
-- ----------------------------------------------------------------------------

COMMENT ON TABLE public.staff IS
  'People who can sign in. One row per auth.users row. is_admin sees every '
  'class without a per-class row.';

COMMENT ON TABLE public.class_staff IS
  'Which staff run which class. can_access_class() reads this.';
