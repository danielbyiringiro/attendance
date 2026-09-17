-- ============================================================================
-- 052 — a day off says what it is, in a colour that was chosen
--
-- 036 made a day off carry a reason, and made it NOT NULL, because "somebody
-- reading a student's record a term later needs to know why a day stopped
-- counting". The calendar then prints "No class" and hides that reason in a
-- tooltip nobody hovers, so a term of holidays, reading weeks and field trips
-- all render as the same grey words. The reason has been in the table since
-- 036; this is about letting it out.
--
-- Two changes.
--
-- A COLOUR, STORED AS A NAME
--
-- `hue` is one of six names, not a hex string. Three reasons, in order of how
-- much they would hurt.
--
-- One: a free colour is a colour that can be invisible. #FFFFFE on a white
-- cell is a day off that silently is not there, and the person who picked it
-- is the last to find out.
--
-- Two: the app renders in light and dark. A hex chosen at noon is a hex the
-- dark theme is then stuck with; a name resolves to a different value in each
-- theme, so a day off picked in daylight still reads at night.
--
-- Three: a CHECK on six names is a constraint the database can enforce. A
-- CHECK on arbitrary hex is a regex that passes `#000000` and everything else
-- a careless caller sends.
--
-- Defaulting to 'amber' keeps every row 036 and 037 wrote looking exactly as
-- it does today.
--
-- DECLARING A DAY OFF TWICE NOW EDITS IT
--
-- The insert was ON CONFLICT DO NOTHING, so re-declaring a date kept the first
-- reason and silently discarded the new one. Fixing a typo meant clearing the
-- day and setting it again — which, under 'exempt', deletes and regenerates
-- sessions to change a word. It is now an UPDATE that falls back to an INSERT,
-- so the reason, the mode and the colour can all be corrected in place.
--
-- Correcting the words or the colour stops at the table. The loop that
-- rewrites attendance only runs when the day is newly declared or its MODE
-- changed, because that is the only edit that changes what the day means for a
-- percentage. Fixing a typo must not give every student on the roster a fresh
-- marked_at, and a reason that cannot be corrected cheaply is a reason nobody
-- corrects.
--
-- One honest limit, unchanged by this: switching an existing day from 'exempt'
-- to 'present' cannot bring back sessions that 037 deleted because nothing had
-- happened at them. Those come back from generate_sessions, the same as they
-- always have.
--
-- Run AFTER 051. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The column
-- ----------------------------------------------------------------------------
ALTER TABLE public.no_class_days
  ADD COLUMN IF NOT EXISTS hue text NOT NULL DEFAULT 'amber';

-- ADD CONSTRAINT has no IF NOT EXISTS, and this migration is run twice by the
-- harness, so it is asked for by name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.no_class_days'::regclass
      AND conname = 'no_class_days_hue_known'
  ) THEN
    ALTER TABLE public.no_class_days
      ADD CONSTRAINT no_class_days_hue_known
      CHECK (hue IN ('amber', 'rose', 'violet', 'teal', 'blue', 'slate'));
  END IF;
END $$;

COMMENT ON COLUMN public.no_class_days.hue IS
  'One of six names the app maps to a light and a dark value. A name rather '
  'than a hex so a chosen colour cannot be invisible, and survives the theme.';

-- ----------------------------------------------------------------------------
-- Declaring, and now correcting, a day off
--
-- The old five-argument version is dropped rather than left beside this one:
-- with p_hue defaulted, a five-argument call would match both and Postgres
-- would refuse it as ambiguous.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_no_class_day(uuid, date, text, text, uuid);

CREATE OR REPLACE FUNCTION public.set_no_class_day(
  p_class_id  uuid,
  p_date      date,
  p_mode      text,
  p_reason    text,
  p_cohort_id uuid DEFAULT NULL,
  p_hue       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  s          public.class_sessions%ROWTYPE;
  v_state    public.attendance_state;
  v_hue      text;
  v_was      text;
  v_sessions integer := 0;
  v_removed  integer := 0;
  v_students integer := 0;
  v_written  integer;
BEGIN
  IF NOT public.can_manage_class(p_class_id) THEN
    RAISE EXCEPTION 'you do not have access to that class';
  END IF;

  IF p_mode NOT IN ('exempt', 'present') THEN
    RAISE EXCEPTION
      'mode must be exempt (the day does not count) or present (it counts and everybody gets it), not %',
      p_mode;
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required — a day that stops counting has to say why';
  END IF;

  -- Named, and named wrong is worth saying out loud: a caller that sends '#f00'
  -- should be told, not quietly given amber and left believing it worked.
  v_hue := COALESCE(NULLIF(btrim(lower(p_hue)), ''), 'amber');
  IF v_hue NOT IN ('amber', 'rose', 'violet', 'teal', 'blue', 'slate') THEN
    RAISE EXCEPTION
      'hue must be one of amber, rose, violet, teal, blue, slate — not %', p_hue;
  END IF;

  v_state := CASE p_mode
    WHEN 'exempt' THEN 'exempted'::public.attendance_state
    ELSE 'present'::public.attendance_state
  END;

  -- What was declared here before, if anything. Held because the mode is what
  -- decides whether any attendance has to be rewritten below.
  SELECT d.mode INTO v_was
    FROM public.no_class_days d
   WHERE d.class_id = p_class_id
     AND d.on_date = p_date
     AND d.cohort_id IS NOT DISTINCT FROM p_cohort_id
   FOR UPDATE;

  -- Correct the declaration if it is already there, otherwise make it. Written
  -- this way rather than as ON CONFLICT because the uniqueness is carried by
  -- two partial indexes (036), one per scope, and inferring the right one from
  -- a nullable cohort_id is harder to read than saying it plainly.
  UPDATE public.no_class_days d
     SET mode   = p_mode,
         reason = btrim(p_reason),
         hue    = v_hue
   WHERE d.class_id = p_class_id
     AND d.on_date = p_date
     AND d.cohort_id IS NOT DISTINCT FROM p_cohort_id;

  IF NOT FOUND THEN
    INSERT INTO public.no_class_days (
      class_id, cohort_id, on_date, mode, reason, hue, set_by
    )
    VALUES (p_class_id, p_cohort_id, p_date, p_mode, btrim(p_reason), v_hue,
            public.current_staff_id());
  END IF;

  -- The day already meant this, and still does. Only the words and the colour
  -- moved, so nothing below has anything to do.
  IF v_was IS NOT NULL AND v_was = p_mode THEN
    RETURN jsonb_build_object(
      'date',     p_date,
      'mode',     p_mode,
      'reason',   btrim(p_reason),
      'hue',      v_hue,
      'edited',   true,
      'sessions', 0,
      'removed',  0,
      'students', 0
    );
  END IF;

  FOR s IN
    SELECT * FROM public.class_sessions c
    WHERE c.class_id = p_class_id
      AND c.session_date = p_date
      AND (p_cohort_id IS NULL OR c.cohort_id = p_cohort_id)
      AND c.status <> 'cancelled'
    FOR UPDATE
  LOOP
    -- Nothing has happened here: a placeholder the pattern produced. Remove it,
    -- so the date looks exactly as it would if the holiday had been declared
    -- before the term was generated.
    --
    -- Only for 'exempt'. Under 'present' the session is what carries the credit
    -- for everybody, so deleting it would leave the day meaning nothing.
    IF p_mode = 'exempt'
       AND s.status = 'scheduled'
       AND NOT EXISTS (
         SELECT 1 FROM public.attendance_records a WHERE a.session_id = s.id
       )
    THEN
      DELETE FROM public.class_sessions WHERE id = s.id;
      v_removed := v_removed + 1;
      CONTINUE;
    END IF;

    -- Something has. Keep the session and record that the day did not count.
    DELETE FROM public.attendance_records WHERE session_id = s.id;

    INSERT INTO public.attendance_records (
      session_id, class_id, student_id, state, marked_at, marked_by_role
    )
    SELECT s.id, s.class_id, e.student_id, v_state, now(), 'staff'
    FROM public.enrolments e
    WHERE e.cohort_id = s.cohort_id
      AND e.enrolled_on <= s.session_date
      AND (e.dropped_on IS NULL OR e.dropped_on >= s.session_date);

    GET DIAGNOSTICS v_written = ROW_COUNT;
    v_students := v_students + v_written;

    UPDATE public.class_sessions
       SET status = 'closed'
     WHERE id = s.id;

    v_sessions := v_sessions + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'date',     p_date,
    'mode',     p_mode,
    'reason',   btrim(p_reason),
    'hue',      v_hue,
    -- False when this declared the day, true when it changed what it means.
    'edited',   v_was IS NOT NULL,
    -- Kept and marked, because something had happened at them.
    'sessions', v_sessions,
    -- Deleted, because nothing had. Reported separately: these do not come back
    -- when the day is cleared, they come back from generate_sessions.
    'removed',  v_removed,
    'students', v_students
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_no_class_day(uuid, date, text, text, uuid, text) IS
  'Declare a date off, or correct one already declared. Sessions with nothing '
  'recorded against them are deleted; ones that were opened or marked are '
  'closed with everybody exempted (or present). Remembered, so regenerating '
  'does not bring the day back.';
