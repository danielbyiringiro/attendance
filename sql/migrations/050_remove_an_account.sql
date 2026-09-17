-- ============================================================================
-- 050 — an admin can remove an account
--
-- WHAT IS MISSING
--
-- There has never been a way to delete a staff account. 020 gave admins
-- approve and reject, and rejecting is reversible by design — the row stays so
-- the decision can be undone and so the person can be told why. That is right
-- for a colleague turned down by mistake, and wrong for the case that actually
-- fills the screen: students signing up for an account they do not need, being
-- declined, and staying in the list for ever.
--
-- So: a rejected account can be removed. Not blocked, removed.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not stop them coming back. ensure_staff (020) creates a `pending`
-- row whenever it finds none, and the dashboard calls it on every load, so an
-- account deleted while its auth user still exists returns to the queue the
-- next time that person opens the app. That is understood and accepted: this
-- is housekeeping, not a wall. What reduces the inflow is the signup screen
-- finally saying who it is for, which ships beside this.
--
-- A tombstone — remembering every refused address so ensure_staff could turn
-- them away — was considered and rejected. It would work, and it would also
-- mean keeping a permanent list of people turned away, which is a heavier
-- thing to own than a queue that occasionally needs tidying.
--
-- THE TWO REFUSALS
--
-- Deleting yourself. An admin who removes their own account cannot undo it,
-- and if they are the only admin nobody can approve anybody ever again. The
-- same reasoning as 020's guard on self-rejection.
--
-- Deleting somebody who still manages a class. class_staff.staff_id is
-- ON DELETE CASCADE (003), so removing an owner silently strips their class of
-- a member — and a class with no members is one nobody can reach, which is the
-- exact fault 020's admin tools exist to repair. Refused with the count, so
-- the admin can take them off those classes first and then delete.
--
-- What does cascade, and should: their read rows for announcements (049). What
-- is kept: anything they posted or added, which 049 already holds by
-- ON DELETE SET NULL — a video is still a video once the person who added it
-- has gone.
--
-- Run AFTER 049. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_delete_staff(p_staff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_me      uuid := public.current_staff_id();
  v_staff   public.staff%ROWTYPE;
  v_classes integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  SELECT * INTO v_staff FROM public.staff WHERE id = p_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such account';
  END IF;

  IF p_staff_id = v_me THEN
    RAISE EXCEPTION
      'That is you. Deleting your own account would remove your access and, '
      'if you are the only admin, leave nobody able to approve anyone.';
  END IF;

  SELECT count(*) INTO v_classes
  FROM public.class_staff cs WHERE cs.staff_id = p_staff_id;

  IF v_classes > 0 THEN
    RAISE EXCEPTION
      'That account still manages % class(es). Take them off those classes '
      'first — deleting them now would leave a class with one fewer member, '
      'and a class with none is one nobody can reach.', v_classes;
  END IF;

  DELETE FROM public.staff WHERE id = p_staff_id;

  RETURN jsonb_build_object(
    'deleted',  true,
    'staff_id', p_staff_id,
    'email',    v_staff.email,
    'status',   v_staff.status);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_delete_staff(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_delete_staff(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_delete_staff(uuid) IS
  'Remove a staff account entirely. Admin only. Refuses your own account, and '
  'one that still manages a class. Does not prevent the person signing up '
  'again — ensure_staff will make a new pending row (050).';
