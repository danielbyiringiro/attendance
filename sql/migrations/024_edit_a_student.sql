-- ============================================================================
-- 024 — correct a student's name
--
-- A name arrives from whatever roster was uploaded, and rosters are wrong:
-- misspelt, truncated, surname-first, or missing entirely because the export
-- had no name column. The TA looking at the student's record in Analytics is
-- the person who knows, so that is where the correction belongs.
--
-- WHAT MAY BE CHANGED, AND WHAT MAY NOT
--
-- The name, and only the name.
--
-- student_id is the join key. enrolments and attendance_records both reference
-- it with ON DELETE CASCADE and no ON UPDATE CASCADE, so an UPDATE would be
-- refused by the foreign keys — and if it were not, it would silently strand
-- every attendance row the student already has. Correcting a mistyped ID is a
-- real need and a genuinely different operation: it has to decide what happens
-- to existing attendance, and it deserves its own migration rather than being
-- smuggled in beside a rename.
--
-- WHO MAY DO IT
--
-- students is a GLOBAL registry — one row per person, shared by every class
-- they take. So a rename is not a local edit: fixing a spelling for CS254
-- changes it for every other course too.
--
-- The rule is therefore that you may rename somebody you teach: the caller
-- must manage at least one class the student is enrolled in. Not "any class",
-- which would let any TA rename anyone in the institution, and not "this
-- class", which cannot be expressed — the row is not per-class.
--
-- This is the same reason upsert_enrolments fills a missing name but never
-- overwrites one. A bulk upload must not rename other people's students; a
-- person looking at one student and typing may.
--
-- Run AFTER 023. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_student(
  p_student_id text,
  p_name       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id      text := btrim(COALESCE(p_student_id, ''));
  v_name    text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_student public.students%ROWTYPE;
BEGIN
  IF v_id = '' THEN
    RAISE EXCEPTION 'no student given';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students s WHERE s.student_id = v_id) THEN
    RAISE EXCEPTION 'no such student';
  END IF;

  -- Enrolled in a class this person manages. Checked before anything is said
  -- about the student, so this is not a way to ask whether an ID exists.
  IF NOT EXISTS (
    SELECT 1
    FROM public.enrolments e
    WHERE e.student_id = v_id
      AND public.can_manage_class(e.class_id)
  ) THEN
    RAISE EXCEPTION 'not permitted to edit this student';
  END IF;

  UPDATE public.students
     SET name = v_name
   WHERE student_id = v_id
  RETURNING * INTO v_student;

  RETURN jsonb_build_object(
    'student_id', v_student.student_id,
    'name',       v_student.name);
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_student(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.update_student(text, text) TO authenticated;

COMMENT ON FUNCTION public.update_student(text, text) IS
  'Correct a student''s name. Permitted to anyone who manages a class the '
  'student is enrolled in. students is a global registry, so this changes the '
  'name in every class they take — which is why it is a deliberate single '
  'edit and not something a roster upload may do. student_id is not editable: '
  'it is the join key for every attendance record.';

-- ============================================================================
-- Correcting a mistyped student ID
--
-- A roster can carry the wrong ID for somebody — the wrong column was mapped,
-- or the registry itself has a typo. The symptom is not an error: the student
-- types their real ID at check-in, nothing matches, and they are marked absent
-- all term while appearing perfectly present on the roster.
--
-- So the ID has to be correctable, and the correction has to take their
-- history with them. It is not a new person.
--
-- WHY THIS NEEDED A SCHEMA CHANGE
--
-- students.student_id is the primary key and everything references it, but
-- every one of those foreign keys was declared ON DELETE CASCADE and nothing
-- else — meaning ON UPDATE NO ACTION. An UPDATE of the key was therefore
-- refused outright by the first dependent row.
--
-- legacy.excused_absences matters here too. It is retired and unread, but its
-- foreign key still points at public.students, so it would have blocked the
-- update just as effectively as a live table.
--
-- The loop below finds every foreign key referencing public.students, whatever
-- schema it lives in, and rebuilds it with ON UPDATE CASCADE. Discovered
-- rather than named, so a table added later is covered without anyone
-- remembering this file. It skips constraints that already cascade, which is
-- what makes re-running it a no-op.
-- ============================================================================

DO $cascade$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname,
           c.conrelid::regclass AS tbl,
           pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE c.contype = 'f'
      AND rel.relname = 'students'
      AND n.nspname = 'public'
      AND c.confupdtype <> 'c'          -- 'c' is CASCADE; skip the done ones
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON UPDATE CASCADE',
                   r.tbl, r.conname, r.def);
    RAISE NOTICE '024: % now cascades an id change', r.conname;
  END LOOP;
END
$cascade$;

CREATE OR REPLACE FUNCTION public.change_student_id(
  p_from text,
  p_to   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_from    text := btrim(COALESCE(p_from, ''));
  v_to      text := btrim(COALESCE(p_to, ''));
  n_enrol   integer;
  n_records integer;
  n_flags   integer;
BEGIN
  IF v_from = '' OR v_to = '' THEN
    RAISE EXCEPTION 'both the old and the new ID are needed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE student_id = v_from) THEN
    RAISE EXCEPTION 'no such student';
  END IF;

  -- Same rule as a rename: you may correct somebody you teach.
  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.student_id = v_from
      AND public.can_manage_class(e.class_id)
  ) THEN
    RAISE EXCEPTION 'not permitted to edit this student';
  END IF;

  IF v_from = v_to THEN
    RETURN jsonb_build_object('student_id', v_to, 'unchanged', true);
  END IF;

  -- Somebody already holds it. That is a MERGE — two records that turn out to
  -- be one person — and it has to decide what happens when both have
  -- attendance for the same session. Refused here rather than half-done.
  IF EXISTS (SELECT 1 FROM public.students WHERE student_id = v_to) THEN
    RAISE EXCEPTION
      'the ID % already belongs to another student. Combining two records is '
      'a different operation and this is not it', v_to;
  END IF;

  -- Counted before the change, so the caller can report what travelled.
  SELECT count(*) INTO n_enrol
  FROM public.enrolments WHERE student_id = v_from;
  SELECT count(*) INTO n_records
  FROM public.attendance_records WHERE student_id = v_from;
  SELECT count(*) INTO n_flags
  FROM public.flagged WHERE student_id = v_from;

  -- enrolments, attendance_records and canvas_row_mappings follow by cascade.
  UPDATE public.students SET student_id = v_to WHERE student_id = v_from;

  -- flagged has no foreign key — an orphan flag has always been possible, so
  -- it was never constrained. It has to be carried by hand.
  UPDATE public.flagged SET student_id = v_to WHERE student_id = v_from;

  -- legacy.present_students is deliberately left alone. It is retired, unread
  -- and unconstrained, and rewriting history that nothing consults would make
  -- the bridge reconciliation disagree with itself for no benefit.

  RETURN jsonb_build_object(
    'student_id',         v_to,
    'previous_id',        v_from,
    'unchanged',          false,
    'enrolments',         n_enrol,
    'attendance_records', n_records,
    'flags',              n_flags);
END;
$fn$;

REVOKE ALL ON FUNCTION public.change_student_id(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.change_student_id(text, text) TO authenticated;

COMMENT ON FUNCTION public.change_student_id(text, text) IS
  'Correct a mistyped student ID, carrying the person''s enrolments, '
  'attendance and flags with them. Refuses an ID somebody else already holds: '
  'that is a merge, which has to decide what happens to conflicting '
  'attendance, and is not this.';

-- ============================================================================
-- Moving a student between cohorts of their class
--
-- Was a direct UPDATE from the browser. As a function it can check that the
-- student is actually on the class before moving them, and — more usefully —
-- it can be called from edit_student below, so a cohort change and an ID
-- change land in the same transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.move_student_cohort(
  p_student_id text,
  p_cohort_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id       text := btrim(COALESCE(p_student_id, ''));
  v_class_id uuid;
  v_label    text;
BEGIN
  SELECT class_id, label INTO v_class_id, v_label
  FROM public.cohorts WHERE id = p_cohort_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', p_cohort_id;
  END IF;

  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.enrolments
    WHERE student_id = v_id AND class_id = v_class_id
  ) THEN
    RAISE EXCEPTION 'that student is not on this class';
  END IF;

  UPDATE public.enrolments
     SET cohort_id = p_cohort_id
   WHERE student_id = v_id AND class_id = v_class_id;

  RETURN jsonb_build_object(
    'student_id',   v_id,
    'cohort_id',    p_cohort_id,
    'cohort_label', v_label);
END;
$fn$;

REVOKE ALL ON FUNCTION public.move_student_cohort(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.move_student_cohort(text, uuid) TO authenticated;

-- ============================================================================
-- edit_student — all three changes, or none of them
--
-- The screen offers one "Edit student" form holding name, cohort and ID, so
-- the save has to behave like one action. Three separate calls cannot: the
-- rename succeeds, the ID change fails, and the record is left in a state
-- nobody asked for, with the dialog closed and the failure a toast.
--
-- One function is one transaction, so a refusal anywhere rolls the whole edit
-- back.
--
-- WHY jsonb RATHER THAN THREE NULLABLE PARAMETERS
--
-- NULL cannot mean both "leave this alone" and "clear it", and clearing a name
-- is a thing people legitimately do — an export with no name column leaves a
-- placeholder somebody may want gone. Key PRESENCE says what is being changed,
-- and the value says what to. {"name": null} clears it; omitting "name" leaves
-- it alone.
--
-- The order is deliberate: the ID goes last, so the name and cohort steps are
-- still working with the ID the caller passed in.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.edit_student(
  p_student_id text,
  p_changes    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id      text := btrim(COALESCE(p_student_id, ''));
  v_changes jsonb := COALESCE(p_changes, '{}'::jsonb);
  v_result  jsonb := '{}'::jsonb;
  v_moved   jsonb;
  v_new     jsonb;
BEGIN
  IF v_id = '' THEN
    RAISE EXCEPTION 'no student given';
  END IF;

  -- Each of these re-checks permission for itself. That is intentional
  -- duplication: they are callable on their own, and a check that only exists
  -- in the composite would be missing from the other three doors.

  IF v_changes ? 'name' THEN
    v_result := v_result || jsonb_build_object(
      'name', public.update_student(v_id, v_changes ->> 'name') ->> 'name');
  END IF;

  IF v_changes ? 'cohort_id' AND (v_changes ->> 'cohort_id') IS NOT NULL THEN
    v_moved := public.move_student_cohort(
                 v_id, (v_changes ->> 'cohort_id')::uuid);
    v_result := v_result || jsonb_build_object(
      'cohort_label', v_moved ->> 'cohort_label');
  END IF;

  -- Last, so everything above ran against the ID the caller knows.
  IF v_changes ? 'student_id'
     AND NULLIF(btrim(COALESCE(v_changes ->> 'student_id', '')), '') IS NOT NULL
     AND btrim(v_changes ->> 'student_id') <> v_id THEN
    v_new := public.change_student_id(v_id, btrim(v_changes ->> 'student_id'));
    v_result := v_result || jsonb_build_object(
      'previous_id',        v_id,
      'attendance_records', v_new -> 'attendance_records',
      'enrolments',         v_new -> 'enrolments',
      'flags',              v_new -> 'flags');
    v_id := v_new ->> 'student_id';
  END IF;

  RETURN v_result || jsonb_build_object('student_id', v_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.edit_student(text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.edit_student(text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.edit_student(text, jsonb) IS
  'Apply a student edit as one transaction: name, cohort and ID together, or '
  'none of them. Key presence in p_changes says what is being changed, so '
  '{"name": null} clears a name while omitting the key leaves it alone.';
