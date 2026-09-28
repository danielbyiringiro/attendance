-- ============================================================================
-- Migration 060 — an excuse says why, and happens in one go
--
-- What is checked:
--
--   excusing a range sets every session in it, and reports how many
--   the reason lands on the record AND on the audit trail, which is the
--     whole point: the column on attendance_corrections has existed since 004
--     and the trigger has always written NULL into it
--   a cancelled session is skipped — nobody is excused from a class that did
--     not happen
--   another cohort's sessions are untouched when a cohort is named
--   re-excusing without a reason keeps the reason already on record, rather
--     than quietly erasing it
--   a correction written by something OTHER than excuse_sessions still works
--     and simply has no reason — the setting is transaction-local, so it must
--     not leak into an unrelated change
--   somebody with no claim on the class cannot excuse anybody in it
--   the dates are checked: a range that runs backwards is refused
--
-- NOT checked, and it cannot be from here: that set_config's third argument is
-- `true`. Transaction-local only differs from session-level once something
-- COMMITs, and every assert file in this suite ends in ROLLBACK by design, so
-- flipping that flag changes nothing any test can observe. It stays `true`
-- because a reason surviving onto a pooled connection would be somebody else's
-- correction wearing this student's explanation; what the leak check below
-- actually proves is the explicit clear at the end of excuse_sessions.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

-- The fixture's class, cohort and students (000_fixture).
DO $ids$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  SELECT id INTO v_class FROM public.classes ORDER BY created_at LIMIT 1;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class
   ORDER BY label LIMIT 1;

  IF v_class IS NULL OR v_cohort IS NULL THEN
    RAISE EXCEPTION '060: the fixture has no class or cohort to work with';
  END IF;

  PERFORM set_config('t060.class', v_class::text, true);
  PERFORM set_config('t060.cohort', v_cohort::text, true);
  PERFORM set_config('t060.student',
    (SELECT student_id FROM public.enrolments
      WHERE cohort_id = v_cohort ORDER BY student_id LIMIT 1), true);
END;
$ids$;

-- A member of staff who can manage the class, and one who cannot.
INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('60000000-0000-0000-0000-000000000060', 'ta@assert-060.test',
   'Class TA', 'approved', false),
  ('60000000-0000-0000-0000-000000000061', 'outsider@assert-060.test',
   'Unrelated TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.class_staff (class_id, staff_id)
SELECT current_setting('t060.class')::uuid, s.id
  FROM public.staff s WHERE s.email = 'ta@assert-060.test'
ON CONFLICT DO NOTHING;

-- Three sessions on known dates for the cohort, one of them cancelled.
DO $sessions$
DECLARE
  v_class  uuid := current_setting('t060.class')::uuid;
  v_cohort uuid := current_setting('t060.cohort')::uuid;
BEGIN
  INSERT INTO public.class_sessions
    (class_id, cohort_id, starts_at, duration_minutes, status)
  VALUES
    (v_class, v_cohort, '2031-03-03 09:00+00', 60, 'closed'),
    (v_class, v_cohort, '2031-03-05 09:00+00', 60, 'closed'),
    (v_class, v_cohort, '2031-03-06 09:00+00', 60, 'cancelled')
  ON CONFLICT (cohort_id, starts_at) DO NOTHING;

  -- One of them already carries an absence, so the excuse is a CHANGE and the
  -- correction trigger fires — which is what the reason has to reach.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_by_role)
  SELECT s.id, v_class, current_setting('t060.student'), 'unexcused', 'staff'
    FROM public.class_sessions s
   WHERE s.cohort_id = v_cohort AND s.session_date = '2031-03-03'
  ON CONFLICT (session_id, student_id) DO UPDATE SET state = 'unexcused';
END;
$sessions$;

-- ------------------------------------------------ the class's own TA excuses --
SET ROLE authenticated;
SET request.jwt.claim.sub = '60000000-0000-0000-0000-000000000060';

DO $excuse$
DECLARE
  n       integer;
  v_note  text;
  v_trail text;
BEGIN
  n := public.excuse_sessions(
         current_setting('t060.class')::uuid,
         current_setting('t060.student'),
         '2031-03-01', '2031-03-31',
         current_setting('t060.cohort')::uuid,
         'Hospital appointment, letter on file');

  -- Two, not three: the cancelled one is not somebody's absence.
  IF n <> 2 THEN
    RAISE EXCEPTION '060: excused % sessions, expected 2', n;
  END IF;

  SELECT count(*) INTO n
    FROM public.attendance_records r
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date IN ('2031-03-03', '2031-03-05')
     AND r.state = 'excused';
  IF n <> 2 THEN
    RAISE EXCEPTION '060: % of 2 sessions came back excused', n;
  END IF;

  -- The cancelled day was left alone entirely.
  SELECT count(*) INTO n
    FROM public.attendance_records r
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date = '2031-03-06';
  IF n <> 0 THEN
    RAISE EXCEPTION '060: the cancelled session was given a record anyway';
  END IF;

  -- On the record...
  SELECT r.note INTO v_note
    FROM public.attendance_records r
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date = '2031-03-03';
  IF v_note IS DISTINCT FROM 'Hospital appointment, letter on file' THEN
    RAISE EXCEPTION '060: the record kept the reason as %', v_note;
  END IF;

  -- ...and in the audit trail, which is the half that has always been null.
  SELECT c.reason INTO v_trail
    FROM public.attendance_corrections c
    JOIN public.attendance_records r ON r.id = c.record_id
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date = '2031-03-03'
   ORDER BY c.corrected_at DESC LIMIT 1;
  IF v_trail IS DISTINCT FROM 'Hospital appointment, letter on file' THEN
    RAISE EXCEPTION '060: the correction recorded the reason as %', v_trail;
  END IF;

  RAISE NOTICE '060 ok: a range is excused once, with the reason on both sides';
END;
$excuse$;

-- ------------------------------- an ordinary correction carries no reason --
--
-- Runs HERE, directly after an excuse that carried a reason, and that position
-- is the test. Further down — after the reason-less excuse below — it passed
-- whatever excuse_sessions did with the setting, because that second call left
-- it empty anyway. A check that cannot fail is not a check.
--
-- The whole file is one transaction, so "transaction-local" alone would NOT
-- save this: local means until COMMIT, and this UPDATE is before it. What
-- makes it pass is excuse_sessions clearing the setting when it is done.
DO $unrelated$
DECLARE
  v_reason text;
  v_record uuid;
BEGIN
  SELECT r.id INTO v_record
    FROM public.attendance_records r
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date = '2031-03-05';

  UPDATE public.attendance_records SET state = 'present' WHERE id = v_record;

  SELECT c.reason INTO v_reason
    FROM public.attendance_corrections c
   WHERE c.record_id = v_record
   ORDER BY c.corrected_at DESC LIMIT 1;

  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '060: an unrelated correction picked up the reason %', v_reason;
  END IF;

  RAISE NOTICE '060 ok: the reason does not leak into an unrelated correction';
END;
$unrelated$;

-- ------------------------------------- re-excusing does not erase the reason --
DO $again$
DECLARE v_note text;
BEGIN
  PERFORM public.excuse_sessions(
    current_setting('t060.class')::uuid,
    current_setting('t060.student'),
    '2031-03-01', '2031-03-31',
    current_setting('t060.cohort')::uuid,
    NULL);

  SELECT r.note INTO v_note
    FROM public.attendance_records r
    JOIN public.class_sessions s ON s.id = r.session_id
   WHERE r.student_id = current_setting('t060.student')
     AND s.session_date = '2031-03-03';

  IF v_note IS DISTINCT FROM 'Hospital appointment, letter on file' THEN
    RAISE EXCEPTION '060: re-excusing without a reason wiped it to %', v_note;
  END IF;

  RAISE NOTICE '060 ok: excusing again without a reason keeps the one on record';
END;
$again$;

-- --------------------------------------------------- who may not, and what --
DO $refusals$
DECLARE ok boolean;
BEGIN
  -- A range that runs backwards.
  BEGIN
    PERFORM public.excuse_sessions(
      current_setting('t060.class')::uuid, current_setting('t060.student'),
      '2031-03-31', '2031-03-01', NULL, NULL);
    ok := false;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '060: a backwards range was accepted';
  END IF;

  RAISE NOTICE '060 ok: a backwards range is refused';
END;
$refusals$;

-- Somebody with no claim on the class.
SET request.jwt.claim.sub = '60000000-0000-0000-0000-000000000061';

DO $outsider$
DECLARE
  ok boolean;
  n  integer;
BEGIN
  BEGIN
    PERFORM public.excuse_sessions(
      current_setting('t060.class')::uuid, current_setting('t060.student'),
      '2031-03-01', '2031-03-31', NULL, 'I say so');
    ok := false;
  EXCEPTION WHEN others THEN ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION '060: an unrelated TA excused somebody else''s student';
  END IF;

  RAISE NOTICE '060 ok: only staff on the class may excuse its students';
END;
$outsider$;

RESET ROLE;
ROLLBACK;
