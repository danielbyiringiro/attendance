-- ============================================================================
-- Migration 041 — a class's check-in on another screen, behind a code
--
-- get_class_display is the first function since mark_attendance that hands a
-- signed-out caller something worth having: a live PIN. So most of what is
-- asserted here is what it must NOT return, and to whom — a scheduled
-- session's PIN, another class's code, anything at all for a wrong code, and a
-- different answer for a wrong link than for a wrong code.
--
-- The lock is pinned to exactly ten: nine wrong codes still let the right one
-- in, the tenth shuts it.
--
-- Values are passed between blocks as transaction-local settings rather than a
-- temp table, so the blocks running as anon need no grant on anything.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_dow     integer := EXTRACT(DOW FROM CURRENT_DATE)::integer;
  v_class   uuid;
  v_a       uuid;
  v_b       uuid;
  v_other   uuid;
  v_other_a uuid;
  v_sa      uuid;
  v_sb      uuid;
  v_so      uuid;
  r         jsonb;
BEGIN
  v_class := (public.create_class('ASSERT-041', 'Display',
                CURRENT_DATE - 7, CURRENT_DATE + 30, 'Africa/Accra', 2) ->> 'class_id')::uuid;
  SELECT id INTO v_a FROM public.cohorts WHERE class_id = v_class AND label = 'A';
  SELECT id INTO v_b FROM public.cohorts WHERE class_id = v_class AND label = 'B';

  PERFORM public.set_cohort_schedules(ARRAY[v_a, v_b],
    format('[{"weekday": %s, "start_time": "09:00"}]', v_dow)::jsonb);
  PERFORM public.generate_sessions(v_class, NULL, CURRENT_DATE, CURRENT_DATE);

  SELECT id INTO v_sa FROM public.class_sessions WHERE cohort_id = v_a LIMIT 1;
  SELECT id INTO v_sb FROM public.class_sessions WHERE cohort_id = v_b LIMIT 1;
  IF v_sa IS NULL OR v_sb IS NULL THEN
    RAISE EXCEPTION '041 setup: expected a session today for both cohorts';
  END IF;

  -- Cohort A is open; cohort B is still scheduled for later today.
  PERFORM public.open_session(v_sa, 'D41PIN', 60);

  -- Another class, open, with a link of its own. Nothing of it may appear on
  -- the first class's screen.
  v_other := (public.create_class('ASSERT-041B', 'Elsewhere',
                CURRENT_DATE - 7, CURRENT_DATE + 30) ->> 'class_id')::uuid;
  SELECT id INTO v_other_a FROM public.cohorts WHERE class_id = v_other AND label = 'A';
  PERFORM public.set_cohort_schedules(ARRAY[v_other_a],
    format('[{"weekday": %s, "start_time": "09:00"}]', v_dow)::jsonb);
  PERFORM public.generate_sessions(v_other, NULL, CURRENT_DATE, CURRENT_DATE);
  SELECT id INTO v_so FROM public.class_sessions WHERE cohort_id = v_other_a LIMIT 1;
  PERFORM public.open_session(v_so, 'OTHER1', 60);
  PERFORM public.issue_display_code(v_other);

  r := public.issue_display_code(v_class);

  PERFORM set_config('t041.class',     v_class::text,      true);
  PERFORM set_config('t041.session_b', v_sb::text,         true);
  PERFORM set_config('t041.token',     r ->> 'token',      true);
  PERFORM set_config('t041.code',      r ->> 'code',       true);
END;
$setup$;

-- A PIN on cohort B's session, which is still scheduled. The screen must never
-- show it. Planted as the owner because staff do not write PINs directly.
RESET ROLE;
UPDATE public.class_sessions SET pin = 'LEAKME'
 WHERE id = current_setting('t041.session_b')::uuid;

-- ------------------------------------------------------------ the shapes --
DO $shapes$
DECLARE
  v_token text := current_setting('t041.token');
  v_code  text := current_setting('t041.code');
BEGIN
  IF v_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '041: the link token is not 64 hex characters: %', v_token;
  END IF;
  IF v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$' THEN
    RAISE EXCEPTION '041: the access code is not six unambiguous characters: %', v_code;
  END IF;

  RAISE NOTICE '041 ok: token and code have the shapes the header promises';
END;
$shapes$;

SET ROLE anon;

-- --------------------------------------------- what the right code shows --
DO $shows$
DECLARE
  v_token text := current_setting('t041.token');
  v_code  text := current_setting('t041.code');
  r       jsonb;
BEGIN
  r := public.get_class_display(v_token, v_code);

  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '041: the right link and code were refused: %', r;
  END IF;

  IF r ->> 'class_name' <> 'Display' OR r ->> 'class_code' <> 'ASSERT-041' THEN
    RAISE EXCEPTION '041: the screen named the wrong class: %', r;
  END IF;

  IF jsonb_array_length(r -> 'sessions') <> 2 THEN
    RAISE EXCEPTION '041: expected cohort A open and cohort B later today, got %',
      r -> 'sessions';
  END IF;

  IF position('D41PIN' IN r::text) = 0 THEN
    RAISE EXCEPTION '041: the open session''s code is not on the screen: %', r;
  END IF;

  IF position('LEAKME' IN r::text) > 0 THEN
    RAISE EXCEPTION '041: a scheduled session''s PIN was handed to a signed-out screen';
  END IF;

  IF position('OTHER1' IN r::text) > 0 THEN
    RAISE EXCEPTION '041: another class''s live code appeared on this class''s screen';
  END IF;

  -- Typed in lower case with a dash in the middle, the way people do.
  r := public.get_class_display(v_token,
         lower(substr(v_code, 1, 3)) || '-' || lower(substr(v_code, 4)));
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '041: the code was refused for its case or a dash: %', r;
  END IF;

  RAISE NOTICE '041 ok: the right code shows this class, its open PIN, and nothing else';
END;
$shows$;

-- ------------------------------------------------------------- refusals --
DO $refusals$
DECLARE
  v_token     text := current_setting('t041.token');
  v_code      text := current_setting('t041.code');
  wrong_code  jsonb;
  wrong_token jsonb;
BEGIN
  -- '1' is not in the alphabet, so this can never be the real code. This is
  -- the FIRST wrong attempt counted against the link; $lock$ relies on it.
  wrong_code  := public.get_class_display(v_token, 'WRONG1');
  wrong_token := public.get_class_display(repeat('0', 64), v_code);

  IF wrong_code <> '{"ok": false, "reason": "refused"}'::jsonb THEN
    RAISE EXCEPTION '041: a wrong code got more than a refusal: %', wrong_code;
  END IF;

  IF wrong_code <> wrong_token THEN
    RAISE EXCEPTION '041: a wrong link and a wrong code answer differently (% vs %), '
      'so links can be tested', wrong_token, wrong_code;
  END IF;

  IF public.get_class_display(NULL, v_code) <> wrong_code
     OR public.get_class_display(v_token, NULL) <> wrong_code THEN
    RAISE EXCEPTION '041: a missing link or code was not refused like any other';
  END IF;

  -- anon has no way in other than the function.
  IF has_table_privilege('anon', 'public.class_display_links', 'SELECT') THEN
    RAISE EXCEPTION '041: anon can read class_display_links, which holds every code';
  END IF;
  IF has_function_privilege('anon', 'public.issue_display_code(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.revoke_display_link(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '041: anon can issue or revoke display codes';
  END IF;

  RAISE NOTICE '041 ok: wrong link, wrong code and missing values are one indistinguishable refusal';
END;
$refusals$;

-- ----------------------------------------------------------------- lock --
DO $lock$
DECLARE
  v_token text := current_setting('t041.token');
  v_code  text := current_setting('t041.code');
  r       jsonb;
BEGIN
  -- One wrong attempt from $refusals$, eight more here: nine.
  FOR i IN 1..8 LOOP
    PERFORM public.get_class_display(v_token, 'WRONG1');
  END LOOP;

  r := public.get_class_display(v_token, v_code);
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '041: the link locked before the tenth wrong code: %', r;
  END IF;

  -- The tenth.
  PERFORM public.get_class_display(v_token, 'WRONG1');

  r := public.get_class_display(v_token, v_code);
  IF r ->> 'reason' IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION '041: ten wrong codes did not lock the link: %', r;
  END IF;

  RAISE NOTICE '041 ok: nine wrong codes leave the link usable, the tenth locks it';
END;
$lock$;

-- ------------------------------------------------------------ staff side --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $staff$
DECLARE
  v_class uuid := current_setting('t041.class')::uuid;
  v_link  public.class_display_links%ROWTYPE;
BEGIN
  SELECT * INTO v_link FROM public.class_display_links WHERE class_id = v_class;
  IF NOT FOUND OR v_link.access_code <> current_setting('t041.code') THEN
    RAISE EXCEPTION '041: staff on the class cannot read back its display code';
  END IF;

  IF has_table_privilege('authenticated', 'public.class_display_links', 'UPDATE') THEN
    RAISE EXCEPTION '041: staff can write the link table directly, around the functions';
  END IF;

  RAISE NOTICE '041 ok: staff read their link, and change it only through the functions';
END;
$staff$;

-- Somebody signed in who is not on the class.
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

DO $outsider$
DECLARE
  v_class   uuid := current_setting('t041.class')::uuid;
  v_seen    integer;
  v_refused integer := 0;
BEGIN
  SELECT count(*) INTO v_seen FROM public.class_display_links WHERE class_id = v_class;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION '041: staff not on the class can read its display code';
  END IF;

  BEGIN PERFORM public.issue_display_code(v_class);
  EXCEPTION WHEN OTHERS THEN v_refused := v_refused + 1; END;

  BEGIN PERFORM public.revoke_display_link(v_class);
  EXCEPTION WHEN OTHERS THEN v_refused := v_refused + 1; END;

  IF v_refused <> 2 THEN
    RAISE EXCEPTION '041: staff not on the class issued or revoked its display code';
  END IF;

  RAISE NOTICE '041 ok: staff on another class can neither see nor change this link';
END;
$outsider$;

SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

-- ------------------------------------------------------------- new code --
DO $new_code$
DECLARE
  v_class uuid := current_setting('t041.class')::uuid;
  r       jsonb;
  v_link  public.class_display_links%ROWTYPE;
BEGIN
  r := public.issue_display_code(v_class);

  IF r ->> 'token' <> current_setting('t041.token') THEN
    RAISE EXCEPTION '041: a new code changed the link, so every link already sent stopped working';
  END IF;

  SELECT * INTO v_link FROM public.class_display_links WHERE class_id = v_class;
  IF v_link.failed_attempts <> 0 THEN
    RAISE EXCEPTION '041: a new code left the link locked (% attempts)', v_link.failed_attempts;
  END IF;

  PERFORM set_config('t041.old_code', current_setting('t041.code'), true);
  PERFORM set_config('t041.code',     r ->> 'code',                 true);
END;
$new_code$;

SET ROLE anon;

DO $after_new_code$
DECLARE
  v_token text := current_setting('t041.token');
  r       jsonb;
BEGIN
  r := public.get_class_display(v_token, current_setting('t041.code'));
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '041: the new code does not open the unlocked link: %', r;
  END IF;

  -- One chance in 887 million that the two codes coincide; skip rather than fail.
  IF current_setting('t041.old_code') <> current_setting('t041.code') THEN
    r := public.get_class_display(v_token, current_setting('t041.old_code'));
    IF COALESCE((r ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION '041: the replaced code still opens the screen';
    END IF;
  END IF;

  RAISE NOTICE '041 ok: a new code keeps the link, clears the lock, and retires the old code';
END;
$after_new_code$;

-- --------------------------------------------------------------- revoke --
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $revoke$
BEGIN
  IF NOT public.revoke_display_link(current_setting('t041.class')::uuid) THEN
    RAISE EXCEPTION '041: revoking an existing link reported nothing to revoke';
  END IF;
END;
$revoke$;

SET ROLE anon;

DO $after_revoke$
DECLARE r jsonb;
BEGIN
  r := public.get_class_display(current_setting('t041.token'), current_setting('t041.code'));
  IF COALESCE((r ->> 'ok')::boolean, false) THEN
    RAISE EXCEPTION '041: a revoked link still shows the class';
  END IF;
END;
$after_revoke$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $reissue$
DECLARE r jsonb;
BEGIN
  r := public.issue_display_code(current_setting('t041.class')::uuid);
  IF r ->> 'token' = current_setting('t041.token') THEN
    RAISE EXCEPTION '041: a link issued after revoking reused the old token, so the old URL came back';
  END IF;

  RAISE NOTICE '041 ok: revoking kills the link, and the next one has a new address';
END;
$reissue$;

ROLLBACK;
