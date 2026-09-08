// Sessions: generating them from a schedule, and running one.
//
// A session is a row that exists before anyone checks in. Nothing here infers
// that a class happened from the fact that somebody marked.

import { supabase } from "@/lib/supabase";
import type { OpenSessionResult, SessionRow } from "@/lib/api/types";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

export interface SessionQuery {
  classId: string;
  cohortId?: string;
  /** Inclusive, YYYY-MM-DD. Defaults to the whole term. */
  from?: string;
  to?: string;
}

export const listSessions = async (q: SessionQuery): Promise<SessionRow[]> => {
  let query = supabase
    .from("class_sessions")
    .select("*")
    .eq("class_id", q.classId)
    .order("session_date", { ascending: false })
    .order("starts_at", { ascending: true });

  if (q.cohortId) query = query.eq("cohort_id", q.cohortId);
  if (q.from) query = query.gte("session_date", q.from);
  if (q.to) query = query.lte("session_date", q.to);

  const { data, error } = await query;
  if (error) fail("Could not load sessions", error);
  return (data ?? []) as SessionRow[];
};

/** The sessions a TA acts on today, across every cohort of the class. */
export const listTodaySessions = async (
  classId: string,
): Promise<SessionRow[]> => {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
  return listSessions({ classId, from: iso, to: iso });
};

/**
 * Expand the cohort schedules into session rows. Re-runnable: it returns how
 * many it created and skips anything that already exists, so adding a weekday
 * and regenerating adds only the new days.
 */
export const generateSessions = async (
  classId: string,
  opts: { cohortId?: string; from?: string; to?: string } = {},
): Promise<number> => {
  const { data, error } = await supabase.rpc("generate_sessions", {
    p_class_id: classId,
    p_cohort_id: opts.cohortId ?? null,
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
  });
  if (error) fail("Could not generate sessions", error);
  return (data as number) ?? 0;
};

/**
 * Open a session for check-in. Omit the PIN to have one generated from an
 * alphabet with no O/0/I/1 — these get read aloud to a room.
 *
 * Several sessions can be open at once, across classes. The PIN is what tells
 * them apart, which is why it is unique among open sessions.
 */
export const openSession = async (
  sessionId: string,
  opts: { pin?: string; minutes?: number } = {},
): Promise<OpenSessionResult> => {
  const { data, error } = await supabase.rpc("open_session", {
    p_session_id: sessionId,
    p_pin: opts.pin ?? null,
    p_minutes: opts.minutes ?? null,
  });
  if (error) fail("Could not open the session", error);
  return data as OpenSessionResult;
};

/**
 * Close a session, writing an explicit absence for everyone enrolled who did
 * not mark. Returns how many absences it recorded.
 *
 * This is the moment absence becomes a stored fact rather than something the
 * browser recomputes.
 */
export const closeSession = async (sessionId: string): Promise<number> => {
  const { data, error } = await supabase.rpc("close_session", {
    p_session_id: sessionId,
  });
  if (error) fail("Could not close the session", error);
  return (data as number) ?? 0;
};

/**
 * Cancel a session. Removes absences so a class that never ran cannot drag a
 * percentage down, and keeps the records of anyone who marked before it was
 * called off. Returns how many absences were removed.
 */
export const cancelSession = async (
  sessionId: string,
  reason?: string,
): Promise<number> => {
  const { data, error } = await supabase.rpc("cancel_session", {
    p_session_id: sessionId,
    p_reason: reason ?? null,
  });
  if (error) fail("Could not cancel the session", error);
  return (data as number) ?? 0;
};

/**
 * Change one session's date, time, length or notes.
 *
 * Only a session that has not run yet can be moved: the server refuses a
 * closed, open or cancelled one. Moving a closed session would carry the
 * attendance already recorded against it onto a different day.
 *
 * The wall-clock date and time are sent, not an instant. The server resolves it
 * in the class's timezone, the same way generate_sessions does — a browser that
 * computed the instant itself would reintroduce exactly the disagreement the
 * session model was built to remove.
 */
export const updateSession = async (
  sessionId: string,
  changes: {
    /** YYYY-MM-DD. */
    date?: string;
    /** "HH:MM". */
    startTime?: string;
    /** How long the class runs. */
    durationMinutes?: number;
    /** How long check-in stays open once opened — the sign-up window. */
    autoCloseMinutes?: number;
    /** Marks after this many minutes are `late` rather than `present`. */
    lateWindowMinutes?: number;
    notes?: string;
  },
): Promise<SessionRow> => {
  const { data, error } = await supabase.rpc("update_session", {
    p_session_id: sessionId,
    p_date: changes.date ?? null,
    p_start_time: changes.startTime ?? null,
    p_duration_minutes: changes.durationMinutes ?? null,
    p_notes: changes.notes ?? null,
    p_auto_close_minutes: changes.autoCloseMinutes ?? null,
    p_late_window_minutes: changes.lateWindowMinutes ?? null,
  });
  if (error) fail("Could not change the session", error);
  return data as SessionRow;
};

export interface ApplyScheduleResult {
  from: string;
  /** Sessions whose weekday still runs, moved to the new time. */
  moved: number;
  /** Sessions on a weekday the cohort no longer meets. */
  removed: number;
  created: number;
}

/**
 * Bring future sessions into line with the current schedule.
 *
 * generate_sessions alone cannot do this: it is ON CONFLICT DO NOTHING, so
 * moving a cohort from Tuesday 09:00 to Tuesday 14:00 left every 09:00 session
 * standing and added a second one at 14:00 — two sessions a day, and everyone's
 * denominator doubled.
 *
 * Never touches a day that has already happened, a session someone cancelled,
 * or one edited by hand. `from` defaults to today on the server, so a missing
 * argument cannot reach into the past.
 */
export const applyScheduleToFuture = async (
  classId: string,
  opts: { cohortIds?: string[]; from?: string } = {},
): Promise<ApplyScheduleResult> => {
  const { data, error } = await supabase.rpc("apply_schedule_to_future", {
    p_class_id: classId,
    p_cohort_ids: opts.cohortIds ?? null,
    p_from: opts.from ?? null,
  });
  if (error) fail("Could not update the future sessions", error);
  return data as ApplyScheduleResult;
};

export interface OpenSessionSummary {
  open_count: number;
  /** When the first of them stops accepting check-ins. */
  closes_at: string | null;
}

/**
 * How many sessions are accepting check-ins, and when the first closes.
 *
 * Safe for a logged-out visitor: a count and a time, no PIN, no class name, no
 * cohort. The pre-login countdown used to read the `session_state` singleton
 * directly as anon, which meant granting anon SELECT on the table that held
 * the PIN — and which could only ever describe one session for the whole
 * installation.
 */
export const getOpenSessionSummary = async (): Promise<OpenSessionSummary> => {
  const { data, error } = await supabase.rpc("get_open_session_summary");
  if (error) fail("Could not check for open sessions", error);
  return (data ?? { open_count: 0, closes_at: null }) as OpenSessionSummary;
};
