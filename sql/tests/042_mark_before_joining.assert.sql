-- ============================================================================
-- Migration 042 — marking a student on a session from before they were added
--
-- THE STUDENT THESE TESTS HAVE ALWAYS SKIPPED
--
-- Every other suite backdates enrolled_on (`SET enrolled_on = CURRENT_DATE -
-- 30`) so its students exist on the sessions it creates. That is exactly why
-- the harness never saw the bug: in the app, a roster uploaded today leaves
-- enrolled_on as today, and every past session then had nobody on it.
--
-- So here one student, J042-LATE, keeps the default — added today, as the app
-- does it — beside J042-EARLY, who joined before the term.
--
-- Both halves of the decision are pinned:
--   what a PERSON does reaches the late joiner   (mark_all_present, history,
--                                                  disputes)
--   what the SYSTEM does still does not          (close_session's automatic
--                                                  absences, an unmarked day in
--                                                  their history)
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_dow   integer := EXTRACT(DOW FROM CURRENT_DATE)::integer;
  v_class uuid;
  v_a     uuid;
BEGIN
  v_class := (public.create_class('ASSERT-042', 'Joined Late',
                CURRENT_DATE - 14, CURRENT_DATE + 14, 'Africa/Accra', 1) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.set_cohort_schedules(ARRAY[v_a],
    format('[{"weekday": %s, "start_time": "09:00"}]', v_dow)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE - 14, CURRENT_DATE + 14);

  PERFORM public.upsert_enrolments(v_a,
    '[{"student_id": "J042-EARLY", "name": "Joined Before Term"},
      {"student_id": "J042-LATE",  "name": "Added Today"}]'::jsonb);
  -- Only the early joiner is backdated. The late joiner keeps what the app gives.
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE student_id = 'J042-EARLY';

  PERFORM set_config('t042.class', v_class::text, true);
  PERFORM set_config('t042.past7',
    (SELECT id FROM public.class_sessions WHERE cohort_id = v_a
      AND session_date = CURRENT_DATE - 7)::text, true);
  PERFORM set_config('t042.past14',
    (SELECT id FROM public.class_sessions WHERE cohort_id = v_a
      AND session_date = CURRENT_DATE - 14)::text, true);
  -- A session added by hand on a past date, the third way in.
  PERFORM set_config('t042.adhoc',
    public.create_ad_hoc_session(v_a, CURRENT_DATE - 3, TIME '11:00') ->> 'session_id', true);
END;
$setup$;

-- ----------------------------------------------------------- the premise --
DO $premise$
BEGIN
  IF (SELECT enrolled_on FROM public.enrolments WHERE student_id = 'J042-LATE')
     <> CURRENT_DATE THEN
    RAISE EXCEPTION '042 setup: the late joiner was supposed to keep today as enrolled_on';
  END IF;
  IF current_setting('t042.past7') = '' OR current_setting('t042.past14') = ''
     OR current_setting('t042.adhoc') = '' THEN
    RAISE EXCEPTION '042 setup: expected sessions 7 and 14 days ago and one added by hand';
  END IF;
END;
$premise$;

-- ------------------------------------------------- mark all present reaches --
DO $mark_all$
DECLARE
  r       jsonb;
  v_state public.attendance_state;
BEGIN
  r := public.mark_all_present(current_setting('t042.past7')::uuid);

  IF (r ->> 'roll')::integer <> 2 THEN
    RAISE EXCEPTION '042: mark all present on a past session had a roll of %, '
      'not both students — the one added today was left off: %', r ->> 'roll', r;
  END IF;

  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = current_setting('t042.past7')::uuid AND student_id = 'J042-LATE';
  IF v_state IS DISTINCT FROM 'present' THEN
    RAISE EXCEPTION '042: the student added today was not marked present on last week''s session (%)',
      v_state;
  END IF;

  -- The same on a session added by hand in the past.
  r := public.mark_all_present(current_setting('t042.adhoc')::uuid, 'present', false);
  IF (r ->> 'roll')::integer <> 2 THEN
    RAISE EXCEPTION '042: a session added by hand on a past date had a roll of %', r ->> 'roll';
  END IF;

  RAISE NOTICE '042 ok: mark all present reaches a student added after the session';
END;
$mark_all$;

-- ------------------------------------- the system still respects the join date --
DO $automatic$
DECLARE
  v_early public.attendance_state;
  v_late  integer;
BEGIN
  PERFORM public.close_session(current_setting('t042.past14')::uuid);

  SELECT state INTO v_early FROM public.attendance_records
   WHERE session_id = current_setting('t042.past14')::uuid AND student_id = 'J042-EARLY';
  IF v_early IS DISTINCT FROM 'unexcused' THEN
    RAISE EXCEPTION '042: closing a session no longer records the absent early joiner (%)', v_early;
  END IF;

  SELECT count(*) INTO v_late FROM public.attendance_records
   WHERE session_id = current_setting('t042.past14')::uuid AND student_id = 'J042-LATE';
  IF v_late <> 0 THEN
    RAISE EXCEPTION '042: closing a session from before a student joined recorded them absent';
  END IF;

  RAISE NOTICE '042 ok: automatic absences still start from the day a student joined';
END;
$automatic$;

-- ------------------------------------------------------------- history --
DO $history$
DECLARE
  r_late  jsonb := public.get_student_attendance('J042-LATE');
  r_early jsonb := public.get_student_attendance('J042-EARLY');
BEGIN
  IF position(current_setting('t042.past7') IN r_late::text) = 0 THEN
    RAISE EXCEPTION '042: a session the late joiner was marked on is missing from their history';
  END IF;

  -- Unmarked and from before they joined: still not theirs.
  IF position(current_setting('t042.past14') IN r_late::text) > 0 THEN
    RAISE EXCEPTION '042: an unmarked session from before they joined appeared in their history';
  END IF;

  IF position(current_setting('t042.past14') IN r_early::text) = 0 THEN
    RAISE EXCEPTION '042: a session the early joiner was enrolled for dropped out of their history';
  END IF;

  RAISE NOTICE '042 ok: history shows marks from before joining, and nothing unmarked from then';
END;
$history$;

-- ------------------------------------------------------------ disputes --
DO $disputes$
DECLARE r jsonb;
BEGIN
  -- Before they joined, and nobody marked them: nothing to dispute.
  r := public.flag_attendance('J042-LATE', current_setting('t042.past14')::uuid);
  IF r ->> 'error' IS DISTINCT FROM 'not_your_session' THEN
    RAISE EXCEPTION '042: a dispute was accepted for an unmarked session from before joining: %', r;
  END IF;

  -- A TA marks them absent on it by hand. Now it is in their history, and it
  -- has to be disputable.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (current_setting('t042.past14')::uuid, current_setting('t042.class')::uuid,
          'J042-LATE', 'unexcused', now(), 'staff');

  r := public.flag_attendance('J042-LATE', current_setting('t042.past14')::uuid);
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN
    RAISE EXCEPTION '042: an absence marked before the student joined cannot be disputed: %', r;
  END IF;

  RAISE NOTICE '042 ok: a mark from before joining can be disputed, an unmarked day cannot';
END;
$disputes$;

ROLLBACK;
