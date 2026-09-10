-- ============================================================================
-- Migration 028 — the check-in window hangs off the class, not the click
--
-- Every case here is a clock arithmetic case, so each builds a session whose
-- start time sits a known distance from now() and then asks the same three
-- questions: is it live, when does it close, and is a mark present or late.
--
-- The one that matters most is the third: opening fifteen minutes early used
-- to close the window fifteen minutes early, so a TA who did the helpful thing
-- got a session that shut itself before the class had begun.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- ----------------------------------------------------------------------------
-- A session whose start time we control, and a student who may mark at it
-- ----------------------------------------------------------------------------

DO $setup$
DECLARE
  v_class  uuid;
  v_cohort uuid;
BEGIN
  v_class := (public.create_class('ASSERT-029', 'Clock Arithmetic',
                CURRENT_DATE - 30, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_cohort
  FROM public.cohorts WHERE class_id = v_class AND label = 'A';

  PERFORM public.upsert_enrolments(v_cohort,
    '[{"student_id": "E029", "name": "Early Bird"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id = v_cohort;

  CREATE TEMP TABLE t029 ON COMMIT DROP AS
  SELECT v_class AS class_id, v_cohort AS cohort_id;
END
$setup$;

/*
 * Build one session, opened a chosen number of minutes before or after its own
 * start time, and hand back its id.
 *
 * starts_at is set relative to now() and opened_at is written directly, which
 * is the only way to test a clock without waiting on one.
 */
CREATE OR REPLACE FUNCTION pg_temp.session_at(
  p_starts_in_minutes integer,   -- negative: the class already started
  p_opened_at         timestamptz,
  p_early             integer,
  p_auto_close        integer,
  p_late              integer
)
RETURNS uuid
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.class_sessions (
    class_id, cohort_id, starts_at, session_date, duration_minutes,
    status, pin, opened_at,
    early_open_minutes, auto_close_minutes, late_window_minutes
  )
  SELECT
    t.class_id, t.cohort_id,
    now() + make_interval(mins => p_starts_in_minutes),
    (now() + make_interval(mins => p_starts_in_minutes))::date,
    60, 'open',
    'P' || substr(md5(random()::text), 1, 4),
    p_opened_at,
    p_early, p_auto_close, p_late
  FROM t029 t
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- ----------------------------------------------------------------------------
-- THE BUG: opened early, closes late
--
-- Class starts in 15 minutes. The TA opened 15 minutes ago, which is 30
-- minutes before it starts. The window is 20 minutes.
--
-- Before this migration it closed at opened_at + 20 — five minutes from now,
-- and five minutes BEFORE the class began.
-- ----------------------------------------------------------------------------

DO $early$
DECLARE
  v_id uuid;
  s    public.class_sessions%ROWTYPE;
BEGIN
  v_id := pg_temp.session_at(15, now() - interval '15 minutes', 30, 20, 10);
  SELECT * INTO s FROM public.class_sessions WHERE id = v_id;

  IF public.session_closes_at(s) <= s.starts_at THEN
    RAISE EXCEPTION
      'a session opened early closes before its class starts (closes %, starts '
      '%) — opening early spends the window, which is the whole bug',
      public.session_closes_at(s), s.starts_at;
  END IF;

  IF public.session_closes_at(s)
     <> s.starts_at + make_interval(mins => s.auto_close_minutes) THEN
    RAISE EXCEPTION
      'the window does not start counting at the class: closes % but the class '
      'starts % with a % minute window',
      public.session_closes_at(s), s.starts_at, s.auto_close_minutes;
  END IF;

  -- And it is live now, fifteen minutes before the class, because early_open
  -- is 30.
  IF NOT public.session_is_live(s) THEN
    RAISE EXCEPTION 'check-in is not live inside the early-open window';
  END IF;
END
$early$;

-- ----------------------------------------------------------------------------
-- Opened LATE still gets a full window
--
-- 006 already intended this and it must survive: a class that started 40
-- minutes ago and was opened 5 minutes ago has 15 minutes left, not none.
-- ----------------------------------------------------------------------------

DO $late_open$
DECLARE
  v_id uuid;
  s    public.class_sessions%ROWTYPE;
BEGIN
  v_id := pg_temp.session_at(-40, now() - interval '5 minutes', 5, 20, 10);
  SELECT * INTO s FROM public.class_sessions WHERE id = v_id;

  IF NOT public.session_is_live(s) THEN
    RAISE EXCEPTION
      'a session opened late is already closed — opening late must still give '
      'a full window';
  END IF;

  IF public.session_closes_at(s)
     <> s.opened_at + make_interval(mins => s.auto_close_minutes) THEN
    RAISE EXCEPTION 'a late-opened window is not measured from opening';
  END IF;
END
$late_open$;

-- ----------------------------------------------------------------------------
-- early_open is a permission, not just a convenience
--
-- Opened an hour before a class that allows 10 minutes: the door stays shut
-- until 10 minutes before.
-- ----------------------------------------------------------------------------

DO $too_early$
DECLARE
  v_id uuid;
  s    public.class_sessions%ROWTYPE;
BEGIN
  v_id := pg_temp.session_at(60, now() - interval '5 minutes', 10, 20, 10);
  SELECT * INTO s FROM public.class_sessions WHERE id = v_id;

  IF public.session_is_live(s) THEN
    RAISE EXCEPTION
      'check-in is live an hour before a class that opens 10 minutes early';
  END IF;

  IF public.session_opens_at(s)
     <> s.starts_at - make_interval(mins => s.early_open_minutes) THEN
    RAISE EXCEPTION 'opening earlier than allowed moved the opening time';
  END IF;
END
$too_early$;

-- ----------------------------------------------------------------------------
-- A student marking before the class is PRESENT, not late
--
-- Measured from opened_at, somebody marking during the early window would be
-- recorded late before the class had begun.
-- ----------------------------------------------------------------------------

DO $not_late$
DECLARE
  v_id uuid;
  v_pin text;
  r    jsonb;
BEGIN
  -- Class starts in 5 minutes, opened 20 minutes ago, late window 10.
  v_id := pg_temp.session_at(5, now() - interval '20 minutes', 30, 60, 10);
  SELECT pin INTO v_pin FROM public.class_sessions WHERE id = v_id;

  r := public.mark_attendance('E029', v_pin);

  IF NOT (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'marking inside the early window failed: %', r;
  END IF;

  IF r ->> 'state' <> 'present' THEN
    RAISE EXCEPTION
      'marking BEFORE the class started was recorded as %, because lateness is '
      'still measured from when the TA opened rather than from the class',
      r ->> 'state';
  END IF;
END
$not_late$;

-- ----------------------------------------------------------------------------
-- And genuinely late is still late
-- ----------------------------------------------------------------------------

DO $is_late$
DECLARE
  v_id  uuid;
  v_pin text;
  r     jsonb;
BEGIN
  -- Class started 30 minutes ago, opened then, late after 10.
  v_id := pg_temp.session_at(-30, now() - interval '30 minutes', 5, 60, 10);
  SELECT pin INTO v_pin FROM public.class_sessions WHERE id = v_id;

  r := public.mark_attendance('E029', v_pin);

  IF r ->> 'state' <> 'late' THEN
    RAISE EXCEPTION 'marking 30 minutes into a class was recorded as %',
      r ->> 'state';
  END IF;
END
$is_late$;

-- ----------------------------------------------------------------------------
-- Too early gets its own refusal
--
-- Previously a student arriving before check-in opened was told the code was
-- wrong: false, and the one refusal they cannot act on.
-- ----------------------------------------------------------------------------

DO $refusal$
DECLARE
  v_id  uuid;
  v_pin text;
  r     jsonb;
BEGIN
  v_id := pg_temp.session_at(120, now(), 10, 20, 10);
  SELECT pin INTO v_pin FROM public.class_sessions WHERE id = v_id;

  r := public.mark_attendance('E029', v_pin);

  IF (r ->> 'success')::boolean THEN
    RAISE EXCEPTION 'marked two hours before a class that opens 10 early';
  END IF;

  IF r ->> 'reason' <> 'not_open_yet' THEN
    RAISE EXCEPTION
      'a student who is early is told "%" — they can act on "not open yet" and '
      'on nothing else', r ->> 'reason';
  END IF;
END
$refusal$;

-- ----------------------------------------------------------------------------
-- The anon summary agrees with all of it, and still says nothing else
-- ----------------------------------------------------------------------------

RESET ROLE;
SET ROLE anon;

DO $summary$
DECLARE
  r    jsonb := public.get_open_session_summary();
  keys text[];
BEGIN
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(r) AS k;

  IF keys <> ARRAY['closes_at', 'open_count'] THEN
    RAISE EXCEPTION
      'the summary gained a field while its window logic changed: %', keys;
  END IF;

  -- The sessions built above are live, so it must see them.
  IF (r ->> 'open_count')::int < 1 THEN
    RAISE EXCEPTION 'the summary counts no live session: %', r;
  END IF;
END
$summary$;

DO $done$ BEGIN RAISE NOTICE '029 check-in window assertions passed'; END $done$;

ROLLBACK;
