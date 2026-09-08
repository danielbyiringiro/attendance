-- ============================================================================
-- 012 — deleting a class takes its students with it, when nobody else has them
--
-- Until now `students` survived a class deletion on the principle that a person
-- is not owned by a course. That is right for anyone taking two courses, and
-- wrong for everyone else: a student enrolled only in the deleted class became
-- a row reachable from no screen in the app, holding a name and an ID forever,
-- with no way to find or remove it short of the SQL editor. Deleting a few
-- test classes leaves the registry full of people nobody can see.
--
-- So: a student whose ONLY enrolment was the deleted class is deleted too. A
-- student enrolled anywhere else is untouched, including where that other
-- enrolment has been dropped — dropped still means they have history there.
--
-- Two things this has to get right:
--
--   * The orphan set is computed BEFORE the class goes. Afterwards the
--     enrolments have cascaded away and there is no way left to tell who was
--     in it.
--   * present_students and flagged carry a student_id with no foreign key, by
--     design — the legacy tables allow an orphan check-in. Nothing cascades
--     there, so this clears them by hand. Otherwise deleting a student leaves
--     rows keyed to somebody who no longer exists, and the bridge
--     reconciliation starts counting them as unexplained.
--
-- Run AFTER 011. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- preview_class_deletion — say what will be deleted, not what will be orphaned
--
-- The count is the same set of students; what happens to them is not. Renamed
-- rather than left as `students_left_orphaned`, which would now be a lie.
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
    'students_also_deleted', (
      SELECT count(*)
      FROM (
        SELECT DISTINCT e.student_id
        FROM public.enrolments e
        WHERE e.class_id = p_class_id
          -- Any enrolment elsewhere keeps them, dropped or not: a dropped
          -- student still has attendance history in that other class.
          AND NOT EXISTS (
            SELECT 1 FROM public.enrolments o
            WHERE o.student_id = e.student_id AND o.class_id <> p_class_id)
      ) x)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_class_deletion(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_class_deletion(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- delete_class — and the students nobody else has
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_class(
  p_class_id                 uuid,
  p_confirm_code             text,
  p_delete_orphaned_students boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class    public.classes%ROWTYPE;
  v_summary  jsonb;
  v_students integer := 0;
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

  -- Who this class is the only claim on. Must be captured now: the DELETE
  -- below cascades the enrolments away, and with them the only record of who
  -- was in it.
  DROP TABLE IF EXISTS tmp_orphans;
  CREATE TEMP TABLE tmp_orphans ON COMMIT DROP AS
  SELECT DISTINCT e.student_id
  FROM public.enrolments e
  WHERE e.class_id = p_class_id
    AND NOT EXISTS (
      SELECT 1 FROM public.enrolments o
      WHERE o.student_id = e.student_id AND o.class_id <> p_class_id);

  -- Cohorts, enrolments, schedules, sessions, attendance, corrections, report
  -- settings and staff links all go by cascade.
  DELETE FROM public.classes WHERE id = p_class_id;

  IF p_delete_orphaned_students THEN
    -- present_students and flagged have no foreign key to students, so nothing
    -- cascades into them. Clearing them first keeps the legacy tables from
    -- holding rows for a student who no longer exists.
    DELETE FROM public.present_students p
     USING tmp_orphans o WHERE p.student_id = o.student_id;

    DELETE FROM public.flagged f
     USING tmp_orphans o WHERE f.student_id = o.student_id;

    -- excused_absences and canvas_row_mappings DO cascade from students, so
    -- they need no help here.
    WITH gone AS (
      DELETE FROM public.students s
       USING tmp_orphans o
       WHERE s.student_id = o.student_id
         -- Belt and braces: after the cascade an orphan has no enrolments at
         -- all. If one somehow does, it belongs to another class and stays.
         AND NOT EXISTS (
           SELECT 1 FROM public.enrolments e WHERE e.student_id = s.student_id)
      RETURNING 1
    )
    SELECT count(*) INTO v_students FROM gone;
  END IF;

  DROP TABLE IF EXISTS tmp_orphans;

  RETURN jsonb_build_object(
    'deleted',          true,
    'students_deleted', v_students,
    'summary',          v_summary
  );
END;
$fn$;

-- The two-argument version would still resolve for callers passing two
-- positional arguments, leaving two functions that drift apart.
DROP FUNCTION IF EXISTS public.delete_class(uuid, text);

REVOKE ALL ON FUNCTION public.delete_class(uuid, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.delete_class(uuid, text, boolean) TO authenticated;

COMMENT ON FUNCTION public.delete_class(uuid, text, boolean) IS
  'Delete a class after confirming its code. Students whose only enrolment was '
  'this class are deleted with it; anyone enrolled elsewhere is kept. Pass '
  'false to keep every student.';
