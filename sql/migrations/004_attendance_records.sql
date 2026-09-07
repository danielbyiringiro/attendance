-- ============================================================================
-- 004 — attendance records
--
-- The hinge of the whole migration. Today absence is not stored: it is
-- recomputed in the browser, every time it is needed, from presence records
-- plus a guess at which days counted as class days. Two separate copies of that
-- derivation exist (buildWeeklyReport and attendanceExport), they disagree with
-- each other, and neither can be right about a day nobody attended.
--
-- After this, every state — including absence — is written once, against a
-- specific session, and read back. close_session() is where that happens: it
-- materialises an explicit 'unexcused' row for everyone who was enrolled and
-- did not mark. That single function is what makes the derivation deletable.
--
-- Run AFTER 003. Idempotent. Still no app behaviour change: the table is empty
-- until 005 backfills it, and nothing reads it until 006.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- attendance_records
--
-- UNIQUE (session_id, student_id) is the constraint present_students never had.
-- Its absence is why the check-in RPC has to do a read-then-insert, why the
-- exporter has to dedupe defensively, and why the fixture can contain the same
-- student twice on one day.
--
-- class_id is denormalised from the session so the RLS policy stays a single
-- predicate. Without it every row read would need a subquery into
-- class_sessions, on the largest table in the schema.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES public.class_sessions(id) ON DELETE CASCADE,
  class_id       uuid NOT NULL REFERENCES public.classes(id)        ON DELETE CASCADE,
  student_id     text NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,

  state          public.attendance_state NOT NULL,
  marked_at      timestamptz NOT NULL DEFAULT now(),
  -- auth.users.id of whoever caused this, when there was one. A student
  -- self-check-in has no staff behind it; close_session has nobody at all.
  marked_by      uuid,
  marked_by_role public.actor_role NOT NULL DEFAULT 'student',
  method_used    public.attendance_method,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT attendance_records_one_per_session UNIQUE (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_session ON public.attendance_records (session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON public.attendance_records (student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_class   ON public.attendance_records (class_id);
-- The shape the exporter reads: one class, one state, over a range of sessions.
CREATE INDEX IF NOT EXISTS idx_attendance_class_state
  ON public.attendance_records (class_id, state);

-- ----------------------------------------------------------------------------
-- attendance_corrections — an audit trail that cannot be forgotten
--
-- A trigger, not a convention. Anything that changes a state writes a
-- correction, including a direct UPDATE from the SQL editor, so no future code
-- path can quietly alter attendance. The UI for reviewing these is deferred;
-- the record is not, because history cannot be reconstructed later.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.attendance_corrections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id      uuid NOT NULL REFERENCES public.attendance_records(id) ON DELETE CASCADE,
  class_id       uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  previous_state public.attendance_state NOT NULL,
  new_state      public.attendance_state NOT NULL,
  corrected_by   uuid,
  corrected_at   timestamptz NOT NULL DEFAULT now(),
  reason         text
);

CREATE INDEX IF NOT EXISTS idx_corrections_record ON public.attendance_corrections (record_id);
CREATE INDEX IF NOT EXISTS idx_corrections_class  ON public.attendance_corrections (class_id);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- Fill class_id from the session, and refuse a record whose class disagrees.
CREATE OR REPLACE FUNCTION public.set_attendance_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_class_id uuid;
BEGIN
  SELECT class_id INTO v_class_id
  FROM public.class_sessions WHERE id = NEW.session_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'session % does not exist', NEW.session_id;
  END IF;

  IF NEW.class_id IS NULL THEN
    NEW.class_id := v_class_id;
  ELSIF NEW.class_id IS DISTINCT FROM v_class_id THEN
    RAISE EXCEPTION
      'attendance class_id % disagrees with the class of session % (which is %)',
      NEW.class_id, NEW.session_id, v_class_id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_attendance_set_class ON public.attendance_records;
CREATE TRIGGER trg_attendance_set_class
  BEFORE INSERT OR UPDATE ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.set_attendance_class();

CREATE OR REPLACE FUNCTION public.log_attendance_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.attendance_corrections (
    record_id, class_id, previous_state, new_state, corrected_by
  )
  VALUES (NEW.id, NEW.class_id, OLD.state, NEW.state, auth.uid());
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_attendance_log_correction ON public.attendance_records;
CREATE TRIGGER trg_attendance_log_correction
  AFTER UPDATE OF state ON public.attendance_records
  FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION public.log_attendance_correction();

-- ----------------------------------------------------------------------------
-- open_session
--
-- Opening is an explicit act, which is what lets several classes run at once —
-- the singleton session_state row could only ever describe one.
--
-- starts_at is deliberately NOT rewritten. It is the scheduled time and the
-- schedule view needs it. Lateness is measured from opened_at instead, so a TA
-- who opens twenty minutes behind does not mark the whole room late.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.open_session(
  p_session_id uuid,
  p_pin        text    DEFAULT NULL,
  p_minutes    integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_pin     text;
  -- No O/0/I/1: these get read aloud and typed by a room full of people.
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_try     integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to open a session for this class';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RAISE EXCEPTION 'this session was cancelled; uncancel it before opening';
  END IF;

  IF p_pin IS NOT NULL AND btrim(p_pin) <> '' THEN
    UPDATE public.class_sessions
       SET status = 'open',
           pin = btrim(p_pin),
           auto_close_minutes = COALESCE(p_minutes, auto_close_minutes),
           opened_at = now()
     WHERE id = p_session_id;
  ELSE
    -- Retry against the partial unique index on open PINs rather than assuming
    -- a random five characters is free.
    LOOP
      v_try := v_try + 1;
      SELECT string_agg(substr(v_alphabet, (floor(random() * length(v_alphabet))::int + 1), 1), '')
        INTO v_pin
      FROM generate_series(1, 5);

      BEGIN
        UPDATE public.class_sessions
           SET status = 'open',
               pin = v_pin,
               auto_close_minutes = COALESCE(p_minutes, auto_close_minutes),
               opened_at = now()
         WHERE id = p_session_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_try >= 10 THEN
          RAISE EXCEPTION 'could not find a free PIN after % attempts', v_try;
        END IF;
      END;
    END LOOP;
  END IF;

  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'session_id', v_session.id,
    'pin',        v_session.pin,
    'opened_at',  v_session.opened_at,
    'closes_at',  v_session.opened_at + make_interval(mins => v_session.auto_close_minutes)
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- close_session — THE function that makes absence stored rather than derived
--
-- Everyone enrolled in the session's cohort who has no record gets an explicit
-- 'unexcused' row. From here on, "was this student absent" is a lookup, not a
-- calculation over presence plus a guess about the calendar.
--
-- Enrolment dates are honoured: a student who joined after this session, or
-- left before it, is not marked absent for a day they were not on the roster.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_session(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_marked  integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to close a session for this class';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled session has no attendance to record';
  END IF;

  WITH absentees AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT v_session.id, v_session.class_id, e.student_id, 'unexcused', now(), 'system'
    FROM public.enrolments e
    WHERE e.cohort_id = v_session.cohort_id
      AND e.enrolled_on <= v_session.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date)
    ON CONFLICT (session_id, student_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_marked FROM absentees;

  UPDATE public.class_sessions
     SET status = 'closed'
   WHERE id = p_session_id;

  RETURN v_marked;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- cancel_session
--
-- An act on this one session row. Today cancelling is an upsert into
-- cancelled_sessions keyed (date, cohort) which the weekly report then reads by
-- date alone, so cancelling one cohort's Wednesday cancels everybody's.
--
-- Removes unexcused and pending records, so a cancelled class cannot drag an
-- attendance percentage down. Present and excused rows are kept: somebody did
-- turn up, and erasing that would be a lie about the past.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_session(
  p_session_id uuid,
  p_reason     text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_session public.class_sessions%ROWTYPE;
  v_removed integer := 0;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', p_session_id;
  END IF;

  IF NOT public.can_access_class(v_session.class_id) THEN
    RAISE EXCEPTION 'not permitted to cancel a session for this class';
  END IF;

  WITH removed AS (
    DELETE FROM public.attendance_records
    WHERE session_id = p_session_id
      AND state IN ('unexcused', 'pending')
    RETURNING 1
  )
  SELECT count(*) INTO v_removed FROM removed;

  UPDATE public.class_sessions
     SET status = 'cancelled',
         cancellation_reason = COALESCE(p_reason, cancellation_reason)
   WHERE id = p_session_id;

  RETURN v_removed;
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.open_session(uuid, text, integer)',
    'public.close_session(uuid)',
    'public.cancel_session(uuid, text)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

-- ----------------------------------------------------------------------------
-- RLS — scoped by class, like everything since 003
-- ----------------------------------------------------------------------------

DO $rls$
DECLARE
  t text;
  tables text[] := ARRAY['attendance_records', 'attendance_corrections'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_scoped ON public.%I;', t, t);
    EXECUTE format(
      'CREATE POLICY %I_scoped ON public.%I FOR ALL TO authenticated '
      'USING (public.can_access_class(class_id)) '
      'WITH CHECK (public.can_access_class(class_id));', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END
$rls$;

-- The live roster view needs to see marks land. The current dashboard subscribes
-- to present_students; this is what it moves onto.
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'attendance_records')
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
  END IF;
END
$pub$;

COMMENT ON TABLE public.attendance_records IS
  'One row per student per session. Absence is stored here as an explicit '
  'unexcused state written by close_session(), not derived from the absence of '
  'a presence row.';

COMMENT ON TABLE public.attendance_corrections IS
  'Append-only audit of every state change, written by a trigger so no code '
  'path can skip it. Review UI is deferred; the history is not.';
