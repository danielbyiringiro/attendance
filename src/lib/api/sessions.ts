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

export const listOpenSessions = async (
  classId: string,
): Promise<SessionRow[]> => {
  const { data, error } = await supabase
    .from("class_sessions")
    .select("*")
    .eq("class_id", classId)
    .eq("status", "open");
  if (error) fail("Could not load open sessions", error);
  return (data ?? []) as SessionRow[];
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

/** Create a session that the schedule did not produce — a one-off or make-up. */
export const createAdHocSession = async (
  cohortId: string,
  startsAt: Date,
  opts: { durationMinutes?: number; notes?: string } = {},
): Promise<SessionRow> => {
  const { data, error } = await supabase
    .from("class_sessions")
    .insert({
      cohort_id: cohortId,
      starts_at: startsAt.toISOString(),
      // Overwritten by the trigger, which resolves it in the class's timezone.
      session_date: "1970-01-01",
      duration_minutes: opts.durationMinutes ?? 60,
      notes: opts.notes ?? null,
    })
    .select()
    .single();
  if (error) fail("Could not create the session", error);
  return data as SessionRow;
};
