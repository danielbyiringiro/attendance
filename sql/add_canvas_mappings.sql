-- ============================================================================
-- Feature: remembered Canvas row mappings
--
-- When a TA pairs a Canvas gradebook row with a student by hand, or marks a row
-- as not-a-student, that decision is stored here so the next export does not
-- ask again. These are institution-level facts, not one person's preference, so
-- they live in the database rather than in one browser.
--
-- Run this AFTER sql/secure_database.sql.
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run. Idempotent.
--
-- The app degrades gracefully if this table is missing: matching still works,
-- it just forgets between exports.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.canvas_row_mappings (
  -- Stable identity of the Canvas row, built by the app in this order of
  -- preference: "cid:<Canvas internal ID>", "sis:<SIS User ID>", or
  -- "name:<canonical name>". Row position is NOT used — a fresh export from
  -- Canvas can reorder rows freely.
  canvas_key VARCHAR PRIMARY KEY,

  -- The student this row means. NULL when the row is not a person at all.
  student_id VARCHAR REFERENCES public.students(student_id) ON DELETE CASCADE,

  -- TRUE when the TA said this row is not a student (boilerplate, a dropped
  -- enrolment, a test account). Mutually exclusive with student_id in practice.
  ignored BOOLEAN NOT NULL DEFAULT FALSE,

  -- Kept only so the table is readable by a human debugging a bad mapping.
  canvas_name VARCHAR,

  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canvas_row_mappings_student
  ON public.canvas_row_mappings(student_id);

-- TA-only. Students never touch this.
ALTER TABLE public.canvas_row_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canvas_row_mappings_auth_all ON public.canvas_row_mappings;
CREATE POLICY canvas_row_mappings_auth_all ON public.canvas_row_mappings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
