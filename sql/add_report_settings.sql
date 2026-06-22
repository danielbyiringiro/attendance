-- ============================================================================
-- Feature: Per-cohort Instructor / FI for the weekly absence report
--
-- Run AFTER sql/secure_database.sql.
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run. Idempotent.
--
-- NOTE: this drops any earlier (single-row) report_settings table. That table
-- only held the instructor/FI names you typed, so just re-enter them in the app
-- after running this.
-- ============================================================================

DROP TABLE IF EXISTS public.report_settings;

-- One row per cohort: each cohort has its own lecturer (instructor) and FI.
CREATE TABLE public.report_settings (
  cohort VARCHAR PRIMARY KEY,
  instructor_name VARCHAR DEFAULT '',
  fi_name VARCHAR DEFAULT '',
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO public.report_settings (cohort)
VALUES ('A'), ('B'), ('C')
ON CONFLICT (cohort) DO NOTHING;

-- TA-only: read and written from the authenticated dashboard.
ALTER TABLE public.report_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_settings_auth_all ON public.report_settings;
CREATE POLICY report_settings_auth_all ON public.report_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
