-- ============================================================================
-- 007 — class management
--
-- Everything a TA does to a class that is not taking attendance: edit it, add a
-- cohort, set when a cohort meets, upload a roster, archive it, delete it.
--
-- create_class already landed in 003, because the RLS work needed it there.
--
-- All SECURITY DEFINER and granted to authenticated only. Each one checks
-- permission itself, since running as the owner means RLS does not constrain
-- them from the inside.
--
-- Run AFTER 006. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- can_manage_class — a narrower permission than can_access_class
--
-- Running a session and deleting the class it belongs to are not the same
-- authority. A TA added to a class can open and close its sessions; only the
-- owner (or an admin) can rename it, restructure its cohorts, or destroy it.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_manage_class(p_class_id uuid)
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
          AND cs.role IN ('owner', 'supervisor')
      )
    );
$fn$;

REVOKE ALL ON FUNCTION public.can_manage_class(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.can_manage_class(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- update_class — NULL means "leave alone"
--
-- Every parameter is optional so the UI can send only what changed, rather than
-- reading the row, mutating it and writing it back — which loses whatever
-- another TA altered in between.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_class(
  p_class_id                  uuid,
  p_name                      text    DEFAULT NULL,
  p_description               text    DEFAULT NULL,
  p_term_starts_on            date    DEFAULT NULL,
  p_term_ends_on              date    DEFAULT NULL,
  p_timezone                  text    DEFAULT NULL,
  p_min_attendance_percentage numeric DEFAULT NULL,
  p_default_duration_minutes  integer DEFAULT NULL,
  p_default_late_window_minutes integer DEFAULT NULL,
  p_default_auto_close_minutes  integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  UPDATE public.classes
     SET name                        = COALESCE(NULLIF(btrim(p_name), ''), name),
         description                 = COALESCE(p_description, description),
         term_starts_on              = COALESCE(p_term_starts_on, term_starts_on),
         term_ends_on                = COALESCE(p_term_ends_on, term_ends_on),
         timezone                    = COALESCE(NULLIF(btrim(p_timezone), ''), timezone),
         min_attendance_percentage   = COALESCE(p_min_attendance_percentage, min_attendance_percentage),
         default_duration_minutes    = COALESCE(p_default_duration_minutes, default_duration_minutes),
         default_late_window_minutes = COALESCE(p_default_late_window_minutes, default_late_window_minutes),
         default_auto_close_minutes  = COALESCE(p_default_auto_close_minutes, default_auto_close_minutes)
   WHERE id = p_class_id
  RETURNING * INTO v_class;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  RETURN to_jsonb(v_class);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- add_cohort
--
-- Cohorts are only ever added here. Removing one is a separate, destructive
-- action, because by the time you want to it has enrolments and sessions
-- hanging off it — "change the cohort count from 3 to 2" is not an edit, it is
-- a deletion wearing an edit's clothes.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_cohort(
  p_class_id uuid,
  p_label    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF btrim(COALESCE(p_label, '')) = '' THEN
    RAISE EXCEPTION 'a cohort needs a label';
  END IF;

  INSERT INTO public.cohorts (class_id, label)
  VALUES (p_class_id, btrim(p_label))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('cohort_id', v_id, 'label', btrim(p_label));
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'this class already has a cohort labelled %', btrim(p_label);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- set_cohort_schedule — replace a cohort's meeting pattern atomically
--
-- Replaces the client-side delete-then-insert at TADashboard.tsx:1402, which
-- runs as two separate requests: if the second fails, the cohort is left with
-- no schedule at all and nothing says so.
--
-- Sessions already generated are untouched. They carry their own copy of the
-- timing, so changing the pattern never silently rewrites what already happened.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_cohort_schedule(
  p_cohort_id        uuid,
  p_weekdays         smallint[],
  p_start_time       time,
  p_duration_minutes integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class_id uuid;
  v_created  integer;
BEGIN
  SELECT class_id INTO v_class_id FROM public.cohorts WHERE id = p_cohort_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', p_cohort_id;
  END IF;

  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF p_weekdays IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_weekdays) w WHERE w < 0 OR w > 6)
  THEN
    RAISE EXCEPTION 'weekdays must be between 0 (Sunday) and 6 (Saturday)';
  END IF;

  DELETE FROM public.cohort_schedules WHERE cohort_id = p_cohort_id;

  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time, duration_minutes)
  SELECT v_class_id, p_cohort_id, w, p_start_time, p_duration_minutes
  FROM unnest(COALESCE(p_weekdays, ARRAY[]::smallint[])) w
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_created = ROW_COUNT;
  RETURN v_created;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- upsert_enrolments — the roster upload, with dedupe
--
-- One call, not a loop. A two-hundred-student CSV as client-side round trips is
-- four hundred requests with no atomicity, and a failure halfway leaves a
-- half-enrolled class.
--
-- The dedupe rule that makes `students` a person registry: a student_id that
-- already exists is REUSED, never duplicated, so uploading a roster for a second
-- class enrols the same person rather than colliding on the primary key.
--
-- Names are filled in, never overwritten. Students are global, so one TA's CSV
-- must not rename another course's student because their spreadsheet is stale.
--
-- A student already in a DIFFERENT cohort of this class is reported rather than
-- moved, unless p_move_existing says otherwise — moving someone changes which
-- sessions they are absent from, which is not a thing to do by accident.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.upsert_enrolments(
  p_cohort_id     uuid,
  p_rows          jsonb,
  p_move_existing boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class_id   uuid;
  n_created    integer := 0;
  n_reused     integer := 0;
  n_enrolled   integer := 0;
  n_already    integer := 0;
  n_moved      integer := 0;
  v_other      jsonb   := '[]'::jsonb;
  v_invalid    jsonb   := '[]'::jsonb;
BEGIN
  SELECT class_id INTO v_class_id FROM public.cohorts WHERE id = p_cohort_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', p_cohort_id;
  END IF;

  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  -- Normalise and reject unusable rows up front, so the counts below describe
  -- only rows that were genuinely actionable.
  --
  -- Dropped explicitly rather than relying on ON COMMIT DROP alone: that only
  -- fires at commit, so two calls inside one transaction would collide on the
  -- second CREATE. Supabase gives each RPC its own transaction, but a caller
  -- batching two cohorts should not hit an error about a temp table.
  DROP TABLE IF EXISTS tmp_roster;

  CREATE TEMP TABLE tmp_roster ON COMMIT DROP AS
  SELECT
    btrim(COALESCE(r ->> 'student_id', '')) AS student_id,
    NULLIF(btrim(COALESCE(r ->> 'name', '')), '') AS name,
    ord
  FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS t(r, ord);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('row', ord, 'reason', 'blank student ID')), '[]'::jsonb)
    INTO v_invalid
  FROM tmp_roster WHERE student_id = '';

  -- The same ID twice in one file: keep the first, report the rest. Silently
  -- collapsing them would hide a copy-paste error in the spreadsheet.
  v_invalid := v_invalid || COALESCE((
    SELECT jsonb_agg(jsonb_build_object('row', ord, 'reason',
                                        'duplicate of an earlier row: ' || student_id))
    FROM (
      SELECT student_id, ord,
             row_number() OVER (PARTITION BY upper(student_id) ORDER BY ord) AS rn
      FROM tmp_roster WHERE student_id <> ''
    ) d WHERE rn > 1), '[]'::jsonb);

  DELETE FROM tmp_roster
  WHERE student_id = ''
     OR ord IN (
       SELECT ord FROM (
         SELECT ord, row_number() OVER (PARTITION BY upper(student_id) ORDER BY ord) AS rn
         FROM tmp_roster WHERE student_id <> ''
       ) d WHERE rn > 1);

  -- How many of these people the registry already knows.
  SELECT count(*) INTO n_reused
  FROM tmp_roster t
  WHERE EXISTS (SELECT 1 FROM public.students s WHERE s.student_id = t.student_id);

  n_created := (SELECT count(*) FROM tmp_roster) - n_reused;

  -- Fill a missing name; never replace one that is already there.
  INSERT INTO public.students (student_id, cohort, name)
  SELECT t.student_id, '', t.name
  FROM tmp_roster t
  ON CONFLICT (student_id) DO UPDATE
    SET name = COALESCE(public.students.name, EXCLUDED.name);

  -- Already in this cohort.
  SELECT count(*) INTO n_already
  FROM tmp_roster t
  JOIN public.enrolments e
    ON e.student_id = t.student_id AND e.cohort_id = p_cohort_id;

  -- In a different cohort of the SAME class. UNIQUE (class_id, student_id)
  -- means they cannot simply be added; either move them or leave them.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'student_id', t.student_id, 'current_cohort', co.label)), '[]'::jsonb)
    INTO v_other
  FROM tmp_roster t
  JOIN public.enrolments e
    ON e.student_id = t.student_id AND e.class_id = v_class_id
   AND e.cohort_id <> p_cohort_id
  JOIN public.cohorts co ON co.id = e.cohort_id;

  IF p_move_existing THEN
    WITH moved AS (
      UPDATE public.enrolments e
         SET cohort_id = p_cohort_id
        FROM tmp_roster t
       WHERE e.student_id = t.student_id
         AND e.class_id = v_class_id
         AND e.cohort_id <> p_cohort_id
      RETURNING 1
    )
    SELECT count(*) INTO n_moved FROM moved;
    v_other := '[]'::jsonb;
  END IF;

  WITH added AS (
    INSERT INTO public.enrolments (class_id, cohort_id, student_id)
    SELECT v_class_id, p_cohort_id, t.student_id
    FROM tmp_roster t
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_enrolled FROM added;

  RETURN jsonb_build_object(
    'created_students', n_created,
    'reused_students',  n_reused,
    'enrolled',         n_enrolled,
    'already_enrolled', n_already,
    'moved',            n_moved,
    'in_other_cohort',  v_other,
    'invalid',          v_invalid
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- archive_class — the reversible one
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_class(
  p_class_id uuid,
  p_archived boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  UPDATE public.classes
     SET archived_at = CASE WHEN p_archived THEN COALESCE(archived_at, now()) ELSE NULL END
   WHERE id = p_class_id
  RETURNING * INTO v_class;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  RETURN to_jsonb(v_class);
END;
$fn$;

-- ----------------------------------------------------------------------------
-- preview_class_deletion — what you are about to destroy
--
-- students_left_orphaned is the number that matters and the one nobody thinks
-- to ask for: students whose ONLY enrolment is this class. Deleting it leaves
-- them in the registry attached to nothing. It never deletes them — a person is
-- not owned by a course — but you should know before, not after.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_class_deletion(p_class_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class public.classes%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to delete this class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  RETURN jsonb_build_object(
    'class_id', v_class.id,
    'code',     v_class.code,
    'name',     v_class.name,
    'cohorts',
      (SELECT count(*) FROM public.cohorts WHERE class_id = p_class_id),
    'enrolments',
      (SELECT count(*) FROM public.enrolments WHERE class_id = p_class_id),
    'sessions',
      (SELECT count(*) FROM public.class_sessions WHERE class_id = p_class_id),
    'attendance_records',
      (SELECT count(*) FROM public.attendance_records WHERE class_id = p_class_id),
    'students_left_orphaned', (
      SELECT count(*)
      FROM (
        SELECT e.student_id
        FROM public.enrolments e
        WHERE e.class_id = p_class_id
        GROUP BY e.student_id
        HAVING NOT EXISTS (
          SELECT 1 FROM public.enrolments o
          WHERE o.student_id = e.student_id AND o.class_id <> p_class_id)
      ) x)
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- delete_class — irreversible, and gated on typing the code back
--
-- The confirmation is the class's own code rather than a boolean, because a
-- boolean is a thing a client can pass by accident and a code is not. This is
-- why classes.code is unique case-insensitively.
--
-- Never touches `students`. A person exists independently of any course they
-- took; deleting the course must not delete them from every other one.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_class(
  p_class_id     uuid,
  p_confirm_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_summary  jsonb;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to delete this class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF lower(btrim(COALESCE(p_confirm_code, ''))) <> lower(btrim(v_class.code)) THEN
    RAISE EXCEPTION
      'confirmation does not match: type the class code (%) exactly', v_class.code;
  END IF;

  v_summary := public.preview_class_deletion(p_class_id);

  -- Cohorts, enrolments, schedules, sessions, attendance and staff links all go
  -- by cascade. students does not, and has no cascade from here by design.
  DELETE FROM public.classes WHERE id = p_class_id;

  RETURN jsonb_build_object('deleted', true, 'summary', v_summary);
END;
$fn$;

DO $grants$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.update_class(uuid, text, text, date, date, text, numeric, integer, integer, integer)',
    'public.add_cohort(uuid, text)',
    'public.set_cohort_schedule(uuid, smallint[], time, integer)',
    'public.upsert_enrolments(uuid, jsonb, boolean)',
    'public.archive_class(uuid, boolean)',
    'public.preview_class_deletion(uuid)',
    'public.delete_class(uuid, text)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
  END LOOP;
END
$grants$;

COMMENT ON FUNCTION public.upsert_enrolments(uuid, jsonb, boolean) IS
  'Roster upload. Reuses an existing student_id rather than duplicating it, so '
  'a student can be enrolled in several classes. Fills a missing name but never '
  'overwrites one. Reports students already in another cohort of the same class '
  'rather than moving them, unless asked.';
