-- ============================================================================
-- Migration 052 — a day off says what it is, in a colour that was chosen
--
-- The colour is the small half. The half worth testing is that declaring a day
-- off twice now CORRECTS it: before 052 the insert was ON CONFLICT DO NOTHING,
-- so a second call kept the first reason and threw the new one away without
-- saying so. A test that only checked "a row exists afterwards" passed on that
-- bug, which is why every assertion here reads the row back.
--
-- What is checked:
--
--   a day off with no colour asked for is amber, and says so
--   a named colour is stored, and lower-cased on the way in
--   a colour that is not one of the six is refused
--   that refusal writes NOTHING — no declaration, no touched session
--   re-declaring corrects the reason, the colour and the mode, in one row
--   correcting the words leaves every attendance record alone
--   changing the MODE does rewrite them
--   the CHECK constraint refuses a bad colour even without the function
--   a student's own history carries the colour, so both calendars agree
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
  v_trip   uuid;
BEGIN
  v_class := (public.create_class('ASSERT-052', 'Days off, in colour',
                CURRENT_DATE - 30, CURRENT_DATE + 60, 'Africa/Accra', 1) ->> 'class_id')::uuid;

  SELECT id INTO v_cohort FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S052A", "name": "One"},
      {"student_id": "S052B", "name": "Two"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- Made here, before anything is declared off: 038 refuses to add a session
  -- to a date the class does not meet, so a fixture that declares first can
  -- never build the case the later blocks need.
  v_trip := (public.create_ad_hoc_session(v_cohort, (CURRENT_DATE + 21)::date,
                                          TIME '11:00') ->> 'session_id')::uuid;

  CREATE TEMP TABLE t052 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id, v_trip AS trip_session,
         (CURRENT_DATE + 14)::date AS holiday,
         (CURRENT_DATE + 21)::date AS trip,
         (CURRENT_DATE + 28)::date AS untouched;
END;
$setup$;

-- ------------------------------------------------- no colour asked for: amber --
DO $defaults$
DECLARE
  t       record;
  v_out   jsonb;
  v_hue   text;
BEGIN
  SELECT * INTO t FROM t052;

  v_out := public.set_no_class_day(t.class_id, t.holiday, 'exempt', 'Founders Day');

  IF v_out ->> 'hue' <> 'amber' THEN
    RAISE EXCEPTION '052: a day off with no colour came back as %', v_out ->> 'hue';
  END IF;
  IF (v_out ->> 'edited')::boolean THEN
    RAISE EXCEPTION '052: declaring a new day off reported itself as an edit';
  END IF;

  SELECT d.hue INTO v_hue FROM public.no_class_days d
   WHERE d.class_id = t.class_id AND d.on_date = t.holiday;
  IF v_hue IS DISTINCT FROM 'amber' THEN
    RAISE EXCEPTION '052: stored colour was % rather than amber', v_hue;
  END IF;

  RAISE NOTICE '052 ok: a day off with no colour asked for is amber';
END;
$defaults$;

-- ------------------------------------------------------ a named colour sticks --
DO $named$
DECLARE
  t     record;
  v_out jsonb;
  v_row record;
BEGIN
  SELECT * INTO t FROM t052;

  -- Upper case on the way in, to prove the function normalises rather than
  -- leaning on the caller to.
  v_out := public.set_no_class_day(
    t.class_id, t.trip, 'present', 'Field trip', NULL, 'TEAL');

  IF v_out ->> 'hue' <> 'teal' THEN
    RAISE EXCEPTION '052: TEAL came back as %', v_out ->> 'hue';
  END IF;

  SELECT d.hue, d.mode, d.reason INTO v_row FROM public.no_class_days d
   WHERE d.class_id = t.class_id AND d.on_date = t.trip;
  IF v_row.hue <> 'teal' OR v_row.mode <> 'present' OR v_row.reason <> 'Field trip' THEN
    RAISE EXCEPTION '052: stored %, %, % for the field trip',
      v_row.hue, v_row.mode, v_row.reason;
  END IF;

  RAISE NOTICE '052 ok: a named colour is stored, however it was typed';
END;
$named$;

-- --------------------------------------- a colour outside the six is refused --
-- And refused before anything is written. The check sits above the declaration
-- and above the session loop on purpose: a caller that sends a hex should not
-- discover it by finding a term's sessions rewritten.
DO $bad_hue$
DECLARE
  t       record;
  v_sess  uuid;
  ok      boolean;
  v_why   text;
  v_count integer;
  v_status public.session_status;
BEGIN
  SELECT * INTO t FROM t052;

  v_sess := (public.create_ad_hoc_session(t.cohort_id, t.untouched, TIME '09:00')
             ->> 'session_id')::uuid;
  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_sess, t.class_id, 'S052A', 'present', now(), 'student');

  BEGIN
    PERFORM public.set_no_class_day(
      t.class_id, t.untouched, 'exempt', 'Reading week', NULL, '#ff0000');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
    v_why := SQLERRM;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '052: a hex colour was accepted';
  END IF;

  -- The message matters, not just the refusal. The table's CHECK would also
  -- raise here, so a test that accepted any error would pass with the
  -- function's own check deleted — and the caller would get "violates check
  -- constraint no_class_days_hue_known" instead of the six names it could use.
  IF v_why NOT LIKE '%amber%' THEN
    RAISE EXCEPTION '052: refused, but not by the function — it said %', v_why;
  END IF;

  SELECT count(*) INTO v_count FROM public.no_class_days d
   WHERE d.class_id = t.class_id AND d.on_date = t.untouched;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '052: the refused call declared the day anyway';
  END IF;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = v_sess;
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION '052: the refused call moved the session to %', v_status;
  END IF;

  SELECT count(*) INTO v_count FROM public.attendance_records
   WHERE session_id = v_sess AND state = 'present';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '052: the refused call rewrote attendance';
  END IF;

  RAISE NOTICE '052 ok: a colour outside the six is refused, and writes nothing';
END;
$bad_hue$;

-- ------------------------------------------- declaring twice corrects the day --
-- The behaviour ON CONFLICT DO NOTHING got wrong. One row, new words.
DO $corrects$
DECLARE
  t       record;
  v_out   jsonb;
  v_row   record;
  v_count integer;
BEGIN
  SELECT * INTO t FROM t052;

  v_out := public.set_no_class_day(
    t.class_id, t.holiday, 'exempt', 'Founders'' Day (observed)', NULL, 'violet');

  IF NOT (v_out ->> 'edited')::boolean THEN
    RAISE EXCEPTION '052: correcting a declared day did not report itself as an edit';
  END IF;

  SELECT count(*) INTO v_count FROM public.no_class_days d
   WHERE d.class_id = t.class_id AND d.on_date = t.holiday;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '052: correcting a day off left % rows', v_count;
  END IF;

  SELECT d.reason, d.hue, d.mode INTO v_row FROM public.no_class_days d
   WHERE d.class_id = t.class_id AND d.on_date = t.holiday;
  IF v_row.reason <> 'Founders'' Day (observed)' THEN
    RAISE EXCEPTION '052: the reason is still %', v_row.reason;
  END IF;
  IF v_row.hue <> 'violet' THEN
    RAISE EXCEPTION '052: the colour is still %', v_row.hue;
  END IF;

  RAISE NOTICE '052 ok: declaring a day off twice corrects it';
END;
$corrects$;

-- ------------------------------ correcting words leaves attendance untouched --
-- A typo is not a change to what the day means, so it must not hand every
-- student on the roster a new marked_at.
DO $cheap_edit$
DECLARE
  t        record;
  v_sess   uuid;
  v_out    jsonb;
  v_before timestamptz;
  v_after  timestamptz;
BEGIN
  SELECT * INTO t FROM t052;

  -- The field trip is 'present', so the session seeded in $setup$ was kept and
  -- everybody on the roster marked against it.
  v_sess := t.trip_session;

  SELECT max(a.marked_at) INTO v_before FROM public.attendance_records a
   WHERE a.session_id = v_sess;
  IF v_before IS NULL THEN
    RAISE EXCEPTION '052: the fixture wrote no attendance, so the next check proves nothing';
  END IF;

  v_out := public.set_no_class_day(
    t.class_id, t.trip, 'present', 'Field trip to the dam', NULL, 'blue');

  IF (v_out ->> 'sessions')::integer <> 0 OR (v_out ->> 'students')::integer <> 0 THEN
    RAISE EXCEPTION '052: a words-only edit touched % sessions and % students',
      v_out ->> 'sessions', v_out ->> 'students';
  END IF;

  SELECT max(a.marked_at) INTO v_after FROM public.attendance_records a
   WHERE a.session_id = v_sess;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '052: a words-only edit rewrote attendance';
  END IF;

  RAISE NOTICE '052 ok: correcting the words leaves attendance alone';
END;
$cheap_edit$;

-- ------------------------------------------- changing the mode does rewrite --
-- The other half of the same rule: exempt and present mean opposite things to a
-- percentage, so switching between them has to reach the records.
DO $mode_change$
DECLARE
  t       record;
  v_out   jsonb;
  v_state text;
BEGIN
  SELECT * INTO t FROM t052;

  v_out := public.set_no_class_day(
    t.class_id, t.trip, 'exempt', 'Field trip, cancelled', NULL, 'rose');

  IF (v_out ->> 'sessions')::integer = 0 AND (v_out ->> 'removed')::integer = 0 THEN
    RAISE EXCEPTION '052: changing the mode touched nothing';
  END IF;

  SELECT DISTINCT a.state::text INTO v_state
    FROM public.attendance_records a
    JOIN public.class_sessions c ON c.id = a.session_id
   WHERE c.class_id = t.class_id AND c.session_date = t.trip;
  IF v_state IS DISTINCT FROM 'exempted' THEN
    RAISE EXCEPTION '052: after switching to exempt the records read %', v_state;
  END IF;

  RAISE NOTICE '052 ok: changing the mode rewrites what the day did';
END;
$mode_change$;

-- ------------------------------------ the constraint stands without the door --
-- The function refuses a bad colour; so must the table, for anything that
-- reaches it another way.
RESET ROLE;

DO $constraint$
DECLARE
  t  record;
  ok boolean;
BEGIN
  SELECT * INTO t FROM t052;

  BEGIN
    INSERT INTO public.no_class_days (class_id, on_date, mode, reason, hue)
    VALUES (t.class_id, CURRENT_DATE + 40, 'exempt', 'Straight in', 'chartreuse');
    ok := false;
  EXCEPTION WHEN check_violation THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '052: the table accepted a colour outside the six';
  END IF;

  RAISE NOTICE '052 ok: the CHECK refuses a colour the function never saw';
END;
$constraint$;

-- ------------------------------- the student sees the same day, same colour --
-- 045 gave the student the reason; 052 has to give them the colour with it, or
-- the two calendars disagree about a day that is the same day.
DO $student_side$
DECLARE
  t       record;
  v_out   jsonb;
  v_day   jsonb;
BEGIN
  SELECT * INTO t FROM t052;

  v_out := public.get_student_attendance('S052A');

  SELECT d INTO v_day
    FROM jsonb_array_elements(v_out -> 'days_off') AS d
   WHERE (d ->> 'date')::date = t.holiday;

  IF v_day IS NULL THEN
    RAISE EXCEPTION '052: the student cannot see the day off at all';
  END IF;
  IF v_day ->> 'hue' IS NULL THEN
    RAISE EXCEPTION '052: the student sees the day off but not its colour';
  END IF;
  -- $corrects$ left this one violet.
  IF v_day ->> 'hue' <> 'violet' THEN
    RAISE EXCEPTION '052: the student sees % where staff see violet', v_day ->> 'hue';
  END IF;
  IF v_day ->> 'reason' IS NULL OR v_day ->> 'reason' = '' THEN
    RAISE EXCEPTION '052: the colour arrived without the reason it belongs to';
  END IF;

  RAISE NOTICE '052 ok: the student''s calendar gets the same colour as the staff one';
END;
$student_side$;

ROLLBACK;
