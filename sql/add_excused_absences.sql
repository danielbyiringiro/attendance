-- ============================================================================
-- Feature: Excused absences ("absent with permission")
--
-- Run this AFTER sql/secure_database.sql.
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Idempotent.
-- ============================================================================

-- One row per student per excused class day. The app expands a TA-entered date
-- range into individual class-day rows.
CREATE TABLE IF NOT EXISTS public.excused_absences (
  id SERIAL PRIMARY KEY,
  student_id VARCHAR NOT NULL REFERENCES public.students(student_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  reason VARCHAR,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_excused_absences_date ON public.excused_absences(date);
CREATE INDEX IF NOT EXISTS idx_excused_absences_student_id ON public.excused_absences(student_id);

-- TA-managed; students only see their own via get_student_attendance below.
ALTER TABLE public.excused_absences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS excused_absences_auth_all ON public.excused_absences;
CREATE POLICY excused_absences_auth_all ON public.excused_absences
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Extend the student history RPC to also return that student's excused dates.
CREATE OR REPLACE FUNCTION public.get_student_attendance(p_student_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'present', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('timestamp', ps.timestamp, 'cohort', ps.cohort)
               ORDER BY ps.timestamp DESC)
      FROM public.present_students ps
      WHERE ps.student_id = p_student_id), '[]'::jsonb),
    'cancelled', COALESCE((
      SELECT jsonb_agg(DISTINCT cs.date)
      FROM public.cancelled_sessions cs
      WHERE cs.is_cancelled), '[]'::jsonb),
    'excused', COALESCE((
      SELECT jsonb_agg(DISTINCT ea.date)
      FROM public.excused_absences ea
      WHERE ea.student_id = p_student_id), '[]'::jsonb),
    'flagged', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('session_date', f.session_date, 'status', f.status))
      FROM public.flagged f
      WHERE f.student_id = p_student_id), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_student_attendance(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_student_attendance(text) TO anon, authenticated;
