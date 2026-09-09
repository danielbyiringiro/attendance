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
