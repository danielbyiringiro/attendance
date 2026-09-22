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

/**
 * The first and last session this class has, whatever their status.
 *
 * Two small queries rather than reading the whole term: the fill dialog needs
 * only these two dates, and a class with a term of sessions should not have to
 * ship all of them to work out where its record starts.
 */
export const sessionDateRange = async (
  classId: string,
): Promise<{ first: string | null; last: string | null }> => {
  const [firstRes, lastRes] = await Promise.all([
    supabase
      .from("class_sessions")
      .select("session_date")
      .eq("class_id", classId)
      .order("session_date", { ascending: true })
      .limit(1),
    supabase
      .from("class_sessions")
      .select("session_date")
      .eq("class_id", classId)
      .order("session_date", { ascending: false })
      .limit(1),
  ]);
  if (firstRes.error) fail("Could not read the session dates", firstRes.error);
  if (lastRes.error) fail("Could not read the session dates", lastRes.error);
  return {
    first: firstRes.data?.[0]?.session_date ?? null,
    last: lastRes.data?.[0]?.session_date ?? null,
  };
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

/**
 * What colour a day off is drawn in (052). A name rather than a hex: the app
 * renders in light and dark, so each of these resolves to two values, and a
 * colour picked at noon still reads at night. Six, because an arbitrary picker
 * produces days off nobody can see against a white cell.
 */
export type NoClassHue =
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "blue"
  | "slate";

/** In the order they are offered. amber is what every day off was before 052. */
export const NO_CLASS_HUES: readonly NoClassHue[] = [
  "amber",
  "rose",
  "violet",
  "teal",
  "blue",
  "slate",
];

/** One declared date, as the calendar and the list both read it. */
export interface NoClassDay {
  id: string;
  on_date: string;
  mode: NoClassMode;
  /** Never empty — 036 made it NOT NULL, so the calendar can always show it. */
  reason: string;
  hue: NoClassHue;
  /** Null means the whole class, which is what a public holiday is. */
  cohort_id: string | null;
}

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
  hue?: NoClassHue,
): Promise<{
  date: string;
  mode: NoClassMode;
  reason: string;
  hue: NoClassHue;
  /**
   * False when this declared the day, true when it corrected one already
   * declared. A words-only correction returns zeroes below: since 052 the
   * attendance rewrite runs only when the mode changed.
   */
  edited: boolean;
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
    p_hue: hue ?? null,
  });
  if (error) fail("Could not set the day", error);
  return data as {
    date: string;
    mode: NoClassMode;
    reason: string;
    hue: NoClassHue;
    edited: boolean;
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
): Promise<NoClassDay[]> => {
  const { data, error } = await supabase
    .from("no_class_days")
    .select("id, on_date, mode, reason, hue, cohort_id")
    .eq("class_id", classId)
    .order("on_date", { ascending: true });
  if (error) fail("Could not load the days off", error);
  return (data ?? []) as NoClassDay[];
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
    /**
     * 048: check-in shuts when this session starts, rather than after the
     * sign-up window. One session only — the weekly pattern is untouched.
     */
    closesAtStart?: boolean;
    /** How long check-in lasts when this is opened after its start. 1–30. */
    graceMinutes?: number;
    /** Whether a mark inside that grace window is recorded late. */
    graceCountsLate?: boolean;
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
    p_closes_at_start: changes.closesAtStart ?? null,
    p_grace_minutes: changes.graceMinutes ?? null,
    p_grace_counts_late: changes.graceCountsLate ?? null,
  });
  if (error) fail("Could not change the session", error);
  return data as SessionRow;
};

/**
 * How far an edit reaches — the question a calendar app asks about a
 * repeating event.
 */
export type EditScope =
  /** This session alone. The only scope that can move a date. */
  | "one"
  /** This session and every later one in its run. */
  | "future"
  /** Every session in its run, earlier ones included. */
  | "series";

export interface SeriesEditResult {
  scope: EditScope;
  updated: number;
  /** Left alone because somebody had been marked on them. */
  skipped_marked: number;
  /** Left alone because they are open, closed or cancelled. */
  skipped_status: number;
}

/**
 * Edit one session, or the run it belongs to (053).
 *
 * A run is the same cohort meeting on the same weekday at the same time —
 * "every Tuesday at nine". The bulk scopes skip anything somebody has been
 * marked on and anything no longer scheduled, and say how many; a date can
 * only change with scope "one", because moving a run to another weekday is
 * the weekly pattern's job and doing it here would be undone by the next fill.
 *
 * Every session it changes stops following the weekly pattern, which is what
 * keeps the edit from being undone by the next pattern save.
 */
export const updateSessionSeries = async (
  sessionId: string,
  scope: EditScope,
  changes: {
    date?: string;
    startTime?: string;
    durationMinutes?: number;
    autoCloseMinutes?: number;
    lateWindowMinutes?: number;
    closesAtStart?: boolean;
    graceMinutes?: number;
    graceCountsLate?: boolean;
  },
): Promise<SeriesEditResult> => {
  const { data, error } = await supabase.rpc("update_session_series", {
    p_session_id: sessionId,
    p_scope: scope,
    p_date: changes.date ?? null,
    p_start_time: changes.startTime ?? null,
    p_duration_minutes: changes.durationMinutes ?? null,
    p_auto_close_minutes: changes.autoCloseMinutes ?? null,
    p_late_window_minutes: changes.lateWindowMinutes ?? null,
    p_closes_at_start: changes.closesAtStart ?? null,
    p_grace_minutes: changes.graceMinutes ?? null,
    p_grace_counts_late: changes.graceCountsLate ?? null,
  });
  if (error) fail("Could not change the sessions", error);
  return data as SeriesEditResult;
};

/** What a drop on the calendar would do, or did (054). */
export interface MovePlan {
  scope: "one" | "future";
  dry_run: boolean;
  /** True when the weekly pattern was split at the new date. */
  split: boolean;
  moved: number;
  /** Removed, because the new date is a day off or past the end of term. */
  dropped: { day_off: number; past_term: number };
  /** Left where they were, and why. */
  kept: { marked: number; by_hand: number; running: number; clash: number };
}

/**
 * Move a session to another date — alone, or with every later one in its run.
 *
 * "future" splits the weekly pattern at the new date, so the next fill does not
 * bring the old day back. With `dryRun` the move is done, counted and rolled
 * back, which is how the calendar shows what a drop will do before it happens.
 * Refusals (a day off, the same weekday, a session with no pattern behind it)
 * arrive as errors whose message says what to do instead.
 */
export const moveSessionTo = async (
  sessionId: string,
  newDate: string,
  scope: "one" | "future",
  dryRun = false,
): Promise<MovePlan> => {
  const { data, error } = await supabase.rpc("move_session_to", {
    p_session_id: sessionId,
    p_new_date: newDate,
    p_scope: scope,
    p_dry_run: dryRun,
  });
  if (error) fail("Could not move the session", error);
  return data as MovePlan;
};

/** How many sessions each scope would reach, asked before anything changes. */
export const countSessionSeries = async (
  sessionId: string,
): Promise<{ future: number; series: number }> => {
  const { data, error } = await supabase.rpc("count_session_series", {
    p_session_id: sessionId,
  });
  if (error) fail("Could not count the sessions in that run", error);
  return data as { future: number; series: number };
};

/** Which stretch of the term a fill covers. */
export type FillScope =
  /** From the start of term to the earliest session on record. */
  | "gap"
  /** The start of term through today. */
  | "past"
  /** Today to the end of term. */
  | "future"
  /** The whole thing. */
  | "term";

export interface FillPlan {
  from: string;
  to: string;
  /** True when nothing was written — this is a preview. */
  dry_run: boolean;
  /** False when the range ends behind today, where nothing is ever removed. */
  pruned: boolean;
  created: number;
  removed: number;
  /**
   * Standing although the pattern no longer names their date, and why. The
   * number a TA needs when 11 moved and they expected 14.
   */
  kept: {
    marked: number;
    by_hand: number;
    cancelled: number;
  };
}

/**
 * Create the sessions the weekly pattern wants across a range, and ahead of
 * today remove the ones it no longer wants.
 *
 * With `dryRun` it does exactly that work, counts it, and rolls it back — so
 * the plan a screen shows is produced by the code that will run, not by a
 * second implementation that can drift from it. That is the whole reason this
 * exists rather than a counting query: a preview that can be wrong about the
 * action is worse than no preview, because it is believed.
 *
 * Pruning never reaches behind today, and never touches a session that is
 * cancelled, moved by hand, or has anybody marked against it.
 */
export const fillSessions = async (
  classId: string,
  opts: {
    from?: string;
    to?: string;
    /** Default true. False creates only, and removes nothing. */
    prune?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<FillPlan> => {
  const { data, error } = await supabase.rpc("fill_sessions", {
    p_class_id: classId,
    p_from: opts.from ?? null,
    p_to: opts.to ?? null,
    p_prune: opts.prune ?? true,
    p_dry_run: opts.dryRun ?? false,
  });
  if (error) fail("Could not work out what to fill in", error);
  return data as FillPlan;
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
