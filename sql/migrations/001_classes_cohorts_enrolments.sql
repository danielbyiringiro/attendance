-- ============================================================================
-- 001 — classes, cohorts, enrolments
--
-- Introduces the entities the app has never had. Today "Cohort A/B/C" is a bare
-- text column with no lookup table and no foreign key, so a class is not a thing
-- that can be created, customised or deleted — it is an assumption spread across
-- five hardcoded SelectItem lists and a CHECK constraint production does not
-- actually enforce.
--
-- Structure: classes -> cohorts -> enrolments. `students` is deliberately left
-- alone as the global person registry, so uploading a roster for a second class
-- reuses a student who already exists rather than duplicating them.
--
-- Run AFTER sql/secure_database.sql and the sql/add_*.sql patches.
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run. Idempotent.
--
-- Nothing here changes app behaviour. The new tables are empty until 004
-- backfills them, and no existing table is altered except for two COMMENTs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
--
-- Enums rather than CHECK constraints, deliberately. The README declares
-- `check (cohort in ('A','B'))` on five tables while the app writes 'C'; a
-- constraint that is wrong is worse than no constraint, because it stays
-- invisible until an insert fails. An enum is one definition, extended in one
-- place.
-- ----------------------------------------------------------------------------

DO $enums$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'session_status') THEN
    CREATE TYPE public.session_status AS ENUM
      ('scheduled', 'open', 'closed', 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_state') THEN
    -- Migration brief section 2.6.
    CREATE TYPE public.attendance_state AS ENUM
      ('present', 'late', 'excused', 'unexcused', 'pending', 'exempted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_mode') THEN
    CREATE TYPE public.delivery_mode AS ENUM ('in_person', 'online', 'hybrid');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_method') THEN
    CREATE TYPE public.attendance_method AS ENUM
      ('fixed_code', 'rotating_code', 'qr', 'manual_only');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_role') THEN
    CREATE TYPE public.actor_role AS ENUM ('student', 'staff', 'system');
  END IF;
END
$enums$;

-- ----------------------------------------------------------------------------
-- classes — what a TA creates, customises and deletes
--
-- Top level for now. Every table below carries class_id, so adding an
-- institutions table later is additive rather than a restructure.
--
-- The default_* columns are the class-wide session template: a session inherits
-- them at generation time and can be overridden individually afterwards.
-- Holding them here rather than in a separate templates table keeps "customise
-- this class" in one obvious place while per-session tooling is still deferred.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.classes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text NOT NULL,
  name                        text NOT NULL,
  description                 text,

  term_starts_on              date NOT NULL,
  term_ends_on                date NOT NULL,
  -- Sessions resolve their calendar date in this zone, once, at write time. The
  -- app currently has four weekday checks that disagree about local versus UTC.
  timezone                    text NOT NULL DEFAULT 'Africa/Accra',

  min_attendance_percentage   numeric(5,2) NOT NULL DEFAULT 75,

  default_method              public.attendance_method NOT NULL DEFAULT 'fixed_code',
  default_delivery_mode       public.delivery_mode NOT NULL DEFAULT 'in_person',
  default_duration_minutes    integer NOT NULL DEFAULT 60,
  default_late_window_minutes integer NOT NULL DEFAULT 10,
  default_auto_close_minutes  integer NOT NULL DEFAULT 15,
  default_early_open_minutes  integer NOT NULL DEFAULT 5,

  archived_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT classes_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT classes_term_ordered   CHECK (term_ends_on >= term_starts_on),
  CONSTRAINT classes_percentage_range
    CHECK (min_attendance_percentage >= 0 AND min_attendance_percentage <= 100),
  CONSTRAINT classes_durations_sane CHECK (
    default_duration_minutes > 0
    AND default_late_window_minutes >= 0
    AND default_auto_close_minutes >= 0
    AND default_early_open_minutes >= 0
  )
);

-- Case-insensitive, so "cs101" and "CS101" cannot both exist. delete_class()
-- asks the TA to type this code back, which only means something if it is
-- unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_code_lower
  ON public.classes (lower(btrim(code)));

CREATE INDEX IF NOT EXISTS idx_classes_active
  ON public.classes (created_at DESC) WHERE archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- cohorts — a section of a class
--
-- "How many cohorts does this class have" is answered by counting rows here,
-- not by a hardcoded A/B/C. Labels are free text, so a class can use 1/2/3 or
-- Morning/Evening rather than being forced into letters.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cohorts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  label      text NOT NULL,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cohorts_label_not_blank CHECK (btrim(label) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cohorts_class_label
  ON public.cohorts (class_id, upper(btrim(label)));

CREATE INDEX IF NOT EXISTS idx_cohorts_class ON public.cohorts (class_id);

-- ----------------------------------------------------------------------------
-- enrolments — which student is in which cohort of which class
--
-- This is what makes `students` a person rather than a row in one group. A
-- student taking two courses gets two enrolments and one student row, which is
-- what lets a roster upload for a second class reuse them instead of failing on
-- the primary key.
--
-- class_id is denormalised from cohort_id so that the unique constraint below is
-- expressible at all, and so a later per-class RLS policy is one predicate
-- rather than a join. A trigger keeps the two honest.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.enrolments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  cohort_id   uuid NOT NULL REFERENCES public.cohorts(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  enrolled_on date NOT NULL DEFAULT CURRENT_DATE,
  dropped_on  date,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT enrolments_cohort_student_unique UNIQUE (cohort_id, student_id),
  -- Load-bearing for check-in. A student in two cohorts of ONE class would make
  -- an otherwise-unique PIN ambiguous, since both cohorts could be open at once.
  -- One enrolment per class per student forecloses that.
  CONSTRAINT enrolments_class_student_unique  UNIQUE (class_id, student_id),
  CONSTRAINT enrolments_dates_ordered
    CHECK (dropped_on IS NULL OR dropped_on >= enrolled_on)
);

CREATE INDEX IF NOT EXISTS idx_enrolments_cohort  ON public.enrolments (cohort_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_student ON public.enrolments (student_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_class_active
  ON public.enrolments (class_id) WHERE dropped_on IS NULL;

-- ----------------------------------------------------------------------------
-- Keep the denormalised class_id honest
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_enrolment_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_class_id uuid;
BEGIN
  SELECT class_id INTO v_class_id FROM public.cohorts WHERE id = NEW.cohort_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', NEW.cohort_id;
  END IF;
  IF NEW.class_id IS DISTINCT FROM v_class_id THEN
    RAISE EXCEPTION
      'enrolment class_id % disagrees with the class of cohort % (which is %)',
      NEW.class_id, NEW.cohort_id, v_class_id;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enrolments_assert_class ON public.enrolments;
CREATE TRIGGER trg_enrolments_assert_class
  BEFORE INSERT OR UPDATE OF class_id, cohort_id ON public.enrolments
  FOR EACH ROW EXECUTE FUNCTION public.assert_enrolment_class();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_classes_touch ON public.classes;
CREATE TRIGGER trg_classes_touch
  BEFORE UPDATE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- students.cohort is now a copy of a fact that lives in enrolments
--
-- Not dropped here: the dashboard, the exporter and the check-in RPC all still
-- read it, and they are ported one at a time. 007 drops it once nothing does.
-- ----------------------------------------------------------------------------

COMMENT ON COLUMN public.students.cohort IS
  'DEPRECATED as of migration 001. The real fact is enrolments.cohort_id. Still '
  'written by the legacy path during the bridge; dropped in migration 007.';

COMMENT ON TABLE public.students IS
  'Global person registry. A student exists once regardless of how many classes '
  'they take; membership lives in enrolments.';

-- ----------------------------------------------------------------------------
-- RLS — the existing house pattern, unchanged
--
-- Any authenticated user sees everything, exactly as every other table in this
-- database already works. Real per-class scoping needs a staff table and
-- auth.uid() and is deliberately deferred; because every table above carries
-- class_id, that later change is one predicate per table rather than a reshape.
--
-- anon gets nothing here. Student paths go only through SECURITY DEFINER RPCs.
-- ----------------------------------------------------------------------------

DO $rls$
DECLARE
  t text;
  tables text[] := ARRAY['classes', 'cohorts', 'enrolments'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_auth_all ON public.%I FOR ALL TO authenticated '
      'USING (true) WITH CHECK (true);', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END
$rls$;
