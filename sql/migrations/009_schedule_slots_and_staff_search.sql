-- ============================================================================
-- 009 — per-day schedule times, several cohorts at once, and colleague search
--
-- Three things 007 and 008 got too narrow:
--
--   * set_cohort_schedule applied ONE time to every weekday, so a cohort that
--     meets Tuesday at 09:00 and Thursday at 14:00 could not be expressed.
--   * It took one cohort, so setting the same pattern for three cohorts meant
--     three calls and three chances to get one of them wrong.
--   * add_class_member needed an exact email. Correct for privacy, tedious in
--     practice — you should be able to search the people you already work with.
--
-- Run AFTER 008. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- set_cohort_schedules — a list of slots, across a list of cohorts
--
-- Replaces set_cohort_schedule(uuid, smallint[], time, integer). Nothing in the
-- app calls the old shape yet, so it is dropped rather than left as a second
-- way to do the same thing badly.
--
-- p_slots is [{"weekday": 2, "start_time": "09:00", "duration_minutes": 60}].
-- duration_minutes may be omitted to inherit the class default.
--
-- Replace-in-one-statement, still: the client-side delete-then-insert at
-- TADashboard.tsx:1402 is two requests, and a failure between them leaves a
-- cohort with no schedule and nothing saying so.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.set_cohort_schedule(uuid, smallint[], time, integer);

CREATE OR REPLACE FUNCTION public.set_cohort_schedules(
  p_cohort_ids uuid[],
  p_slots      jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_class_ids uuid[];
  v_class_id  uuid;
  v_created   integer := 0;
  v_added     integer;
BEGIN
  IF p_cohort_ids IS NULL OR array_length(p_cohort_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no cohorts given';
  END IF;

  SELECT array_agg(DISTINCT class_id) INTO v_class_ids
  FROM public.cohorts WHERE id = ANY (p_cohort_ids);

  IF v_class_ids IS NULL THEN
    RAISE EXCEPTION 'none of those cohorts exist';
  END IF;

  -- Every cohort must belong to one class, and it must be yours. Applying a
  -- pattern across two classes in a single call would be a way to reach into a
  -- class you can see through a cohort id you were handed.
  IF array_length(v_class_ids, 1) > 1 THEN
    RAISE EXCEPTION 'those cohorts belong to different classes';
  END IF;

  v_class_id := v_class_ids[1];
  IF NOT public.can_manage_class(v_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF (SELECT count(*) FROM public.cohorts
      WHERE id = ANY (p_cohort_ids) AND class_id = v_class_id)
     <> array_length(p_cohort_ids, 1)
  THEN
    RAISE EXCEPTION 'one of those cohorts does not exist';
  END IF;

  -- Validate before deleting anything, so a bad slot cannot wipe a schedule
  -- and then fail.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'weekday') IS NULL
       OR (sl ->> 'weekday')::int NOT BETWEEN 0 AND 6
       OR NULLIF(btrim(COALESCE(sl ->> 'start_time', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION
      'every slot needs a weekday between 0 (Sunday) and 6 (Saturday) and a start time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
    WHERE (sl ->> 'duration_minutes') IS NOT NULL
      AND (sl ->> 'duration_minutes')::int <= 0
  ) THEN
    RAISE EXCEPTION 'a slot duration must be greater than zero';
  END IF;

  DELETE FROM public.cohort_schedules WHERE cohort_id = ANY (p_cohort_ids);

  INSERT INTO public.cohort_schedules (
    class_id, cohort_id, weekday, start_time, duration_minutes)
  SELECT
    v_class_id,
    c.cohort_id,
    (sl ->> 'weekday')::smallint,
    (sl ->> 'start_time')::time,
    NULLIF(sl ->> 'duration_minutes', '')::integer
  FROM unnest(p_cohort_ids) AS c(cohort_id)
  CROSS JOIN jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) sl
  ON CONFLICT (cohort_id, weekday, start_time) DO NOTHING;

  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_created := v_added;

  RETURN v_created;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) TO authenticated;

-- ----------------------------------------------------------------------------
-- search_addable_staff — search your colleagues, not the institution
--
-- 008 made adding a collaborator exact-email-only so that nobody could
-- enumerate every account. That is still the rule for strangers: this searches
-- ONLY people you already share a class with, which is the set you actually
-- want to pick from, and excludes anyone already on the class.
--
-- Someone you have never worked with is still added by typing their full email,
-- which reveals nothing you did not already know.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.search_addable_staff(
  p_class_id uuid,
  p_query    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_query text := lower(btrim(COALESCE(p_query, '')));
  v_rows  jsonb;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change who is on this class';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x ->> 'email'), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT DISTINCT jsonb_build_object(
             'staff_id',     s.id,
             'email',        s.email,
             'display_name', s.display_name) AS x
    FROM public.staff s
    WHERE public.shares_a_class_with(s.id)
      AND s.user_id <> auth.uid()
      -- Already on this class: they belong in the members list, not the picker.
      AND NOT EXISTS (
        SELECT 1 FROM public.class_staff cs
        WHERE cs.class_id = p_class_id AND cs.staff_id = s.id)
      AND (
        v_query = ''
        OR lower(COALESCE(s.email, '')) LIKE '%' || v_query || '%'
        OR lower(COALESCE(s.display_name, '')) LIKE '%' || v_query || '%'
      )
    LIMIT 20
  ) q;

  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.search_addable_staff(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.search_addable_staff(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- add_class_member_by_id — pick a searched colleague without retyping them
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_class_member_by_id(
  p_class_id uuid,
  p_staff_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_staff public.staff%ROWTYPE;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change who is on this class';
  END IF;

  SELECT * INTO v_staff FROM public.staff WHERE id = p_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that account no longer exists';
  END IF;

  -- You may only add someone you already work with. Without this the id alone
  -- would be enough to add anybody, which is the enumeration problem coming
  -- back through a side door.
  IF NOT public.shares_a_class_with(p_staff_id) THEN
    RAISE EXCEPTION
      'You can only pick from people you already share a class with. Add anyone '
      'else by typing their full email.';
  END IF;

  INSERT INTO public.class_staff (class_id, staff_id, role)
  VALUES (p_class_id, v_staff.id, 'owner')
  ON CONFLICT (class_id, staff_id) DO NOTHING;

  RETURN jsonb_build_object(
    'staff_id', v_staff.id, 'email', v_staff.email, 'added', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.add_class_member_by_id(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.add_class_member_by_id(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_cohort_schedules(uuid[], jsonb) IS
  'Replace the meeting pattern for one or more cohorts of a single class. Slots '
  'carry their own start time and duration, so a cohort can meet Tuesday at 09:00 '
  'and Thursday at 14:00.';

COMMENT ON FUNCTION public.search_addable_staff(uuid, text) IS
  'Search people you already share a class with. Never the whole staff table: '
  'anyone else is added by typing their full email.';
