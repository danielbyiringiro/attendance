-- ============================================================================
-- Migration 032 — a cancelled class keeps no attendance at all
--
-- The old rule deleted the absences and kept everything else, so a student's
-- own history could say they attended a class that was called off.
--
-- The old filter also listed the states to delete, and a list is a place to
-- forget one: 'late' and 'exempted' were never in it. So the check here is on
-- the whole table for that session rather than on the states somebody
-- remembered — the only form of the assertion that cannot rot the same way.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_session uuid;
BEGIN
  v_class := (public.create_class('ASSERT-032', 'Cancellation',
                CURRENT_DATE - 30, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "C032A", "name": "Turned Up"},
      {"student_id": "C032B", "name": "Turned Up Late"},
      {"student_id": "C032C", "name": "Did Not Come"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  INSERT INTO public.class_sessions
    (class_id, cohort_id, starts_at, duration_minutes, status, opened_at,
     early_open_minutes, auto_close_minutes, late_window_minutes, pin)
  VALUES
    (v_class, v_cohort, now() - interval '30 minutes', 60, 'open',
     now() - interval '30 minutes', 15, 15, 10, 'C0321')
  RETURNING id INTO v_session;

  -- One of each state that used to survive a cancellation. 'unexcused' is the
  -- only one the old rule removed.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES
    (v_session, v_class, 'C032A', 'present',   now(), 'student'),
    (v_session, v_class, 'C032B', 'late',      now(), 'student'),
    (v_session, v_class, 'C032C', 'unexcused', now(), 'system');

  CREATE TEMP TABLE t032 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_session AS session_id;
END;
$setup$;

DO $assert$
DECLARE
  v_session uuid;
  v_removed integer;
  v_left    integer;
  v_status  public.session_status;
BEGIN
  SELECT session_id INTO v_session FROM t032;

  v_removed := public.cancel_session(v_session, 'lecturer ill');

  SELECT count(*) INTO v_left
  FROM public.attendance_records WHERE session_id = v_session;

  IF v_left <> 0 THEN
    RAISE EXCEPTION
      '032: % attendance row(s) survived the cancellation — a class that did not happen still claims attendance',
      v_left;
  END IF;

  -- Three in, three reported. If this said 1 the TA would be told one absence
  -- was cleared while two check-ins vanished silently.
  IF v_removed <> 3 THEN
    RAISE EXCEPTION
      '032: cancel reported % removed, expected 3 — the count no longer tells the TA what it did',
      v_removed;
  END IF;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = v_session;
  IF v_status <> 'cancelled' THEN
    RAISE EXCEPTION '032: the session was not marked cancelled (status %)', v_status;
  END IF;

  RAISE NOTICE '032 ok: % records removed, nothing left against the cancelled session', v_removed;
END;
$assert$;

-- ----------------------------------------------------------------------------
-- Cancelling one cohort's session must not touch another's
--
-- Sessions are per cohort and independent by construction. The app this
-- replaced keyed cancellations on the date alone, so calling off Cohort A's
-- Tuesday called off everybody's.
-- ----------------------------------------------------------------------------
DO $others$
DECLARE
  v_class   uuid;
  v_cohort  uuid;
  v_other   uuid;
  v_kept    integer;
BEGIN
  SELECT class_id INTO v_class FROM t032;

  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  IF v_cohort IS NULL THEN
    v_cohort := (public.add_cohort(v_class, 'B') ->> 'cohort_id')::uuid;
  END IF;

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "C032D", "name": "Other Cohort"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  INSERT INTO public.class_sessions
    (class_id, cohort_id, starts_at, duration_minutes, status, opened_at,
     early_open_minutes, auto_close_minutes, late_window_minutes, pin)
  VALUES
    (v_class, v_cohort, now() - interval '30 minutes', 60, 'open',
     now() - interval '30 minutes', 15, 15, 10, 'C0322')
  RETURNING id INTO v_other;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_other, v_class, 'C032D', 'present', now(), 'student');

  PERFORM public.cancel_session((SELECT session_id FROM t032), 'again');

  SELECT count(*) INTO v_kept
  FROM public.attendance_records WHERE session_id = v_other;

  IF v_kept <> 1 THEN
    RAISE EXCEPTION
      '032: cancelling one cohort''s session removed another cohort''s attendance (% left, expected 1)',
      v_kept;
  END IF;

  RAISE NOTICE '032 ok: the other cohort kept its session and its check-in';
END;
$others$;

ROLLBACK;
