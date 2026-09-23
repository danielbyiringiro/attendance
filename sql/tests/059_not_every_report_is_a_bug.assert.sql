-- ============================================================================
-- Migration 059 — a report says which kind of report it is
--
-- What is checked:
--
--   an idea is stored as an idea, and a fault as a fault
--   a call that does not mention the kind still works, and lands on 'bug'
--     (this is the old client, and it is the check that matters most: the
--      migration drops the two-argument function, so if the default did not
--      cover it every unreloaded tab would start failing)
--   a row written without a kind at all takes the column default
--   a kind nobody defined is refused rather than stored
--   an admin reads the kind back
--   an admin can ask for one kind, and gets only that kind
--   asking for a kind that does not exist raises, rather than quietly
--     returning everything — a filter that stops filtering is how somebody
--     concludes there are no open bugs
--   open before handled, and within open, faults before wishes
--   an anonymous report stores NO staff_id — the promise the form makes is
--     checked against the row, not against what one screen chooses to show
--   its sender cannot read it back either (the cost of not storing it), while
--     a signed report from the same person still is readable — the second half
--     matters, or the first is just RLS hiding everything
--   the admin sees it as anonymous, with no name attached, and still sees the
--     name on a signed one
--
-- Every check runs as a session that can actually see the row: feedback is
-- RLS-scoped, and a check asked from the wrong session passes or fails for
-- reasons that have nothing to do with this migration.
--
-- Wrapped in a transaction that is rolled back.
-- ============================================================================

BEGIN;

INSERT INTO public.staff (user_id, email, display_name, status, is_admin) VALUES
  ('59000000-0000-0000-0000-000000000059', 'admin@assert-059.test',
   'Admin Person', 'approved', true),
  ('59000000-0000-0000-0000-000000000060', 'ta@assert-059.test',
   'Reporting TA', 'approved', false)
ON CONFLICT (user_id) DO NOTHING;

-- ON CONFLICT DO NOTHING is silent by design, so a row that did not land shows
-- up much later as a guard that appears to work and does not.
DO $seeded$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.staff WHERE email LIKE '%@assert-059.test';
  IF n <> 2 THEN
    RAISE EXCEPTION '059: seeded % of 2 accounts', n;
  END IF;

  PERFORM set_config('t059.ta',
    (SELECT id::text FROM public.staff WHERE email = 'ta@assert-059.test'), true);
END;
$seeded$;

-- ------------------------------------ a row with no kind is a bug by default --
-- Written as the superuser and outside send_feedback on purpose: this is the
-- column default, which is what every row written before 059 relies on.
DO $default_column$
DECLARE v_kind text;
BEGIN
  INSERT INTO public.feedback (staff_id, body)
  VALUES (current_setting('t059.ta')::uuid, 'Written before 059 existed.')
  RETURNING kind INTO v_kind;

  IF v_kind <> 'bug' THEN
    RAISE EXCEPTION '059: a row written without a kind came back as %', v_kind;
  END IF;

  RAISE NOTICE '059 ok: rows from before the migration read as bugs';
END;
$default_column$;

-- ---------------------------------------------------- staff send both kinds --
SET ROLE authenticated;
SET request.jwt.claim.sub = '59000000-0000-0000-0000-000000000060';

DO $sends$
DECLARE
  v_row public.feedback%ROWTYPE;
BEGIN
  v_row := public.send_feedback('The roster loses my cohort filter.', 'roster', 'bug');
  IF v_row.kind <> 'bug' THEN
    RAISE EXCEPTION '059: a fault was stored as %', v_row.kind;
  END IF;

  v_row := public.send_feedback('It would help if export remembered the last range.',
                                'help', 'idea');
  IF v_row.kind <> 'idea' THEN
    RAISE EXCEPTION '059: an idea was stored as %', v_row.kind;
  END IF;

  RAISE NOTICE '059 ok: an idea is stored as an idea and a fault as a fault';
END;
$sends$;

-- ------------------------------------------- the client that was not reloaded --
DO $old_client$
DECLARE v_row public.feedback%ROWTYPE;
BEGIN
  -- Exactly what a tab opened before this deploy sends: body and page, by name,
  -- and no kind at all.
  v_row := public.send_feedback(p_body := 'Sent from a tab nobody reloaded.',
                                p_page := 'help');

  IF v_row.kind <> 'bug' THEN
    RAISE EXCEPTION '059: an old client''s report landed on %', v_row.kind;
  END IF;

  RAISE NOTICE '059 ok: a call without the kind still works, and is a bug';
END;
$old_client$;

-- --------------------------------------------- a kind nobody defined is refused --
DO $unknown_kind$
DECLARE ok boolean;
BEGIN
  BEGIN
    PERFORM public.send_feedback('Categorised by somebody inventive.', 'help',
                                 'feature-request');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;

  IF NOT ok THEN
    RAISE EXCEPTION '059: an undefined kind was accepted';
  END IF;

  -- And the blank a form field gives when it was never filled in is not an
  -- error, it is a bug report.
  DECLARE v_row public.feedback%ROWTYPE;
  BEGIN
    v_row := public.send_feedback('An empty select.', 'help', '   ');
    IF v_row.kind <> 'bug' THEN
      RAISE EXCEPTION '059: a blank kind did not fall back to bug';
    END IF;
  END;

  RAISE NOTICE '059 ok: an undefined kind is refused, a blank one is a bug';
END;
$unknown_kind$;

-- Every row above was written inside one transaction, so they all carry the
-- same now() and "faults before wishes" would sort as a tie — passing whatever
-- the order clause said. Ageing the faults makes the idea the newest row, so
-- plain created_at DESC would put it first and only the kind term can put it
-- last. Superuser, because staff may not update feedback.
RESET ROLE;
UPDATE public.feedback
   SET created_at = now() - interval '1 hour'
 WHERE kind = 'bug' AND staff_id = current_setting('t059.ta')::uuid;

-- --------------------------------------------------- what the admin reads back --
SET ROLE authenticated;
SET request.jwt.claim.sub = '59000000-0000-0000-0000-000000000059';

DO $reads$
DECLARE
  v_all     jsonb;
  v_ideas   jsonb;
  v_bugs    jsonb;
  v_last_bug   integer;
  v_first_idea integer;
  n         integer;
  ok        boolean;
BEGIN
  v_all := public.admin_list_feedback();

  IF NOT (v_all @> jsonb_build_array(jsonb_build_object(
            'body', 'It would help if export remembered the last range.',
            'kind', 'idea'))) THEN
    RAISE EXCEPTION '059: the idea is not in the admin list as an idea: %', v_all;
  END IF;

  -- One kind only, and it really is only that kind. Counted over this test's
  -- own sender rather than the whole table, so a fixture that grows a feedback
  -- row later does not turn this into a failure about nothing.
  v_ideas := public.admin_list_feedback(NULL, 'idea');
  SELECT count(*) INTO n FROM jsonb_array_elements(v_ideas) e
   WHERE e ->> 'from_email' = 'ta@assert-059.test';
  IF n <> 1 THEN
    RAISE EXCEPTION '059: asked for ideas and got % of ours: %', n, v_ideas;
  END IF;
  SELECT count(*) INTO n FROM jsonb_array_elements(v_ideas) e
   WHERE e ->> 'kind' <> 'idea';
  IF n <> 0 THEN
    RAISE EXCEPTION '059: the idea filter also returned % other rows', n;
  END IF;

  v_bugs := public.admin_list_feedback(NULL, 'bug');
  SELECT count(*) INTO n FROM jsonb_array_elements(v_bugs) e
   WHERE e ->> 'from_email' = 'ta@assert-059.test';
  IF n <> 4 THEN
    RAISE EXCEPTION '059: asked for bugs and got % of ours: %', n, v_bugs;
  END IF;
  SELECT count(*) INTO n FROM jsonb_array_elements(v_bugs) e
   WHERE e ->> 'kind' <> 'bug';
  IF n <> 0 THEN
    RAISE EXCEPTION '059: the bug filter also returned % other rows', n;
  END IF;

  -- Faults before wishes, among the rows this test wrote: all of ours are open,
  -- so every bug of ours must come before every idea of ours.
  SELECT max(o) INTO v_last_bug
    FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(e, o)
   WHERE e ->> 'from_email' = 'ta@assert-059.test' AND e ->> 'kind' = 'bug';
  SELECT min(o) INTO v_first_idea
    FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(e, o)
   WHERE e ->> 'from_email' = 'ta@assert-059.test' AND e ->> 'kind' = 'idea';

  IF v_last_bug IS NULL OR v_first_idea IS NULL THEN
    RAISE EXCEPTION '059: the unfiltered list is missing our rows: %', v_all;
  END IF;
  IF v_last_bug > v_first_idea THEN
    RAISE EXCEPTION '059: an idea sorted above an open fault (% vs %)',
      v_first_idea, v_last_bug;
  END IF;

  -- A filter that silently stops filtering is worse than no filter.
  BEGIN
    PERFORM public.admin_list_feedback(NULL, 'wish');
    ok := false;
  EXCEPTION WHEN others THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION '059: a kind that does not exist was accepted as a filter';
  END IF;

  RAISE NOTICE '059 ok: the admin reads the kind, filters by it, and faults sort first';
END;
$reads$;

-- ----------------------------------------------------- sent without a name --
SET ROLE authenticated;
SET request.jwt.claim.sub = '59000000-0000-0000-0000-000000000060';

DO $anon$
DECLARE
  v_row public.feedback%ROWTYPE;
  n     integer;
BEGIN
  v_row := public.send_feedback('The dashboard should remember my cohort.',
                                'help', 'idea', true);

  -- The row itself, not what a screen shows: this is the whole promise.
  IF v_row.staff_id IS NOT NULL THEN
    RAISE EXCEPTION '059: an anonymous report stored a staff_id';
  END IF;
  IF NOT v_row.anonymous THEN
    RAISE EXCEPTION '059: an anonymous report is not marked anonymous';
  END IF;

  -- Not readable by its own sender, because there is nothing to match on.
  SELECT count(*) INTO n FROM public.feedback
   WHERE body = 'The dashboard should remember my cohort.';
  IF n <> 0 THEN
    RAISE EXCEPTION '059: the sender can still read their anonymous report';
  END IF;

  -- And the check above means something: a report they DID sign is readable
  -- from this very session. Without this, a policy that hid everything would
  -- pass the same test.
  SELECT count(*) INTO n FROM public.feedback
   WHERE body = 'The roster loses my cohort filter.';
  IF n <> 1 THEN
    RAISE EXCEPTION '059: the sender cannot read their own signed report either';
  END IF;

  RAISE NOTICE '059 ok: anonymous stores no name, and signed reports still read back';
END;
$anon$;

SET request.jwt.claim.sub = '59000000-0000-0000-0000-000000000059';

DO $anon_admin$
DECLARE
  v_all jsonb;
  n     integer;
BEGIN
  v_all := public.admin_list_feedback();

  SELECT count(*) INTO n FROM jsonb_array_elements(v_all) e
   WHERE e ->> 'body' = 'The dashboard should remember my cohort.'
     AND (e ->> 'anonymous')::boolean
     AND e ->> 'from_name' IS NULL
     AND e ->> 'from_email' IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION '059: the anonymous report does not read as anonymous: %', v_all;
  END IF;

  -- The other half: a signed report still arrives with somebody to ask.
  SELECT count(*) INTO n FROM jsonb_array_elements(v_all) e
   WHERE e ->> 'body' = 'The roster loses my cohort filter.'
     AND NOT (e ->> 'anonymous')::boolean
     AND e ->> 'from_name' = 'Reporting TA';
  IF n <> 1 THEN
    RAISE EXCEPTION '059: a signed report lost its name';
  END IF;

  RAISE NOTICE '059 ok: the admin sees anonymous as anonymous and signed as signed';
END;
$anon_admin$;

RESET ROLE;
ROLLBACK;
