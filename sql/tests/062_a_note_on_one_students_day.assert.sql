-- ============================================================================
-- Migration 062 — a note on one student's day
--
-- What is checked:
--
--   a note can be written on a marked session without touching the mark —
--     a note is not a judgement about whether somebody was there
--   a note on a session nobody has marked yet creates a row in 'pending'
--   THE ONE THAT MATTERS: closing that session marks the student absent
--     anyway. close_session used ON CONFLICT DO NOTHING, so before this
--     migration a note on a future session meant that student was silently
--     never marked — no error, no absence, and a percentage wrong all term
--   closing does NOT overwrite a mark somebody made: present stays present,
--     excused stays excused
--   clearing a note takes the row with it when the row existed only to hold
--     the note, and leaves it alone when the student has actually been marked
--   an overlong note is refused
--   somebody with no claim on the class cannot write on it
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

DO $ids$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  SELECT id INTO v_class FROM public.classes ORDER BY created_at LIMIT 1;
  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class
   ORDER BY label LIMIT 1;

  PERFORM set_config('t062.class', v_class::text, true);
  PERFORM set_config('t062.cohort', v_cohort::text, true);
END;
$ids$;

-- Two enrolled students: one gets a note, one is the control.
DO $students$
DECLARE
  v_cohort uuid := current_setting('t062.cohort')::uuid;
  v_ids    text[];
BEGIN
  SELECT array_agg(student_id ORDER BY student_id) INTO v_ids
    FROM (SELECT student_id FROM public.enrolments
           WHERE cohort_id = v_cohort AND dropped_on IS NULL
           ORDER BY student_id LIMIT 2) q;

  IF array_length(v_ids, 1) < 2 THEN
    RAISE EXCEPTION '062: the fixture cohort has fewer than two students';
  END IF;

  PERFORM set_config('t062.noted', v_ids[1], true);
  PERFORM set_config('t062.other', v_ids[2], true);
END;
$students$;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('62000000-0000-0000-0000-000000000062', 'ta@assert-062.test',
   'Class TA', 'approved', false),
  ('62000000-0000-0000-0000-000000000063', 'outsider@assert-062.test',
   'Unrelated TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.class_staff (class_id, staff_id)
SELECT current_setting('t062.class')::uuid, s.id
  FROM public.staff s WHERE s.email = 'ta@assert-062.test'
ON CONFLICT DO NOTHING;

-- One session that has happened and one that has not.
DO $sessions$
DECLARE
  v_class  uuid := current_setting('t062.class')::uuid;
  v_cohort uuid := current_setting('t062.cohort')::uuid;
BEGIN
  INSERT INTO public.class_sessions
    (class_id, cohort_id, starts_at, duration_minutes, status)
  VALUES
    (v_class, v_cohort, '2032-04-06 09:00+00', 60, 'closed'),
    (v_class, v_cohort, '2032-04-13 09:00+00', 60, 'scheduled')
  ON CONFLICT (cohort_id, starts_at) DO NOTHING;

  PERFORM set_config('t062.past',
    (SELECT id::text FROM public.class_sessions
      WHERE cohort_id = v_cohort AND session_date = '2032-04-06'), true);
  PERFORM set_config('t062.future',
    (SELECT id::text FROM public.class_sessions
      WHERE cohort_id = v_cohort AND session_date = '2032-04-13'), true);

  -- The past one already has a mark to write against.
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_by_role)
  VALUES (current_setting('t062.past')::uuid, v_class,
          current_setting('t062.noted'), 'late', 'staff')
  ON CONFLICT (session_id, student_id) DO UPDATE SET state = 'late';
END;
$sessions$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '62000000-0000-0000-0000-000000000062';

-- --------------------------------------- a note leaves the mark alone --
DO $on_a_mark$
DECLARE v_row public.attendance_records%ROWTYPE;
BEGIN
  v_row := public.set_attendance_note(
             current_setting('t062.past')::uuid,
             current_setting('t062.noted'),
             'Arrived 9.40, bus from Madina');

  IF v_row.note <> 'Arrived 9.40, bus from Madina' THEN
    RAISE EXCEPTION '062: the note was stored as %', v_row.note;
  END IF;
  IF v_row.state <> 'late' THEN
    RAISE EXCEPTION '062: writing a note changed the mark to %', v_row.state;
  END IF;

  RAISE NOTICE '062 ok: a note is written without touching the mark';
END;
$on_a_mark$;

-- ------------------------------- a note on a session nobody has marked --
DO $on_nothing$
DECLARE v_row public.attendance_records%ROWTYPE;
BEGIN
  v_row := public.set_attendance_note(
             current_setting('t062.future')::uuid,
             current_setting('t062.noted'),
             'Told me in advance they will miss this');

  IF v_row.state <> 'pending' THEN
    RAISE EXCEPTION '062: a note-only row came back as %', v_row.state;
  END IF;

  RAISE NOTICE '062 ok: a note on an unmarked session makes a pending row';
END;
$on_nothing$;

-- ----------- THE TRAP: closing must still mark that student absent --
--
-- The other student is marked present first, so the check below proves that
-- closing promotes ONLY the row nobody had touched.
INSERT INTO public.attendance_records
  (session_id, class_id, student_id, state, marked_by_role)
VALUES (current_setting('t062.future')::uuid,
        current_setting('t062.class')::uuid,
        current_setting('t062.other'), 'present', 'staff')
ON CONFLICT (session_id, student_id) DO UPDATE SET state = 'present';

DO $closes$
DECLARE
  v_state public.attendance_state;
  v_note  text;
BEGIN
  PERFORM public.close_session(current_setting('t062.future')::uuid);

  SELECT state, note INTO v_state, v_note
    FROM public.attendance_records
   WHERE session_id = current_setting('t062.future')::uuid
     AND student_id = current_setting('t062.noted');

  IF v_state <> 'unexcused' THEN
    RAISE EXCEPTION
      '062: a student whose row only held a note closed as % — before this migration that meant no absence at all',
      v_state;
  END IF;

  -- And the note they were given survives being marked absent.
  IF v_note <> 'Told me in advance they will miss this' THEN
    RAISE EXCEPTION '062: closing threw the note away: %', v_note;
  END IF;

  -- The mark somebody actually made is untouched.
  SELECT state INTO v_state FROM public.attendance_records
   WHERE session_id = current_setting('t062.future')::uuid
     AND student_id = current_setting('t062.other');
  IF v_state <> 'present' THEN
    RAISE EXCEPTION '062: closing overwrote a real mark with %', v_state;
  END IF;

  RAISE NOTICE '062 ok: closing marks the note-only row absent and spares the rest';
END;
$closes$;

-- ------------------------------------------- clearing a note --
DO $clearing$
DECLARE
  n       integer;
  v_state public.attendance_state;
BEGIN
  -- On a row that carries a real mark: the row and the mark stay.
  PERFORM public.set_attendance_note(
    current_setting('t062.past')::uuid, current_setting('t062.noted'), '   ');

  SELECT count(*), max(state) INTO n, v_state
    FROM public.attendance_records
   WHERE session_id = current_setting('t062.past')::uuid
     AND student_id = current_setting('t062.noted');
  IF n <> 1 OR v_state <> 'late' THEN
    RAISE EXCEPTION '062: clearing a note disturbed a marked row (% rows, %)',
      n, v_state;
  END IF;

  -- On a row that existed only to hold the note: it goes.
  PERFORM public.set_attendance_note(
    current_setting('t062.past')::uuid, current_setting('t062.other'),
    'Scratch that');
  PERFORM public.set_attendance_note(
    current_setting('t062.past')::uuid, current_setting('t062.other'), NULL);

  SELECT count(*) INTO n FROM public.attendance_records
   WHERE session_id = current_setting('t062.past')::uuid
     AND student_id = current_setting('t062.other');
  IF n <> 0 THEN
    RAISE EXCEPTION '062: a note-only row outlived its note';
  END IF;

  RAISE NOTICE '062 ok: clearing a note removes the row only when it held nothing else';
END;
$clearing$;

-- ------------------------------------------------- what is refused --
DO $refused$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.set_attendance_note(
      current_setting('t062.past')::uuid, current_setting('t062.noted'),
      repeat('x', 501));
    ok := false;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '062: a 501-character note was accepted';
  END IF;

  RAISE NOTICE '062 ok: an overlong note is refused';
END;
$refused$;

SET request.jwt.claim.sub = '62000000-0000-0000-0000-000000000063';

DO $outsider$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.set_attendance_note(
      current_setting('t062.past')::uuid, current_setting('t062.noted'),
      'I have opinions about this class');
    ok := false;
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '062: an unrelated TA wrote on somebody else''s class';
  END IF;

  RAISE NOTICE '062 ok: only staff on the class may write on it';
END;
$outsider$;

RESET ROLE;
ROLLBACK;
