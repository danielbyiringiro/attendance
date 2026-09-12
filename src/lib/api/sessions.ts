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
/**
 * Open anything whose early-open moment has arrived, close anything past its
 * window, and report how many of each.
 *
 * The schedule already says when a class meets and how long the check-in window
 * runs; until migration 031 nothing acted on it, so a session stayed 'scheduled'
 * until a TA pressed Open and stayed 'open' forever afterwards. Closing matters
 * most: close writes the explicit unexcused row for everyone who did not mark,
 * so a session nobody closed is one where the absences were never recorded.
 *
 * pg_cron runs the same sweep every minute in production. This call exists so
 * the dashboard is immediate rather than up to a minute stale, and so the
 * feature still works on a project where the extension is not enabled. Calling
 * both is harmless — the sweep is idempotent and the second caller finds
 * nothing left to do.
 *
 * Failures are swallowed on purpose. This runs on a timer behind a screen the
 * TA is already using; a transient error here should not put a red toast over
 * the roster they are reading.
 */
export const syncSessions = async (): Promise<{
  opened: number;
  closed: number;
  /**
   * False when the database has no sync_sessions — i.e. migration 031 has not
   * been applied to this project.
   *
   * Worth returning rather than swallowing. Without the sweep nothing opens or
   * closes by itself, and a screen that says "opening itself now" while no such
   * thing is happening is worse than one that admits it: the TA waits for
   * something that is never going to arrive. PostgREST answers a missing
   * function with PGRST202, so this is a specific check and not a catch-all
   * that would also hide a network blip as a missing migration.
   */
  available: boolean;
}> => {
  const { data, error } = await supabase.rpc("sync_sessions");
  if (error) {
    const missing =
      error.code === "PGRST202" || /sync_sessions/.test(error.message ?? "");
    if (!missing) {
      console.warn("Could not sync session states:", error.message);
    }
    return { opened: 0, closed: 0, available: !missing };
  }
  const result = (data ?? {}) as { opened?: number; closed?: number };
  return {
    opened: result.opened ?? 0,
    closed: result.closed ?? 0,
    available: true,
  };
};

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
/** How far a hand-added session should repeat. */
export type AddScope =
  /** That date only. */
  | "day"
  /** Weekly on that weekday, up to a date you choose. */
  | "range"
  /** Weekly on that weekday, to the end of term. */
  | "term";

export interface AddSessionsResult {
  /** The first one created, or null if everything was skipped. */
  session_id: string | null;
  cohort: string;
  from: string;
  to: string;
  weekday: string;
  /** Dates considered. */
  candidates: number;
  created: number;
  /** Skipped because the date is declared off. */
  skipped_days_off: number;
  /** Skipped because this cohort already meets at that time. */
  skipped_existing: number;
  outside_term: boolean;
}

/**
 * Sessions on one date, or weekly on that weekday through to an end date.
 *
 * Until migration 035 there was no way to record a session outside the weekly
 * pattern at all; 039 added the end date, because wanting the same slot every
 * Tuesday for the rest of term otherwise meant opening the dialog eleven times.
 *
 * Weekly on the weekday of `from`, never daily. A TA picking Tuesday and "to
 * the end of term" means Tuesdays, and a daily reading would quietly create
 * sixty sessions.
 *
 * INSTANCES, NOT A RULE. Everything it creates is flagged `moved_manually` with
 * no schedule_id, which is the line between the two screens: the Schedule
 * editor owns the weekly rule and every future session follows it, while the
 * calendar owns instances that a later pattern change will not touch. Somebody
 * who wants a managed weekly slot should add it to the pattern instead.
 *
 * Two things reduce the count and both are correct: a declared day off, and a
 * date where the cohort already meets at that time. They come back counted
 * separately, because "created 9 of 11" without a reason reads as a bug.
 */
export const createAdHocSessions = async (
  cohortId: string,
  from: string,
  startTime: string,
  opts: { to?: string; durationMinutes?: number } = {},
): Promise<AddSessionsResult> => {
  const { data, error } = await supabase.rpc("create_ad_hoc_sessions", {
    p_cohort_id: cohortId,
    p_from: from,
    p_start_time: startTime,
    p_to: opts.to ?? null,
    p_duration_minutes: opts.durationMinutes ?? null,
  });
  if (error) fail("Could not add the sessions", error);
  return data as AddSessionsResult;
};

/**
 * The end date a scope implies, or undefined for a single day.
 *
 * Shared so both screens agree. "term" is capped at the class's own end date
 * rather than a guess, and a range with no date chosen falls back to the single
 * day rather than silently running to the end of term — the safer of the two
 * wrong answers, since one extra session is easier to undo than eleven.
 */
export const untilFor = (
  scope: AddScope,
  from: string,
  until: string,
  termEndsOn: string,
): string | undefined => {
  if (scope === "day") return undefined;
  if (scope === "term") return termEndsOn;
  return until.trim() ? until : undefined;
};

/**
 * One sentence describing what an add actually did.
 *
 * Shared because both screens offer this and both need to explain the same
 * three-way outcome: some created, some skipped because the day is off, some
 * skipped because the cohort already meets then. Two copies of this wording is
 * two chances to describe the same result differently.
 */
export const describeAdd = (r: AddSessionsResult): string => {
  const bits: string[] = [];

  if (r.created > 0) {
    bits.push(
      r.candidates === 1
        ? `Cohort ${r.cohort}.`
        : `${r.created} session${r.created === 1 ? "" : "s"} for cohort ${r.cohort}, weekly on ${r.weekday.trim()}s.`,
    );
  }
  if (r.skipped_days_off > 0) {
    bits.push(
      `${r.skipped_days_off} skipped as ${r.skipped_days_off === 1 ? "a day" : "days"} off.`,
    );
  }
  if (r.skipped_existing > 0) {
    bits.push(
      `${r.skipped_existing} skipped — already a session at that time.`,
    );
  }
  if (r.outside_term) {
    bits.push("Some fall outside the term, so they will not appear in term-wide figures.");
  }
  if (r.created > 0) {
    bits.push("A schedule change will not move or remove them.");
  }

  return bits.join(" ");
};

/** What a no-class day does to the percentage. Two actions, not a toggle. */
export type NoClassMode =
  /** The day leaves the calculation. Everyone exempted. A holiday. */
  | "exempt"
  /** The day counts and everybody is credited. An online quiz, a take-home. */
  | "present";

/**
 * Declare a date the class does not meet.
 *
 * Not cancel_session in a loop, for three reasons. It is a date rather than a
 * session, so it covers every cohort including ones added later. It is
 * remembered, so regenerating sessions does not bring the holiday back — which
 * is the part a loop cannot do at all. And `present` has no equivalent in
 * cancellation.
 *
 * Existing sessions on that date are closed and their records replaced. A
 * check-in on a declared holiday is not evidence the class ran.
 *
 * Pass a cohortId to narrow it; leave it out and it applies class-wide, which
 * is what a public holiday is.
 */
export const setNoClassDay = async (
  classId: string,
  date: string,
  mode: NoClassMode,
  reason: string,
  cohortId?: string,
): Promise<{
  date: string;
  mode: NoClassMode;
  /** Kept and marked, because something had already happened at them. */
  sessions: number;
  /**
   * Deleted, because nothing had. Only ever under `exempt`: under `present` the
   * session is what carries the credit, so removing it would leave the day
   * meaning nothing.
   *
   * These do not come back when the day is cleared. They come back from
   * generate_sessions, which is re-runnable once the date is released.
   */
  removed: number;
  students: number;
}> => {
  const { data, error } = await supabase.rpc("set_no_class_day", {
    p_class_id: classId,
    p_date: date,
    p_mode: mode,
    p_reason: reason,
    p_cohort_id: cohortId ?? null,
  });
  if (error) fail("Could not set the day", error);
  return data as {
    date: string;
    mode: NoClassMode;
    sessions: number;
    removed: number;
    students: number;
  };
};

/**
 * Undo one.
 *
 * Puts the sessions back to scheduled and removes the exempted rows this wrote.
 * It cannot restore check-ins that were overwritten — the same trade
 * cancellation makes.
 */
export const clearNoClassDay = async (
  classId: string,
  date: string,
  cohortId?: string,
): Promise<{ date: string; removed: number; sessions: number }> => {
  const { data, error } = await supabase.rpc("clear_no_class_day", {
    p_class_id: classId,
    p_date: date,
    p_cohort_id: cohortId ?? null,
  });
  if (error) fail("Could not clear the day", error);
  return data as { date: string; removed: number; sessions: number };
};

/** Every date this class has declared off, soonest first. */
export const listNoClassDays = async (
  classId: string,
): Promise<
  Array<{
    id: string;
    on_date: string;
    mode: NoClassMode;
    reason: string;
    cohort_id: string | null;
  }>
> => {
  const { data, error } = await supabase
    .from("no_class_days")
    .select("id, on_date, mode, reason, cohort_id")
    .eq("class_id", classId)
    .order("on_date", { ascending: true });
  if (error) fail("Could not load the days off", error);
  return (data ?? []) as Array<{
    id: string;
    on_date: string;
    mode: NoClassMode;
    reason: string;
    cohort_id: string | null;
  }>;
};

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
