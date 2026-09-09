-- ============================================================================
-- 023 — let a roster upload be previewed before it is written
--
-- A roster upload has to show the TA what it is about to do: how many people
-- are new, how many the registry already knows, who is already enrolled, who
-- sits in another cohort of the same class, and which rows are unusable. Only
-- then is there anything worth confirming.
--
-- The obvious way to build that preview is to work it out in the browser from
-- the current roster. That is the mistake this project has already made once,
-- with attendance percentage computed in two places that agreed by coincidence
-- rather than by construction. A preview that is computed by different code
-- from the write is a preview that is eventually wrong, and wrong in the most
-- expensive way: it is trusted.
--
-- So the preview is the write, asked not to write. p_dry_run runs every count
-- and every list, then returns before the two statements that change anything.
-- Same function, same inputs, same arithmetic.
--
-- The restructuring this needs is small, because only two statements in the
-- original were writes: the INSERT into students and the INSERT into
-- enrolments. Everything else was already a SELECT. The one number that used
-- to be a by-product of writing — how many enrolments were actually created —
-- is now derived first and the INSERT is asserted against it.
--
-- WHY THE SIGNATURE IS DROPPED FIRST
--
-- A fourth parameter with a default does not replace the three-argument
-- function, it overloads it, and then a three-argument call matches both and
-- Postgres refuses as ambiguous. The old signature has to go.
--
-- Run AFTER 022. Idempotent.
-- ============================================================================

DROP FUNCTION IF EXISTS public.upsert_enrolments(uuid, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.upsert_enrolments(
  p_cohort_id     uuid,
  p_rows          jsonb,
  p_move_existing boolean DEFAULT false,
  p_dry_run       boolean DEFAULT false
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
  n_actual     integer := 0;   -- what the writes really did, checked against the above
  v_other      jsonb   := '[]'::jsonb;
  v_invalid    jsonb   := '[]'::jsonb;
BEGIN
  SELECT class_id INTO v_class_id FROM public.cohorts WHERE id = p_cohort_id;
  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'cohort % does not exist', p_cohort_id;
  END IF;

  -- Checked even for a dry run. Someone who may not change this class may not
  -- learn its roster by asking what an upload would do to it, either.
  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  -- Normalise and reject unusable rows up front, so the counts below describe
  -- only rows that were genuinely actionable.
  --
  -- Dropped explicitly rather than relying on ON COMMIT DROP alone: that only
  -- fires at commit, so two calls inside one transaction would collide on the
  -- second CREATE. Supabase gives each RPC its own transaction, but a caller
  -- batching two cohorts should not hit an error about a temp table. A preview
  -- followed by the real call is exactly that pattern.
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

  -- --------------------------------------------------------------------------
  -- Everything the caller is told, worked out before anything is written
  -- --------------------------------------------------------------------------

  -- How many of these people the registry already knows.
  SELECT count(*) INTO n_reused
  FROM tmp_roster t
  WHERE EXISTS (SELECT 1 FROM public.students s WHERE s.student_id = t.student_id);

  n_created := (SELECT count(*) FROM tmp_roster) - n_reused;

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

  -- How many enrolments the INSERT below would actually create.
  --
  -- Derived rather than counted afterwards, so a dry run can report it. An
  -- enrolment is created only for somebody with no row in THIS CLASS at all:
  -- UNIQUE (class_id, student_id) makes ON CONFLICT DO NOTHING skip anybody
  -- already in any of its cohorts, whether this one or another. The real
  -- INSERT is asserted against this number below, so the two cannot drift.
  SELECT count(*) INTO n_enrolled
  FROM tmp_roster t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.enrolments e
    WHERE e.class_id = v_class_id AND e.student_id = t.student_id
  );

  IF p_move_existing THEN
    SELECT count(*) INTO n_moved
    FROM tmp_roster t
    JOIN public.enrolments e
      ON e.student_id = t.student_id AND e.class_id = v_class_id
     AND e.cohort_id <> p_cohort_id;
  END IF;

  -- --------------------------------------------------------------------------
  -- The answer, for somebody who only wanted to know
  -- --------------------------------------------------------------------------

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'dry_run',          true,
      'created_students', n_created,
      'reused_students',  n_reused,
      'enrolled',         n_enrolled,
      'already_enrolled', n_already,
      'moved',            CASE WHEN p_move_existing THEN n_moved ELSE 0 END,
      'in_other_cohort',  CASE WHEN p_move_existing THEN '[]'::jsonb ELSE v_other END,
      'invalid',          v_invalid
    );
  END IF;

  -- --------------------------------------------------------------------------
  -- The writes
  -- --------------------------------------------------------------------------

  -- Fill a missing name; never replace one that is already there.
  INSERT INTO public.students (student_id, cohort, name)
  SELECT t.student_id, '', t.name
  FROM tmp_roster t
  ON CONFLICT (student_id) DO UPDATE
    SET name = COALESCE(public.students.name, EXCLUDED.name);

  IF p_move_existing THEN
    UPDATE public.enrolments e
       SET cohort_id = p_cohort_id
      FROM tmp_roster t
     WHERE e.student_id = t.student_id
       AND e.class_id = v_class_id
       AND e.cohort_id <> p_cohort_id;

    GET DIAGNOSTICS n_actual = ROW_COUNT;

    IF n_actual <> n_moved THEN
      RAISE EXCEPTION
        'roster upload predicted % move(s) but made % — refusing to report a '
        'result the preview did not describe', n_moved, n_actual;
    END IF;

    v_other := '[]'::jsonb;
  END IF;

  WITH added AS (
    INSERT INTO public.enrolments (class_id, cohort_id, student_id)
    SELECT v_class_id, p_cohort_id, t.student_id
    FROM tmp_roster t
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_actual FROM added;

  -- The predicted number and the real one must agree. If they ever do not, the
  -- preview the TA agreed to was not what happened, and that is worth failing
  -- the whole upload over rather than reporting a number nobody will check.
  IF n_actual <> n_enrolled THEN
    RAISE EXCEPTION
      'roster upload predicted % new enrolment(s) but made % — refusing to '
      'report a result the preview did not describe', n_enrolled, n_actual;
  END IF;

  RETURN jsonb_build_object(
    'dry_run',          false,
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

REVOKE ALL ON FUNCTION public.upsert_enrolments(uuid, jsonb, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_enrolments(uuid, jsonb, boolean, boolean) TO authenticated;

COMMENT ON FUNCTION public.upsert_enrolments(uuid, jsonb, boolean, boolean) IS
  'Roster upload. Reuses an existing student_id rather than duplicating it, so '
  'a student can be enrolled in several classes. Fills a missing name but never '
  'overwrites one. Reports students already in another cohort of the same class '
  'rather than moving them, unless asked. p_dry_run returns exactly what a real '
  'call would report, having written nothing — the preview is this function, '
  'asked not to write, so the two cannot disagree.';
