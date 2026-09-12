-- ============================================================================
-- 037 — declaring a holiday removes the sessions that never ran
--
-- 036 treated every session on a declared date the same way: close it and mark
-- every enrolled student exempted. For a date that has already passed that is
-- right — the class was scheduled, something may have been recorded, and the
-- day should stay visible as one that formally did not count.
--
-- For a date still in the future it is wrong in an obvious way once you see it.
-- A session generated for a Monday in November, on a Monday that is now a
-- holiday, became a CLOSED session with a complete register of exemptions
-- against a class that has not happened yet. The Class Sessions list showed a
-- finished day in the future, and the attendance tab would count it among the
-- sessions this term has held.
--
-- It is also inconsistent with the same migration's other half. The trigger
-- stops sessions being created on a declared date, so generating the term
-- afterwards produces nothing there — while a session generated an hour earlier
-- survived as a closed husk. Two paths, two different answers, same date.
--
-- THE RULE
--
--   mode 'exempt', scheduled, nothing recorded  ->  delete it
--   anything else                               ->  close it, mark everyone
--
-- The mode matters, and leaving it out was the first version of this migration.
-- `present` means the day COUNTS and everybody is credited, so the session is
-- the thing carrying that credit — delete it and there is nowhere for the
-- credit to live, and a day meant to help every student silently does nothing
-- at all. Only `exempt` says the class does not meet, and only then is a
-- session with nothing in it surplus.
--
-- Which is migration 034's rule, reused: never delete a session somebody has
-- marked. A scheduled session with no records is a placeholder the weekly
-- pattern produced and nobody has touched, so removing it leaves exactly what
-- generating the term now would produce. A session that was opened, closed, or
-- carries any record has history, and history is kept.
--
-- The distinction is "has anything happened here", not "is the date in the
-- future". A session opened this morning and left running is not a placeholder
-- even though its date is today, and a register taken early — which 035 made
-- possible — is exactly the case where a future date has something worth
-- keeping.
--
-- A CONSEQUENCE WORTH STATING
--
-- clear_no_class_day cannot bring back what this deleted. It restores the
-- sessions it closed; the ones it removed have to come back from
-- generate_sessions, which is re-runnable and will recreate them once the date
-- is released. The count is returned separately so the screen can say so.
--
-- Run AFTER 036. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_no_class_day(
  p_class_id  uuid,
  p_date      date,
  p_mode      text,
  p_reason    text,
  p_cohort_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  s          public.class_sessions%ROWTYPE;
  v_state    public.attendance_state;
  v_sessions integer := 0;
  v_removed  integer := 0;
  v_students integer := 0;
  v_written  integer;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_mode NOT IN ('exempt', 'present') THEN
    RAISE EXCEPTION
      'mode must be exempt (the day does not count) or present (it counts and everybody gets it), not %',
      p_mode;
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required — a day that stops counting has to say why';
  END IF;

  v_state := CASE p_mode
    WHEN 'exempt' THEN 'exempted'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;

  INSERT INTO public.no_class_days (class_id, cohort_id, on_date, mode, reason, set_by)
  VALUES (p_class_id, p_cohort_id, p_date, p_mode, btrim(p_reason),
          public.current_staff_id())
  ON CONFLICT DO NOTHING;

  FOR s IN
    SELECT * FROM public.class_sessions c
    WHERE c.class_id = p_class_id
      AND c.session_date = p_date
      AND (p_cohort_id IS NULL OR c.cohort_id = p_cohort_id)
      AND c.status <> 'cancelled'
    FOR UPDATE
  LOOP
    -- Nothing has happened here: a placeholder the pattern produced. Remove it,
    -- so the date looks exactly as it would if the holiday had been declared
    -- before the term was generated.
    --
    -- Only for 'exempt'. Under 'present' the session is what carries the credit
    -- for everybody, so deleting it would leave the day meaning nothing.
    IF p_mode = 'exempt'
       AND s.status = 'scheduled'
       AND NOT EXISTS (
         SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
       )
    THEN
      DELETE FROM public.class_sessions WHERE id = s.id;
      v_removed := v_removed + 1;
      CONTINUE;
    END IF;

    -- Something has. Keep the session and record that the day did not count.
    DELETE FROM public.attendance_records WHERE session_id = s.id;

    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, s.class_id, e.student_id, v_state, now(), 'staff'
    FROM public.enrolments e
    WHERE e.cohort_id = s.cohort_id
      AND e.enrolled_on <= s.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date);

    GET DIAGNOSTICS v_written = ROW_COUNT;
    v_students := v_students + v_written;

    UPDATE public.class_sessions
       SET status = 'closed'
     WHERE id = s.id;

    v_sessions := v_sessions + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'date',     p_date,
    'mode',     p_mode,
    -- Kept and marked, because something had happened at them.
    'sessions', v_sessions,
    -- Deleted, because nothing had. Reported separately: these do not come back
    -- when the day is cleared, they come back from generate_sessions.
    'removed',  v_removed,
    'students', v_students
  );
END;
$fn$;

COMMENT ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid) IS
  'Declare a date off. Sessions with nothing recorded against them are deleted; '
  'ones that were opened or marked are closed with everybody exempted (or '
  'present). Remembered, so regenerating does not bring the day back.';
