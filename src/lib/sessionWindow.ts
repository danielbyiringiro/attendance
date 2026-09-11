/**
 * When is check-in actually live?
 *
 * This is the same rule as `session_opens_at` / `session_closes_at` /
 * `session_is_live` in migration 028, restated in TypeScript:
 *
 *   opens  at  max(opened_at, starts_at - early_open_minutes)
 *   closes at  max(opened_at, starts_at) + auto_close_minutes
 *
 * Two implementations of one rule is normally how they drift, so this one is
 * pinned: `npm run test:attendance` runs it against the worked examples written
 * into 028's own header. If the database rule changes, those assertions are
 * where it is caught.
 *
 * It lives client-side because the dashboard needs to re-render as the clock
 * moves — a countdown that only updates when you refetch is not a countdown.
 * The server stays the authority on whether a mark is accepted; this decides
 * only what the TA is shown.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * `status` and liveness are not the same thing and had quietly diverged.
 * `status` changed only when somebody pressed a button, so a session whose
 * window had long since passed still read 'open' on the dashboard, and one that
 * had not been opened yet said nothing about when it would be.
 *
 * Migration 031 closed the other half of this: a sweep now opens sessions at
 * their early-open moment and closes them past their window. This module is
 * what the dashboard renders from in between sweeps, so the countdown is smooth
 * rather than jumping once a minute.
 */

/** Only the fields the rule needs, so anything session-shaped can be passed. */
export interface SessionWindowInput {
  starts_at: string;
  opened_at: string | null;
  closed_at?: string | null;
  early_open_minutes: number;
  auto_close_minutes: number;
  late_window_minutes: number;
  status: string;
}

const minutes = (n: number) => n * 60_000;

const later = (a: number, b: number) => (a > b ? a : b);

export type WindowPhase =
  /**
   * Not open yet. Since 031 the sweep opens it once the early-open moment
   * arrives, so this is "waiting", not "waiting for you".
   */
  | "not_opened"
  /** Opened, but the early-open allowance has not been reached yet. */
  | "opens_soon"
  /** Accepting marks, and inside the on-time window. */
  | "live"
  /** Accepting marks, but anyone checking in now is recorded late. */
  | "live_late"
  /** The window has passed. Marks are refused even though status says open. */
  | "expired"
  /** Closed, cancelled, or otherwise not a live session. */
  | "done";

/**
 * A discriminated union rather than four nullable dates.
 *
 * The window only exists once a session has been opened, and the phases split
 * cleanly on that: 'not_opened' and 'done' have no times, every other phase has
 * all three. Written as one interface with `Date | null` fields, every caller
 * has to either re-check or write `w.closesAt!` — and a non-null assertion is
 * exactly the thing strictNullChecks was turned on to stop. This way the
 * narrowing a caller already does on `phase` hands them the dates for free.
 */
interface WindowCommon {
  /** Milliseconds until the next phase change, or null when nothing is pending. */
  msUntilChange: number | null;
  /**
   * True when the row still says 'open' but the window has passed. This is the
   * state worth showing loudly: the dashboard used to present it as running.
   */
  staleOpen: boolean;
}

interface NoTimes {
  opensAt: null;
  closesAt: null;
  lateFrom: null;
  msUntilClose: null;
  msUntilLate: null;
}

/**
 * Scheduled, not open.
 *
 * Carries the span during which the sweep will open it, which is narrower than
 * it looks and is the thing that makes "why did this not open?" answerable.
 * Migration 031 opens a session only while
 *
 *   starts_at - early_open_minutes  <=  now  <=  starts_at + auto_close_minutes
 *
 * and only while its status is still 'scheduled'. The upper bound is not
 * arbitrary: past it the check-in window would already have shut, so opening
 * would mint a live PIN for a class that is over. But it does mean the chance
 * is missable, and nothing said so.
 */
interface NotOpened extends WindowCommon, NoTimes {
  phase: "not_opened";
  /** Earliest the sweep will open it. */
  autoOpenFrom: Date;
  /** After this the sweep leaves it alone for good. */
  autoOpenUntil: Date;
  /** That span has passed and nothing opened it. Only a person can now. */
  autoOpenMissed: boolean;
}

interface Finished extends WindowCommon, NoTimes {
  phase: "done";
  autoOpenFrom: null;
  autoOpenUntil: null;
  autoOpenMissed: false;
}

interface OpenWindow extends WindowCommon {
  phase: "opens_soon" | "live" | "live_late" | "expired";
  opensAt: Date;
  closesAt: Date;
  /** When an on-time mark becomes a late one. */
  lateFrom: Date;
  /**
   * Milliseconds until check-in stops accepting marks. Always a number on this
   * branch, which is the reason it lives here rather than on the shared part.
   *
   * Separate from msUntilChange on purpose. Mid-session the next *change* is
   * the late threshold, which is worth knowing and is not what a TA is
   * watching — the deadline is when the window shuts. A badge showing only the
   * next change counted down to 'late', then started again from a larger
   * number, which reads as the clock running backwards.
   */
  msUntilClose: number;
  /** Milliseconds until an on-time mark becomes late. Null once past it. */
  msUntilLate: number | null;
  autoOpenFrom: null;
  autoOpenUntil: null;
  autoOpenMissed: false;
}

export type SessionWindow = NotOpened | Finished | OpenWindow;

export const sessionWindow = (
  s: SessionWindowInput,
  now: Date = new Date(),
): SessionWindow => {
  const t = now.getTime();
  const starts = new Date(s.starts_at).getTime();

  if (s.status === "cancelled" || s.status === "closed") {
    return {
      phase: "done",
      opensAt: null,
      closesAt: null,
      lateFrom: null,
      msUntilChange: null,
      msUntilClose: null,
      msUntilLate: null,
      autoOpenFrom: null,
      autoOpenUntil: null,
      autoOpenMissed: false,
      staleOpen: false,
    };
  }

  // Scheduled but not opened. early_open_minutes is a permission to open early,
  // not an instruction to open by itself, so there is no window yet — only a
  // time from which pressing Open costs nothing.
  if (!s.opened_at) {
    const earliest = starts - minutes(s.early_open_minutes);
    const latest = starts + minutes(s.auto_close_minutes);
    return {
      phase: "not_opened",
      opensAt: null,
      closesAt: null,
      lateFrom: null,
      msUntilChange: earliest > t ? earliest - t : null,
      msUntilClose: null,
      msUntilLate: null,
      autoOpenFrom: new Date(earliest),
      autoOpenUntil: new Date(latest),
      autoOpenMissed: t > latest,
      staleOpen: false,
    };
  }

  const opened = new Date(s.opened_at).getTime();
  const opensAt = later(opened, starts - minutes(s.early_open_minutes));
  const anchor = later(opened, starts);
  const closesAt = anchor + minutes(s.auto_close_minutes);
  const lateFrom = anchor + minutes(s.late_window_minutes);

  const shape = {
    opensAt: new Date(opensAt),
    closesAt: new Date(closesAt),
    lateFrom: new Date(lateFrom),
    autoOpenFrom: null as null,
    autoOpenUntil: null as null,
    autoOpenMissed: false as const,
    msUntilClose: closesAt > t ? closesAt - t : 0,
    msUntilLate: lateFrom > t ? lateFrom - t : null,
  };

  if (t < opensAt) {
    return { ...shape, phase: "opens_soon", msUntilChange: opensAt - t, staleOpen: false };
  }
  if (t > closesAt) {
    return {
      ...shape,
      phase: "expired",
      msUntilChange: null,
      msUntilClose: 0,
      msUntilLate: null,
      staleOpen: true,
    };
  }
  if (t >= lateFrom) {
    return { ...shape, phase: "live_late", msUntilChange: closesAt - t, staleOpen: false };
  }
  return { ...shape, phase: "live", msUntilChange: lateFrom - t, staleOpen: false };
};

/** "4m 20s", "1h 05m", or "now". For a countdown that has to fit in a badge. */
export const countdown = (ms: number): string => {
  if (ms <= 0) return "now";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
};
