-- ============================================================================
-- Migration 031 — sessions open and close themselves
--
-- The cases that matter are the ones where doing nothing looks the same as
-- working. A sweep that opens a class three hours early, or one that quietly
-- fails to write the absences on close, both leave a database that reads as
-- plausible right up until somebody checks a percentage at the end of term.
--
-- The absence one is the reason this is not cosmetic: close is what writes the
-- explicit 'unexcused' row. If closing does not happen, the absence does not
-- exist — migration 004's whole premise is that it is a stored fact and not a
-- calculation, so there is nothing to fall back on.
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
BEGIN
  v_class := (public.create_class('ASSERT-031', 'Sweeping',
                CURRENT_DATE - 30, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "S031A", "name": "One"},
      {"student_id": "S031B", "name": "Two"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  -- Four sessions, each a different moment relative to now.
  --
  --   future  starts in 3 hours, 15 minute allowance -> must stay shut
  --   due     starts in 5 minutes, 15 minute allowance -> must open
  --   stale   opened, window four hours gone -> must close
  --   missed  started yesterday, never opened -> must stay shut
  CREATE TEMP TABLE t031 ON COMMIT DROP AS
  WITH ins AS (
    INSERT INTO public.class_sessions
      (class_id, cohort_id, starts_at, duration_minutes, status, opened_at,
       early_open_minutes, auto_close_minutes, late_window_minutes, pin)
    VALUES
      (v_class, v_cohort, now() + interval '3 hours',    60, 'scheduled', NULL, 15, 15, 10, NULL),
      (v_class, v_cohort, now() + interval '5 minutes',  60, 'scheduled', NULL, 15, 15, 10, NULL),
      (v_class, v_cohort, now() - interval '4 hours',    60, 'open',
         now() - interval '4 hours', 15, 15, 10, 'S0311'),
      (v_class, v_cohort, now() - interval '1 day',      60, 'scheduled', NULL, 15, 15, 10, NULL)
    RETURNING id, starts_at, status
  )
  SELECT
    (SELECT id FROM ins WHERE starts_at > now() + interval '2 hours')  AS future_id,
    (SELECT id FROM ins WHERE starts_at BETWEEN now() AND now() + interval '10 minutes') AS due_id,
    (SELECT id FROM ins WHERE starts_at BETWEEN now() - interval '5 hours' AND now() - interval '3 hours') AS stale_id,
    (SELECT id FROM ins WHERE starts_at < now() - interval '12 hours')  AS missed_id,
    v_class  AS class_id,
    v_cohort AS cohort_id;
END;
$setup$;

-- ------------------------------------------------------------------ opening --
DO $opening$
DECLARE
  t        record;
  v_opened integer;
  v_status public.session_status;
  v_pin    text;
BEGIN
  SELECT * INTO t FROM t031;

  -- Through the RPC, not the halves. open_due_sessions and close_due_sessions
  -- are revoked from `authenticated` deliberately — sync_sessions is the only
  -- way in for staff, so testing the halves directly would prove the sweep
  -- works while leaving the door nobody can actually open untested.
  v_opened := (public.sync_sessions() ->> 'opened')::integer;

  SELECT status, pin INTO v_status, v_pin
  FROM public.class_sessions WHERE id = t.due_id;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      '031: a class five minutes away with a fifteen minute allowance did not open (status %)',
      v_status;
  END IF;
  IF v_pin IS NULL OR length(v_pin) <> 5 THEN
    RAISE EXCEPTION
      '031: opened without a usable PIN (%) — nobody could check in', COALESCE(v_pin, 'NULL');
  END IF;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = t.future_id;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION
      '031: a class three hours away was opened — the allowance is fifteen minutes, not the whole day';
  END IF;

  -- The one that would be embarrassing after an outage: come back up on Monday
  -- and mint live PINs for every lecture missed over the weekend.
  SELECT status INTO v_status FROM public.class_sessions WHERE id = t.missed_id;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION
      '031: yesterday''s class was opened today — a sweep after downtime must not open finished lectures';
  END IF;

  RAISE NOTICE '031 ok: opened % due, left the future and the missed alone', v_opened;
END;
$opening$;

-- ------------------------------------------------------------------ closing --
DO $closing$
DECLARE
  t          record;
  v_closed   integer;
  v_status   public.session_status;
  v_absences integer;
BEGIN
  SELECT * INTO t FROM t031;

  -- The first sync already closed it; this one reports zero and proves that.
  v_closed := (public.sync_sessions() ->> 'closed')::integer;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = t.stale_id;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION
      '031: a session four hours past its window is still open — check-in refuses marks but the row never closes';
  END IF;

  -- Nobody marked it, so both enrolled students must now have a stored absence.
  SELECT count(*) INTO v_absences
  FROM public.attendance_records
  WHERE session_id = t.stale_id
    AND state = 'unexcused'
    AND marked_by_role = 'system';

  IF v_absences <> 2 THEN
    RAISE EXCEPTION
      '031: closing recorded % absences, expected 2 — the absence is the row, so it simply would not exist',
      v_absences;
  END IF;

  -- And the session it opened a moment ago must not be closed in the same pass.
  SELECT status INTO v_status FROM public.class_sessions WHERE id = t.due_id;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION '031: the sweep closed the session it had just opened';
  END IF;

  IF v_closed <> 0 THEN
    RAISE EXCEPTION
      '031: the second sweep closed % more session(s) — the first one left work behind',
      v_closed;
  END IF;

  RAISE NOTICE '031 ok: the expired session closed and recorded % absences', v_absences;
END;
$closing$;

-- -------------------------------------------------------------- idempotency --
-- pg_cron runs this every minute. If a second pass re-opened or re-closed
-- anything, every minute would mint a new PIN mid-class or rewrite marked_at.
DO $again$
DECLARE
  t         record;
  v_pin     text;
  v_pin_now text;
BEGIN
  SELECT * INTO t FROM t031;
  SELECT pin INTO v_pin FROM public.class_sessions WHERE id = t.due_id;

  IF (public.sync_sessions() ->> 'opened')::integer <> 0 THEN
    RAISE EXCEPTION '031: a second sweep opened something again';
  END IF;
  IF (public.sync_sessions() ->> 'closed')::integer <> 0 THEN
    RAISE EXCEPTION '031: a second sweep closed something again';
  END IF;

  SELECT pin INTO v_pin_now FROM public.class_sessions WHERE id = t.due_id;
  IF v_pin_now IS DISTINCT FROM v_pin THEN
    RAISE EXCEPTION
      '031: the PIN changed on a second sweep (% -> %) — it is on a projector mid-class',
      v_pin, v_pin_now;
  END IF;

  RAISE NOTICE '031 ok: sweeping twice changes nothing';
END;
$again$;

-- --------------------------------------------- closing preserves a check-in --
DO $preserve$
DECLARE
  t         record;
  v_session uuid;
  v_state   public.attendance_state;
BEGIN
  SELECT * INTO t FROM t031;

  INSERT INTO public.class_sessions
    (class_id, cohort_id, starts_at, duration_minutes, status, opened_at,
     early_open_minutes, auto_close_minutes, late_window_minutes, pin)
  VALUES
    (t.class_id, t.cohort_id, now() - interval '2 hours', 60, 'open',
     now() - interval '2 hours', 15, 15, 10, 'S0312')
  RETURNING id INTO v_session;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_session, t.class_id, 'S031A', 'present', now(), 'student');

  PERFORM public.sync_sessions();

  SELECT state INTO v_state
  FROM public.attendance_records
  WHERE session_id = v_session AND student_id = 'S031A';

  IF v_state <> 'present' THEN
    RAISE EXCEPTION
      '031: auto-close overwrote a student who had marked present (now %)', v_state;
  END IF;

  -- And the other student, who did not mark, must have picked up an absence.
  SELECT state INTO v_state
  FROM public.attendance_records
  WHERE session_id = v_session AND student_id = 'S031B';

  IF v_state IS DISTINCT FROM 'unexcused' THEN
    RAISE EXCEPTION
      '031: the student who did not mark was left with % rather than an absence',
      COALESCE(v_state::text, 'no row at all');
  END IF;

  RAISE NOTICE '031 ok: closing keeps check-ins and records only the unmarked';
END;
$preserve$;

ROLLBACK;
