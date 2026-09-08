-- ============================================================================
-- 016 — a flag belongs to a class
--
-- `flagged` predates the class model and never gained a class. Three faults
-- follow from that, and they compound:
--
--   1. NO ROW LEVEL SECURITY AT ALL. Every other table hanging off a class got
--      a `_scoped` policy in 003; flagged was never in that list, so it has sat
--      open. Any authenticated account can read and write every dispute in the
--      installation, including for classes they have no access to.
--
--   2. The review screen shows every flag in the database, so one class's
--      disputes appear in another's. The student's NAME resolves from the
--      roster of the class being viewed and comes back empty, but their ID is
--      rendered regardless — so a TA sees a bare student number they have no
--      business seeing, attached to a class that is not theirs.
--
--   3. flag_attendance resolves the session with ORDER BY starts_at LIMIT 1
--      across every class the student is enrolled in. A student taking two
--      courses that both meet on the disputed day gets whichever starts
--      earlier, silently, and the dispute lands on the wrong class.
--
-- This adds class_id, backfills it, scopes the table, and gives the student
-- screen a way to say WHICH session it is disputing rather than leaving the
-- server to guess from a date.
--
-- Run AFTER 015. Idempotent.
-- ============================================================================

ALTER TABLE public.flagged
  ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES public.classes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_flagged_class ON public.flagged (class_id);

-- ----------------------------------------------------------------------------
-- Backfill
-- ----------------------------------------------------------------------------

DO $backfill$
DECLARE
  n_from_session integer := 0;
  n_from_date    integer := 0;
  n_unresolved   integer := 0;
BEGIN
  -- Where the flag already points at a session, the class is not in doubt.
  WITH filled AS (
    UPDATE public.flagged f
       SET class_id = s.class_id
      FROM public.class_sessions s
     WHERE s.id = f.session_id
       AND f.class_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO n_from_session FROM filled;

  -- Older flags carry only a date. Resolve them only when the student was
  -- enrolled in exactly ONE class that had a session that day: anything else
  -- is a guess, and a guess here files somebody's dispute against a class it
  -- does not belong to.
  WITH candidate AS (
    SELECT f.id AS flag_id,
           -- min() has no uuid overload; cast to text to pick one
           -- deterministically, and only use it when there is exactly one.
           (min(s.class_id::text))::uuid AS class_id,
           (min(s.id::text))::uuid       AS session_id,
           count(DISTINCT s.class_id)    AS classes
    FROM public.flagged f
    JOIN public.enrolments e ON e.student_id = f.student_id
    JOIN public.class_sessions s
      ON s.cohort_id = e.cohort_id
     AND s.session_date = f.session_date
    WHERE f.class_id IS NULL
    GROUP BY f.id
  ),
  filled AS (
    UPDATE public.flagged f
       SET class_id   = c.class_id,
           session_id = COALESCE(f.session_id, c.session_id)
      FROM candidate c
     WHERE c.flag_id = f.id
       AND c.classes = 1
    RETURNING 1
  )
  SELECT count(*) INTO n_from_date FROM filled;

  SELECT count(*) INTO n_unresolved
  FROM public.flagged WHERE class_id IS NULL;

  RAISE NOTICE
    '016: % flag(s) resolved from their session, % from an unambiguous date, % left unresolved',
    n_from_session, n_from_date, n_unresolved;

  IF n_unresolved > 0 THEN
    -- Deliberately not an exception. A flag nobody can attribute is a real
    -- thing that exists in the data; it must stop being visible to the wrong
    -- people, which the policy below does, rather than block the migration.
    RAISE WARNING
      '% flag(s) could not be attributed to a class — either the student is no '
      'longer enrolled anywhere with a session on that date, or they were in '
      'two classes that both met. They are now visible to nobody. Find them '
      'with: SELECT * FROM public.flagged WHERE class_id IS NULL;', n_unresolved;
  END IF;
END
$backfill$;

-- ----------------------------------------------------------------------------
-- Row level security — the policy 003 should have given it
--
-- A NULL class_id fails can_access_class and so is visible to nobody. That is
-- the intended outcome for an unattributable flag: better invisible than shown
-- to the wrong TA.
-- ----------------------------------------------------------------------------

ALTER TABLE public.flagged ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flagged_auth_all ON public.flagged;
DROP POLICY IF EXISTS flagged_scoped   ON public.flagged;

CREATE POLICY flagged_scoped ON public.flagged
  FOR ALL TO authenticated
  USING (public.can_access_class(class_id))
  WITH CHECK (public.can_access_class(class_id));

-- Students never touch this table directly; they go through flag_attendance,
-- which is SECURITY DEFINER.
REVOKE ALL ON public.flagged FROM anon;

-- ----------------------------------------------------------------------------
-- Two flags for the same student and session are one flag
--
-- flag_attendance guarded against a duplicate by reading first and inserting
-- after, which is racy by construction. This makes the database say it.
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_flagged_one_per_session
  ON public.flagged (student_id, session_id)
  WHERE session_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- flag_attendance(student, session) — the student says which session
--
-- The screen has had session_id for every row it renders since it started
-- reading `sessions`. Passing it removes the guess entirely: no ordering by
-- start time, no ambiguity when somebody takes two courses that meet the same
-- day, and the class comes from the session rather than being inferred.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.flag_attendance(
  p_student_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_student_id text := btrim(p_student_id);
  v_session    public.class_sessions%ROWTYPE;
  v_status     text;
BEGIN
  SELECT * INTO v_session FROM public.class_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_such_session');
  END IF;

  -- Only a session of a cohort they are actually in. Without this the endpoint
  -- would accept a flag against any session id somebody cared to send.
  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = v_student_id
      AND e.cohort_id = v_session.cohort_id
      AND e.enrolled_on <= v_session.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= v_session.session_date)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_your_session');
  END IF;

  SELECT status INTO v_status
  FROM public.flagged
  WHERE student_id = v_student_id AND session_id = p_session_id;

  IF v_status = 'denied' THEN
    RETURN jsonb_build_object('success', false, 'error', 'denied');
  END IF;
  IF v_status IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_pending');
  END IF;

  INSERT INTO public.flagged (student_id, session_date, status, session_id, class_id)
  VALUES (v_student_id, v_session.session_date, 'flagged', p_session_id, v_session.class_id)
  ON CONFLICT (student_id, session_id) WHERE session_id IS NOT NULL DO NOTHING;

  RETURN jsonb_build_object(
    'success', true, 'session_id', p_session_id, 'class_id', v_session.class_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.flag_attendance(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.flag_attendance(text, uuid) TO anon, authenticated;

-- The date-based version is dropped rather than left beside the new one. It
-- cannot be made correct — a date does not identify a session for a student in
-- two classes — and leaving it would let a stale client keep filing disputes
-- against whichever class happened to start earlier.
DROP FUNCTION IF EXISTS public.flag_attendance(text, date);

COMMENT ON FUNCTION public.flag_attendance(text, uuid) IS
  'A student disputes their attendance at one session. Takes the session id, '
  'not a date: a date does not identify a session for somebody enrolled in two '
  'classes that both meet that day.';

-- ----------------------------------------------------------------------------
-- get_student_attendance — a flag names its session too
--
-- The screen keyed its flag lookup by date. A student in two classes has two
-- rows on the same date, so a dispute raised against one of them marked both.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_date', f.session_date,
                 'session_id',   f.session_id,
                 'status',       f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb),
    -- Cancelled sessions are included and labelled, so the screen can show
    -- "no class" instead of silently omitting the day.
    'sessions', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'session_id',   s.id,
                 'date',         s.session_date,
                 'class',        k.name,
                 'class_code',   k.code,
                 'cohort',       co.label,
                 'status',       s.status,
                 'state',        ar.state,
                 'marked_at',    ar.marked_at)
               ORDER BY s.session_date DESC)
      FROM public.class_sessions s
      JOIN public.cohorts co ON co.id = s.cohort_id
      JOIN public.classes k  ON k.id  = s.class_id
      JOIN public.enrolments e
        ON e.cohort_id = s.cohort_id
       AND e.student_id = p_student_id
       AND e.enrolled_on <= s.session_date
       AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date)
      LEFT JOIN public.attendance_records ar
        ON ar.session_id = s.id AND ar.student_id = p_student_id
      WHERE s.status <> 'scheduled'), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;
