-- ============================================================================
-- 060 — an excuse says why, and happens in one go
--
-- The Excused Absence dialog has asked "Reason (optional)" since it was built,
-- and has never stored the answer. The value went into a React state and was
-- read by nothing: staff have been typing "hospital appointment, letter on
-- file" into a box that throws it away, and the one question anybody asks
-- later — why is this person excused for a fortnight in March — had no answer
-- anywhere in the database.
--
-- Two places to put it, because they answer different questions:
--
--   attendance_records.note    why this mark is what it is. Shows on the
--                              student's record, next to the excused day.
--   attendance_corrections     why it was CHANGED, in the audit trail 004
--                              built. The column was already there and the
--                              trigger has always written NULL into it.
--
-- WHY A FUNCTION RATHER THAN A BETTER LOOP
--
-- Excusing was a client-side loop: read the sessions, then one upsert per
-- session. Excusing somebody for three weeks was thirty round trips and thirty
-- separate transactions, so a network drop halfway left a student excused for
-- the first eleven days of a fortnight and absent for the rest, with nothing
-- to say it had gone wrong. One call, one transaction, all or nothing.
--
-- HOW THE REASON REACHES THE AUDIT TRAIL
--
-- The correction rows are written by a trigger (004), deliberately, so that no
-- code path can forget them — which also means the trigger, not the caller,
-- does the INSERT and has no argument to receive a reason through. So the
-- reason is put where the trigger can see it: a transaction-local setting,
-- read with current_setting(..., true) which returns NULL rather than raising
-- when nobody set it. Any future caller that sets it gets the same benefit,
-- and one that does not is unaffected.
--
-- Run AFTER 059. Idempotent.
-- ============================================================================

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.attendance_records.note IS
  'Why staff set this state — the reason typed when excusing. Null for marks '
  'nobody annotated, which is most of them (060).';

-- ----------------------------------------------------------------------------
-- The correction trigger learns to carry a reason
--
-- Same trigger, same guarantee; it now reads the reason the caller left for it
-- if there is one. Redefined rather than replaced so the trigger itself does
-- not have to be dropped and recreated.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_attendance_correction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  INSERT INTO public.attendance_corrections (
    record_id, class_id, previous_state, new_state, corrected_by, reason
  )
  VALUES (
    NEW.id, NEW.class_id, OLD.state, NEW.state, auth.uid(),
    -- The second argument makes a missing setting return NULL instead of
    -- raising, which is what every caller that does not set one relies on.
    NULLIF(btrim(COALESCE(current_setting('app.correction_reason', true), '')), '')
  );
  RETURN NULL;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- excuse_sessions — the whole range, once
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.excuse_sessions(
  p_class_id   uuid,
  p_student_id text,
  p_from       date,
  p_to         date,
  p_cohort_id  uuid DEFAULT NULL,
  p_reason     text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_reason  text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_changed integer := 0;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'not permitted to change this class';
  END IF;

  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'an excuse needs a first and a last day';
  END IF;

  IF p_to < p_from THEN
    RAISE EXCEPTION 'the last day cannot be before the first';
  END IF;

  -- Left for the correction trigger to find. Transaction-local (the third
  -- argument), so it cannot leak into the next statement this connection runs
  -- — connections are pooled, and a reason bleeding into somebody else's
  -- correction would be worse than no reason at all.
  PERFORM set_config('app.correction_reason', COALESCE(v_reason, ''), true);

  WITH touched AS (
    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role, note
    )
    SELECT s.id, s.class_id, p_student_id, 'excused', now(), 'staff', v_reason
    FROM public.class_sessions s
    WHERE s.class_id = p_class_id
      AND s.session_date BETWEEN p_from AND p_to
      -- Nobody needs excusing from a class that did not happen.
      AND s.status <> 'cancelled'
      AND (p_cohort_id IS NULL OR s.cohort_id = p_cohort_id)
    ON CONFLICT (session_id, student_id) DO UPDATE
      -- A blank reason leaves whatever note was already there rather than
      -- wiping it: re-excusing a day without retyping the reason should not
      -- erase the reason.
      SET state   = 'excused',
          note    = COALESCE(EXCLUDED.note, attendance_records.note),
          marked_at = now(),
          marked_by_role = 'staff'
    RETURNING 1
  )
  SELECT count(*) INTO v_changed FROM touched;

  -- Put it back down again.
  --
  -- Transaction-local already stops it surviving this call on a pooled
  -- connection, but "local" means the whole transaction, and anything else
  -- that corrects a mark later in the SAME transaction would otherwise be
  -- filed under this excuse's reason. Set it, use it, clear it — the window
  -- in which the value means anything is exactly the statement above.
  PERFORM set_config('app.correction_reason', '', true);

  RETURN v_changed;
END;
$fn$;

DO $grants$
DECLARE
  sig text := 'public.excuse_sessions(uuid, text, date, date, uuid, text)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public;', sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated;', sig);
END
$grants$;

COMMENT ON FUNCTION public.excuse_sessions(uuid, text, date, date, uuid, text) IS
  'Excuse one student from every session their cohort holds in a range, in one '
  'transaction, recording why (060).';
