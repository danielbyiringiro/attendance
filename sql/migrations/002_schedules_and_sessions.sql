-- ============================================================================
-- 002 — schedules and sessions
--
-- Replaces two constants with data.
--
-- Today "which days are class days" is `day === 2 || day === 3 || day === 4`,
-- written out four separate times (twice in TADashboard, once in
-- StudentDashboard, once as a Set in attendanceExport), with the first three
-- reading getDay() and the fourth getUTCDay(). And "did a class happen on this
-- date" is inferred after the fact from whether anyone checked in, which is why
-- a reading week charges every student an absence.
--
-- After this migration a session is a row that exists BEFORE anyone checks in.
-- That is the change the migration brief calls the highest-leverage one, and
-- everything in 003 depends on it.
--
-- Run AFTER 001. Idempotent. Still changes no app behaviour: the tables are
-- empty until 004 backfills them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- cohort_schedules — the meeting pattern
--
-- One row per weekday a cohort meets. Two cohorts of a class can meet on
-- different days at different times, which the single global class_schedule
-- table could express but nothing ever read, because every consumer was gated
-- behind the hardcoded weekday check first.
--
-- effective_from / effective_until allow the pattern to change mid-term without
-- rewriting history: sessions already generated keep their own copy of the
-- timing, so editing a schedule never silently rewrites the past.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cohort_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  cohort_id        uuid NOT NULL REFERENCES public.cohorts(id) ON DELETE CASCADE,
  weekday          smallint NOT NULL,          -- 0 = Sunday .. 6 = Saturday
  start_time       time NOT NULL,
  duration_minutes integer,                    -- NULL inherits classes.default_duration_minutes
  delivery_mode    public.delivery_mode,       -- NULL inherits classes.default_delivery_mode
  effective_from   date,
  effective_until  date,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cohort_schedules_weekday_range CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT cohort_schedules_duration_positive
    CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  CONSTRAINT cohort_schedules_dates_ordered
    CHECK (effective_until IS NULL OR effective_from IS NULL
           OR effective_until >= effective_from),
  CONSTRAINT cohort_schedules_slot_unique UNIQUE (cohort_id, weekday, start_time)
);

CREATE INDEX IF NOT EXISTS idx_cohort_schedules_class  ON public.cohort_schedules (class_id);
CREATE INDEX IF NOT EXISTS idx_cohort_schedules_cohort ON public.cohort_schedules (cohort_id);

-- ----------------------------------------------------------------------------
-- class_sessions — one meeting of one cohort
--
-- Lifecycle scheduled -> open -> closed, with cancelled reachable from any of
-- them (brief section 2.2).
--
-- Cancellation is a status on THIS row. Today it is an upsert into
-- cancelled_sessions keyed (date, cohort), and the weekly report then matches on
-- date alone — so cancelling cohort A's Wednesday silently cancels B's and C's
-- too. Sessions are never shared between cohorts, so that whole class of bug
-- stops being expressible.
--
-- The timing columns are copied from the class defaults at generation time
-- rather than read through at check-in, so changing a class default never
-- retroactively alters how a session that already happened was judged.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.class_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id            uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  cohort_id           uuid NOT NULL REFERENCES public.cohorts(id) ON DELETE CASCADE,
  schedule_id         uuid REFERENCES public.cohort_schedules(id) ON DELETE SET NULL,

  starts_at           timestamptz NOT NULL,
  -- Resolved once, at write time, in the class's timezone by a trigger. Every
  -- date comparison in the app reads this instead of converting a timestamp,
  -- which is what makes the local-versus-UTC disagreement unrepresentable.
  session_date        date NOT NULL,
  duration_minutes    integer NOT NULL DEFAULT 60,
  delivery_mode       public.delivery_mode NOT NULL DEFAULT 'in_person',

  status              public.session_status NOT NULL DEFAULT 'scheduled',
  method              public.attendance_method NOT NULL DEFAULT 'fixed_code',
  pin                 text,

  late_window_minutes integer NOT NULL DEFAULT 10,
  auto_close_minutes  integer NOT NULL DEFAULT 15,
  early_open_minutes  integer NOT NULL DEFAULT 5,

  opened_at           timestamptz,
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  notes               text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT class_sessions_slot_unique UNIQUE (cohort_id, starts_at),
  CONSTRAINT class_sessions_duration_positive CHECK (duration_minutes > 0),
  CONSTRAINT class_sessions_windows_sane CHECK (
    late_window_minutes >= 0 AND auto_close_minutes >= 0 AND early_open_minutes >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_sessions_class_date
  ON public.class_sessions (class_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cohort_date
  ON public.class_sessions (cohort_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status
  ON public.class_sessions (status) WHERE status IN ('scheduled', 'open');

-- The index that makes "the PIN identifies the class" safe. Two TAs both
-- choosing 1234 is not a hypothetical, and without this the check-in RPC would
-- have to pick one of them. Partial, so a closed session keeps its PIN for the
-- record without blocking reuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_open_pin
  ON public.class_sessions (upper(btrim(pin)))
  WHERE status = 'open' AND pin IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- Resolve session_date from starts_at in the owning class's timezone, and keep
-- the denormalised class_id honest against cohort_id.
CREATE OR REPLACE FUNCTION public.set_session_class_and_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_class_id uuid;
  v_timezone text;
BEGIN
  SELECT c.class_id, k.timezone
    INTO v_class_id, v_timezone
  FROM public.cohorts c
  JOIN public.classes k ON k.id = c.class_id
  WHERE c.id = NEW.cohort_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', NEW.cohort_id;
  END IF;

  IF NEW.class_id IS NULL THEN
    NEW.class_id := v_class_id;
  ELSIF NEW.class_id IS DISTINCT FROM v_class_id THEN
    RAISE EXCEPTION
      'session class_id % disagrees with the class of cohort % (which is %)',
      NEW.class_id, NEW.cohort_id, v_class_id;
  END IF;

  NEW.session_date := (NEW.starts_at AT TIME ZONE v_timezone)::date;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_sessions_set_class_and_date ON public.class_sessions;
CREATE TRIGGER trg_sessions_set_class_and_date
  BEFORE INSERT OR UPDATE OF starts_at, cohort_id, class_id ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_session_class_and_date();

-- Stamp the lifecycle timestamps from the status, so no code path can move a
-- session to closed without recording when.
CREATE OR REPLACE FUNCTION public.stamp_session_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'open'      AND NEW.opened_at    IS NULL THEN NEW.opened_at    := now(); END IF;
    IF NEW.status = 'closed'    AND NEW.closed_at    IS NULL THEN NEW.closed_at    := now(); END IF;
    IF NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;

    -- A session that is no longer open must not hold a PIN that could still be
    -- matched. Belt and braces alongside the partial index.
    IF OLD.status = 'open' AND NEW.status <> 'open' THEN
      NEW.pin := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_sessions_lifecycle ON public.class_sessions;
CREATE TRIGGER trg_sessions_lifecycle
  BEFORE UPDATE ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_session_lifecycle();

-- ----------------------------------------------------------------------------
-- generate_sessions — expand a schedule into rows
--
-- Re-runnable: ON CONFLICT DO NOTHING, so adding a weekday and regenerating adds
-- the new sessions without disturbing any that already exist. Returns how many
-- it created, which the UI reports as "created N, skipped M".
--
-- Defaults to the class's own term when no range is given.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_sessions(
  p_class_id  uuid,
  p_cohort_id uuid DEFAULT NULL,
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class   public.classes%ROWTYPE;
  v_from    date;
  v_to      date;
  v_created integer := 0;
BEGIN
  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  v_from := COALESCE(p_from, v_class.term_starts_on);
  v_to   := COALESCE(p_to,   v_class.term_ends_on);

  IF v_to < v_from THEN
    RAISE EXCEPTION 'generate_sessions: % is before %', v_to, v_from;
  END IF;

  WITH candidate AS (
    SELECT
      s.id   AS schedule_id,
      s.cohort_id,
      d::date AS on_date,
      -- Build the instant from the class's own wall clock, not the server's.
      ((d::date + s.start_time) AT TIME ZONE v_class.timezone) AS starts_at,
      COALESCE(s.duration_minutes, v_class.default_duration_minutes) AS duration_minutes,
      COALESCE(s.delivery_mode,    v_class.default_delivery_mode)    AS delivery_mode
    FROM public.cohort_schedules s
    CROSS JOIN LATERAL generate_series(v_from, v_to, INTERVAL '1 day') AS d
    WHERE s.class_id = p_class_id
      AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
      AND EXTRACT(DOW FROM d)::smallint = s.weekday
      AND (s.effective_from  IS NULL OR d::date >= s.effective_from)
      AND (s.effective_until IS NULL OR d::date <= s.effective_until)
  ),
  inserted AS (
    INSERT INTO public.class_sessions (
      class_id, cohort_id, schedule_id, starts_at, session_date,
      duration_minutes, delivery_mode, status, method,
      late_window_minutes, auto_close_minutes, early_open_minutes
    )
    SELECT
      p_class_id, c.cohort_id, c.schedule_id, c.starts_at, c.on_date,
      c.duration_minutes, c.delivery_mode, 'scheduled', v_class.default_method,
      v_class.default_late_window_minutes,
      v_class.default_auto_close_minutes,
      v_class.default_early_open_minutes
    FROM candidate c
    ON CONFLICT (cohort_id, starts_at) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN v_created;
END;
$fn$;

REVOKE ALL ON FUNCTION public.generate_sessions(uuid, uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_sessions(uuid, uuid, date, date) TO authenticated;

-- ----------------------------------------------------------------------------
-- open_session / close_session live in 003, because closing is what writes the
-- absence records and that needs attendance_records to exist first.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- RLS — house pattern
-- ----------------------------------------------------------------------------

DO $rls$
DECLARE
  t text;
  tables text[] := ARRAY['cohort_schedules', 'class_sessions'];
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

-- The live dashboard needs to see sessions open and close. Adding the table to
-- the publication here so the realtime subscription can be moved off
-- present_students later without a second migration.
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'class_sessions')
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.class_sessions;
  END IF;
END
$pub$;
