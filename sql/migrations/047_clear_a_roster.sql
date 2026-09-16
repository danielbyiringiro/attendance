-- ============================================================================
-- 047 — clearing a roster: remove everybody, keeping or erasing their record
--
-- Taking one student off a class is a drop: enrolments.dropped_on is set, the
-- attendance they have stays, and close_session stops marking them absent from
-- sessions after they left. Doing that forty times, one dialog at a time, is
-- the only way to empty a roster today — and there is no way at all to undo a
-- roster uploaded into the wrong class, which is the case people actually hit.
--
-- Two ways to clear one, because they answer different problems:
--
--   KEEP    every enrolment in scope is dropped as of today. Nothing is
--           deleted; the term that was taught still happened and can still be
--           exported. This is the bulk version of the existing button.
--
--   ERASE   the enrolments, their attendance in THIS class, and their flags in
--           this class are deleted. For the roster that went into the wrong
--           class, where "dropped" would leave forty people and a term of
--           absences sitting in a class they were never in.
--
-- SCOPE
--
-- The whole class, or one cohort. Never "whatever the screen is filtered to":
-- a destructive action that quietly follows a filter is how somebody narrows to
-- Cohort B, forgets, and clears the class. The scope is a parameter, the
-- preview states it, and the typed confirmation is checked against the class
-- code either way.
--
-- WHAT ERASING TAKES WITH IT
--
--   attendance_records     deleted for those students, in this class only.
--                          attendance_corrections cascades from the record, so
--                          the correction history goes with it — that is the
--                          point of "erase", but it is worth saying out loud.
--   flagged                deleted for those students in this class. It has a
--                          class_id (016) but no foreign key to students, so
--                          nothing would cascade.
--   enrolments             deleted outright, not dropped.
--   students               only those left with no enrolment anywhere, and only
--                          when asked. A person is not owned by a course, but a
--                          person in no course at all is a row no screen in
--                          this app can reach — the same reasoning, and the
--                          same rule, as deleting a class (012).
--
-- A student enrolled in any other class keeps their row and everything recorded
-- against them there. Only this class's side of their record goes.
--
-- Run AFTER 046. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- preview_roster_clearing — what is about to go, before anything goes
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preview_roster_clearing(
  p_class_id  uuid,
  p_cohort_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class  public.classes%ROWTYPE;
  v_cohort public.cohorts%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF p_cohort_id IS NOT NULL THEN
    SELECT * INTO v_cohort
    FROM public.cohorts WHERE id = p_cohort_id AND class_id = p_class_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cohort % is not part of class %', p_cohort_id, v_class.code;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'class_id',     v_class.id,
    'code',         v_class.code,
    'name',         v_class.name,
    'scope',        CASE WHEN p_cohort_id IS NULL THEN 'class' ELSE 'cohort' END,
    'cohort_id',    p_cohort_id,
    'cohort_label', v_cohort.label,
    -- Everybody in scope, and the subset a drop would actually change: a
    -- student dropped last month is already off the roster.
    'students', (
      SELECT count(*) FROM public.enrolments e
      WHERE e.class_id = p_class_id
        AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id)),
    'still_on_roster', (
      SELECT count(*) FROM public.enrolments e
      WHERE e.class_id = p_class_id
        AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id)
        AND e.dropped_on IS NULL),
    'attendance_records', (
      SELECT count(*) FROM public.attendance_records ar
      WHERE ar.class_id = p_class_id
        AND ar.student_id IN (
          SELECT e.student_id FROM public.enrolments e
          WHERE e.class_id = p_class_id
            AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id))),
    'flags', (
      SELECT count(*) FROM public.flagged f
      WHERE f.class_id = p_class_id
        AND f.student_id IN (
          SELECT e.student_id FROM public.enrolments e
          WHERE e.class_id = p_class_id
            AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id))),
    -- Only meaningful for an erase: who would be left in the registry with no
    -- course at all. An enrolment outside the scope — another class, or another
    -- cohort of this one when clearing a single cohort — keeps them.
    'students_also_deleted', (
      SELECT count(*) FROM public.enrolments e
      WHERE e.class_id = p_class_id
        AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id)
        AND NOT EXISTS (
          SELECT 1 FROM public.enrolments o
          WHERE o.student_id = e.student_id
            AND NOT (o.class_id = p_class_id
                     AND (p_cohort_id IS NULL OR o.cohort_id = p_cohort_id))))
  );
END;
$fn$;

-- ----------------------------------------------------------------------------
-- clear_roster — do it, once the class code has been typed
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.clear_roster(
  p_class_id                 uuid,
  p_confirm_code             text,
  p_cohort_id                uuid    DEFAULT NULL,
  p_erase                    boolean DEFAULT false,
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
  v_changed  integer := 0;
  v_records  integer := 0;
  v_flags    integer := 0;
  v_students integer := 0;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  SELECT * INTO v_class FROM public.classes WHERE id = p_class_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'class % does not exist', p_class_id;
  END IF;

  IF lower(btrim(COALESCE(p_confirm_code, ''))) <> lower(btrim(v_class.code)) THEN
    RAISE EXCEPTION
      'confirmation does not match: type the class code (%) exactly', v_class.code;
  END IF;

  -- Taken before anything changes; afterwards there is nothing left to count.
  v_summary := public.preview_roster_clearing(p_class_id, p_cohort_id);

  IF NOT p_erase THEN
    WITH dropped AS (
      UPDATE public.enrolments e
         SET dropped_on = CURRENT_DATE
       WHERE e.class_id = p_class_id
         AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id)
         AND e.dropped_on IS NULL
      RETURNING 1
    )
    SELECT count(*) INTO v_changed FROM dropped;

    RETURN jsonb_build_object(
      'cleared', true,
      'erased',  false,
      'removed', v_changed,
      'summary', v_summary
    );
  END IF;

  -- Who is in scope, captured before the enrolments go: afterwards there is no
  -- way left to tell who was in this class.
  DROP TABLE IF EXISTS tmp_cleared;
  CREATE TEMP TABLE tmp_cleared ON COMMIT DROP AS
  SELECT DISTINCT e.student_id
  FROM public.enrolments e
  WHERE e.class_id = p_class_id
    AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id);

  -- This class's attendance only. attendance_corrections cascades from the
  -- record, so the correction history goes with it.
  WITH gone AS (
    DELETE FROM public.attendance_records ar
     USING tmp_cleared c
     WHERE ar.class_id = p_class_id AND ar.student_id = c.student_id
    RETURNING 1
  )
  SELECT count(*) INTO v_records FROM gone;

  WITH gone AS (
    DELETE FROM public.flagged f
     USING tmp_cleared c
     WHERE f.class_id = p_class_id AND f.student_id = c.student_id
    RETURNING 1
  )
  SELECT count(*) INTO v_flags FROM gone;

  WITH gone AS (
    DELETE FROM public.enrolments e
     WHERE e.class_id = p_class_id
       AND (p_cohort_id IS NULL OR e.cohort_id = p_cohort_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_changed FROM gone;

  IF p_delete_orphaned_students THEN
    -- flagged has no foreign key to students, so nothing cascades into it.
    DELETE FROM public.flagged f
     USING tmp_cleared c
     WHERE f.student_id = c.student_id
       AND NOT EXISTS (
         SELECT 1 FROM public.enrolments e WHERE e.student_id = c.student_id);

    WITH gone AS (
      DELETE FROM public.students s
       USING tmp_cleared c
       WHERE s.student_id = c.student_id
         AND NOT EXISTS (
           SELECT 1 FROM public.enrolments e WHERE e.student_id = s.student_id)
      RETURNING 1
    )
    SELECT count(*) INTO v_students FROM gone;
  END IF;

  DROP TABLE IF EXISTS tmp_cleared;

  RETURN jsonb_build_object(
    'cleared',           true,
    'erased',            true,
    'removed',           v_changed,
    'records_deleted',   v_records,
    'flags_deleted',     v_flags,
    'students_deleted',  v_students,
    'summary',           v_summary
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.preview_roster_clearing(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_roster_clearing(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.clear_roster(uuid, text, uuid, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.clear_roster(uuid, text, uuid, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.preview_roster_clearing(uuid, uuid) IS
  'What clearing a class''s roster — or one cohort''s — would remove: students, '
  'enrolments still on the roster, attendance records, flags, and the people who '
  'would be left in no class at all (047).';

COMMENT ON FUNCTION public.clear_roster(uuid, text, uuid, boolean, boolean) IS
  'Empty a roster, whole class or one cohort, once the class code is typed. '
  'Without p_erase every enrolment is dropped and nothing is deleted; with it, '
  'the enrolments, this class''s attendance and this class''s flags go, and '
  'students left in no class at all are deleted unless asked otherwise (047).';
