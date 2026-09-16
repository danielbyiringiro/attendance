// Check-in timing for a cohort, or the whole class, set in one call.

import { supabase } from "@/lib/supabase";

export interface SessionWindowsResult {
  /** Weekly slots updated, so future generation matches. */
  slots: number;
  /** Upcoming scheduled sessions updated. */
  sessions: number;
  /**
   * Upcoming sessions left alone because attendance is already recorded against
   * them. Returned so the screen can explain a smaller number than expected.
   */
  kept: number;
  /** True for a whole-class change, which also sets the class defaults. */
  defaults_updated: boolean;
}

/**
 * Set how long sign-up stays open and how early check-in may open.
 *
 * `cohortId` undefined means every cohort, and also updates the class defaults
 * that new cohorts and hand-added sessions inherit. Either value may be left
 * undefined to keep it as it is.
 *
 * Sessions that are open, closed, dated before today, or already have marks are
 * never changed — see migration 040.
 */
export const setSessionWindows = async (
  classId: string,
  opts: {
    cohortId?: string;
    autoCloseMinutes?: number;
    earlyOpenMinutes?: number;
    /** 048: check-in shuts when the class starts. */
    closesAtStart?: boolean;
    /** 048: how long it lasts when opened after the start. 1–30. */
    graceMinutes?: number;
    /** 048: whether a mark inside that grace window is recorded late. */
    graceCountsLate?: boolean;
  },
): Promise<SessionWindowsResult> => {
  const { data, error } = await supabase.rpc("set_session_windows", {
    p_class_id: classId,
    p_cohort_id: opts.cohortId ?? null,
    p_auto_close_minutes: opts.autoCloseMinutes ?? null,
    p_early_open_minutes: opts.earlyOpenMinutes ?? null,
    p_closes_at_start: opts.closesAtStart ?? null,
    p_grace_minutes: opts.graceMinutes ?? null,
    p_grace_counts_late: opts.graceCountsLate ?? null,
  });
  if (error) throw new Error(`Could not update the timing: ${error.message}`);
  return data as SessionWindowsResult;
};
