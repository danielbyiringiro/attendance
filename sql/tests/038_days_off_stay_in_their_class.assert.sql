-- ============================================================================
-- Migrations 036-038 — a day off affects one class and no other
--
-- Worth asserting rather than reading, because the blast radius if it were
-- wrong is the worst kind: declaring a holiday in one course would silently
-- exempt students in someone else's, and every affected rate would still look
-- entirely plausible. Nobody would find it from the screen.
--
-- Two classes, the same date, checked in both directions. Plus the integrity
-- guard 038 adds, since 036 shipped a CHECK that was a tautology.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

SET ROLE authenticated;
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

DO $setup$
DECLARE
  v_mine    uuid;
  v_theirs  uuid;
  v_c_mine  uuid;
  v_c_yours uuid;
BEGIN
  v_mine   := (public.create_class('ASSERT-038A', 'Mine',
                 CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;
  v_theirs := (public.create_class('ASSERT-038B', 'Theirs',
                 CURRENT_DATE - 30, CURRENT_DATE + 60) ->> 'class_id')::uuid;

  SELECT id INTO v_c_mine  FROM public.cohorts WHERE class_id = v_mine   AND label = 'A';
  SELECT id INTO v_c_yours FROM public.cohorts WHERE class_id = v_theirs AND label = 'A';

  PERFORM public.upsert_enrolments(v_c_mine,
    '[{"student_id": "S038A", "name": "Mine"}]'::jsonb);
  PERFORM public.upsert_enrolments(v_c_yours,
    '[{"student_id": "S038B", "name": "Theirs"}]'::jsonb);
  UPDATE public.enrolments SET enrolled_on = CURRENT_DATE - 30
   WHERE cohort_id IN (v_c_mine, v_c_yours);

  CREATE TEMP TABLE t038 ON COMMIT DROP AS
  SELECT v_mine AS mine, v_theirs AS theirs,
         v_c_mine AS cohort_mine, v_c_yours AS cohort_theirs,
         (CURRENT_DATE + 21)::date AS shared_date;
END;
$setup$;

DO $isolated$
DECLARE
  t        record;
  v_ours   uuid;
  v_yours  uuid;
  v_status public.session_status;
  v_states text[];
BEGIN
  SELECT * INTO t FROM t038;

  -- The same date, a session in each class, each with a check-in so there is
  -- something to destroy if the scoping is wrong.
  v_ours  := (public.create_ad_hoc_session(t.cohort_mine,   t.shared_date, TIME '09:00') ->> 'session_id')::uuid;
  v_yours := (public.create_ad_hoc_session(t.cohort_theirs, t.shared_date, TIME '09:00') ->> 'session_id')::uuid;

  INSERT INTO public.attendance_records
    (session_id, class_id, student_id, state, marked_at, marked_by_role)
  VALUES (v_ours,  t.mine,   'S038A', 'present', now(), 'student'),
         (v_yours, t.theirs, 'S038B', 'present', now(), 'student');

  -- Declare the holiday in one class only.
  PERFORM public.set_no_class_day(t.mine, t.shared_date, 'exempt', 'Our holiday');

  -- Ours is exempted.
  SELECT array_agg(DISTINCT state::text) INTO v_states
  FROM public.attendance_records WHERE session_id = v_ours;
  IF v_states <> ARRAY['exempted'] THEN
    RAISE EXCEPTION '038: our own session was not exempted (%)',
      array_to_string(v_states, ', ');
  END IF;

  -- Theirs is untouched. State AND status, because a holiday that closed
  -- another class's session without rewriting its records would be just as
  -- wrong and much harder to notice.
  SELECT array_agg(DISTINCT state::text) INTO v_states
  FROM public.attendance_records WHERE session_id = v_yours;
  IF v_states <> ARRAY['present'] THEN
    RAISE EXCEPTION
      '038: another class''s attendance was rewritten by our holiday (now %)',
      array_to_string(v_states, ', ');
  END IF;

  SELECT status INTO v_status FROM public.class_sessions WHERE id = v_yours;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION '038: another class''s session was closed by our holiday';
  END IF;

  -- And they can still create sessions on that date. The trigger that blocks
  -- creation reads the row's own class_id, so a declaration in one class must
  -- not stop another scheduling anything.
  PERFORM public.create_ad_hoc_session(t.cohort_theirs, t.shared_date, TIME '15:00');

  -- While we cannot.
  BEGIN
    PERFORM public.create_ad_hoc_session(t.cohort_mine, t.shared_date, TIME '15:00');
    RAISE EXCEPTION '038: our own class could still add a session on its holiday';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '038:%' THEN RAISE; END IF;
  END;

  RAISE NOTICE '038 ok: the holiday stopped at the class boundary, in both directions';
END;
$isolated$;

-- --------------------------------------- and a day off cannot borrow a cohort --
DO $integrity$
DECLARE
  t      record;
  failed boolean := false;
BEGIN
  SELECT * INTO t FROM t038;

  -- 036 shipped CHECK (cohort_id IS NULL OR true), which rejects nothing. The
  -- row it allowed was inert rather than dangerous — is_no_class_day matches on
  -- class_id first — but it would sit on one class's screen naming a cohort
  -- that does not resolve.
  BEGIN
    INSERT INTO public.no_class_days
      (class_id, cohort_id, on_date, mode, reason)
    VALUES (t.mine, t.cohort_theirs, t.shared_date + 1, 'exempt', 'Borrowed cohort');
  EXCEPTION WHEN OTHERS THEN
    failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      '038: a day off for one class was scoped to another class''s cohort';
  END IF;

  RAISE NOTICE '038 ok: a cohort from another class is refused';
END;
$integrity$;

ROLLBACK;
