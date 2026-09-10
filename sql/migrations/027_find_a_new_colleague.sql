-- ============================================================================
-- 027 — a newly approved colleague can be found
--
-- THE BOOTSTRAP PROBLEM
--
-- search_addable_staff returned only people the caller already shares a class
-- with. A newly approved account is on no class, so it shares one with nobody
-- and never appeared — for anybody, ever. To be findable you had to already be
-- on a class together; to get on a class somebody had to find you.
--
-- There was a way out and it was not obvious: type their full email, which
-- add_class_member accepts for any approved account. So the feature worked for
-- whoever knew that, and looked broken to everybody else, on exactly the task
-- people do most — putting a new TA on their first class.
--
-- WHAT THE OLD RULE WAS PROTECTING, AND WHY IT IS BEING TRADED
--
-- 009 refused to expose the whole staff table to a search box, so that an
-- authenticated account could not enumerate every colleague by typing letters.
-- That is a real concern and it is being accepted, deliberately.
--
-- `staff` is not a list of the public. Every row is an account somebody has
-- signed up for on an allowed institutional domain AND an admin has since
-- approved. Enumerating it tells an approved TA which of their colleagues also
-- teach here, which is roughly what a departmental directory says out loud. Set
-- against that, the old rule made onboarding impossible without out-of-band
-- knowledge of somebody's exact address.
--
-- WHAT STAYS SHUT
--
-- Approved only. A pending account does not appear, because add_class_member
-- refuses it anyway and offering somebody who cannot be added is worse than
-- not offering them. A rejected one does not appear either — it is a decision,
-- not a queue.
--
-- Nothing here widens what a search RESULT contains: id, email, display name,
-- exactly as before. And no student data is involved at any point.
--
-- add_class_member_by_id is widened to match. Leaving it would have been the
-- worse of both worlds: search finds somebody, clicking them fails, and the
-- error blames a rule the screen just appeared to break.
--
-- Run AFTER 026. Idempotent.
-- ============================================================================

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
    -- Approved, and that is the whole gate now. Pending and rejected accounts
    -- stay out: add_class_member refuses them, and offering somebody who
    -- cannot be added is worse than not offering them.
    WHERE s.status = 'approved'
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
    ORDER BY 1
    LIMIT 20
  ) q;

  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.search_addable_staff(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.search_addable_staff(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.search_addable_staff(uuid, text) IS
  'Search approved colleagues to add to a class. Returns id, email and display '
  'name only, and never a pending or rejected account. Was limited to people '
  'the caller already shared a class with, which made a newly approved '
  'colleague permanently unfindable.';

-- ----------------------------------------------------------------------------
-- add_class_member_by_id, widened to match
--
-- Its old check refused anybody the caller did not share a class with, on the
-- grounds that an id alone should not be enough to add somebody. With search
-- now returning approved colleagues, that check would reject exactly the people
-- the picker had just offered — so the rule becomes the same one
-- add_class_member has applied all along: approved accounts can be added.
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

  IF v_staff.status <> 'approved' THEN
    RAISE EXCEPTION
      'That account is still waiting to be approved. An admin has to approve '
      'them before they can be given a class.';
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
