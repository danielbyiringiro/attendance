-- ============================================================================
-- 018 — you cannot remove yourself from a class by accident
--
-- 008 guarded the one case that leaves a class unreachable by anybody: removing
-- the last member. It did not guard the case that leaves it unreachable by YOU,
-- which is far easier to hit and just as hard to undo — with no admin bypass,
-- getting back in means another member adding you, or the SQL editor.
--
-- And it is easy to hit by accident. list_class_members orders by email, so
-- adding a collaborator whose address sorts before yours moves your row down
-- the list the moment the screen refreshes. "Remove the person I just added"
-- then lands on whoever is now in the position you were looking at.
--
-- Leaving a class you no longer teach is legitimate, so this does not forbid
-- it — it makes it deliberate. Removing yourself requires saying so, in a
-- separate argument the UI only ever sets from its own confirmation.
--
-- Run AFTER 017. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_class_member(
  p_class_id     uuid,
  p_staff_id     uuid,
  p_confirm_self boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me        uuid := public.current_staff_id();
  v_remaining integer;
  v_is_self   boolean;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change who is on this class';
  END IF;

  v_is_self := (v_me IS NOT NULL AND v_me = p_staff_id);

  -- Removing yourself is allowed, but never as a side effect of aiming at
  -- somebody else. The caller has to say it meant this one.
  IF v_is_self AND NOT p_confirm_self THEN
    RAISE EXCEPTION
      'That is you. Removing yourself means losing access to this class, and '
      'only another member could give it back. Use Leave class if you meant it.';
  END IF;

  SELECT count(*) INTO v_remaining
  FROM public.class_staff WHERE class_id = p_class_id AND staff_id <> p_staff_id;

  -- Removing the last member would leave a class nobody can reach, and with no
  -- admin bypass there is no way back except the SQL editor. Delete the class
  -- instead if that is what you meant.
  IF v_remaining = 0 THEN
    RAISE EXCEPTION
      'That is the only person on this class. Add someone else first, or delete '
      'the class.';
  END IF;

  DELETE FROM public.class_staff
  WHERE class_id = p_class_id AND staff_id = p_staff_id;

  RETURN jsonb_build_object(
    'removed', true, 'remaining', v_remaining, 'was_self', v_is_self);
END;
$fn$;

-- The two-argument version would still resolve for a caller passing two
-- positional arguments, and would default p_confirm_self to false — safe, but
-- it would be a second function to keep in step. One is enough.
DROP FUNCTION IF EXISTS public.remove_class_member(uuid, uuid);

REVOKE ALL ON FUNCTION public.remove_class_member(uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.remove_class_member(uuid, uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.remove_class_member(uuid, uuid, boolean) IS
  'Remove somebody from a class. Refuses the last member, and refuses to remove '
  'the caller unless p_confirm_self says so: losing your own access is not '
  'something to do by mis-clicking a list that reorders as it loads.';

-- ----------------------------------------------------------------------------
-- list_class_members — you first, then everyone else by email
--
-- Ordering purely by email meant your own row moved when somebody was added,
-- which is what made a mis-click possible in the first place. Pinning yourself
-- to the top makes the list stable: the row you are looking at stays where it
-- is when the list reloads.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_class_members(p_class_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me   uuid := public.current_staff_id();
  v_rows jsonb;
BEGIN
  IF NOT public.can_access_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to see who is on this class';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'staff_id',     s.id,
           'email',        s.email,
           'display_name', s.display_name,
           'is_you',       (s.id = v_me),
           'since',        cs.created_at)
         ORDER BY (s.id = v_me) DESC, s.email), '[]'::jsonb)
    INTO v_rows
  FROM public.class_staff cs
  JOIN public.staff s ON s.id = cs.staff_id
  WHERE cs.class_id = p_class_id;

  RETURN v_rows;
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_class_members(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.list_class_members(uuid) TO authenticated;
