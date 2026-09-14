/**
 * The rules behind the attendance calendar.
 *
 * One student's sessions shown as a month, each day coloured by what was
 * recorded. Used by the student record dialog on the TA side and the student's
 * own history page, which share AttendanceCalendar so they read the same.
 *
 * Pure, so `npm run test:attendance` can pin which colour a day gets.
 */

import { fromDateStr } from "@/lib/dates";
import type { AttendanceState } from "@/lib/api/types";

export type DayTone =
  | "present"
  | "late"
  | "absent"
  | "excused"
  | "exempted"
  | "pending"
  | "cancelled";

/** Legend order: attendance first, then the ones that do not count. */
export const DAY_TONES: DayTone[] = [
  "present",
  "late",
  "absent",
  "excused",
  "exempted",
  "pending",
  "cancelled",
];

/** Said in words on every day, so the calendar never relies on colour alone. */
export const TONE_LABEL: Record<DayTone, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  excused: "Excused",
  exempted: "Exempt",
  pending: "Not closed",
  cancelled: "No class",
};

export interface CalendarEntry {
  /** YYYY-MM-DD, the session's date in its class's timezone. */
  date: string;
  tone: DayTone;
  /** Shown instead of the tone's word, e.g. a class name when several show. */
  label?: string;
}

/** The colour a recorded state gets. A cancelled class is "no class" whatever is stored. */
export const toneOf = (
  state: AttendanceState | null | undefined,
  cancelled = false,
): DayTone => {
  if (cancelled) return "cancelled";
  switch (state) {
    case "present":
      return "present";
    case "late":
      return "late";
    case "unexcused":
      return "absent";
    case "excused":
      return "excused";
    case "exempted":
      return "exempted";
    default:
      return "pending";
  }
};

/*
 * Which tone a day with several sessions shows: the one most worth noticing.
 * An absence in one class and a check-in in another reads as the absence, and
 * a real mark always beats "not closed yet" or a cancelled class.
 */
const SEVERITY: DayTone[] = [
  "absent",
  "late",
  "excused",
  "present",
  "exempted",
  "pending",
  "cancelled",
];

export const dayTone = (tones: readonly DayTone[]): DayTone | null => {
  let shown: DayTone | null = null;
  for (const tone of tones) {
    if (shown === null || SEVERITY.indexOf(tone) < SEVERITY.indexOf(shown)) {
      shown = tone;
    }
  }
  return shown;
};

export const entriesByDate = <T extends { date: string }>(
  entries: readonly T[],
): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  entries.forEach((e) => {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  });
  return map;
};

/**
 * The month to open on: the latest one with a session.
 *
 * Not today's month. Between terms, or for a student looking back at a class
 * that has finished, today's month is an empty grid and looks like nothing was
 * ever recorded.
 */
export const latestMonth = (
  dates: readonly string[],
  fallback: Date = new Date(),
): { year: number; month: number } => {
  const latest = dates.reduce<string | null>(
    (max, d) => (max === null || d > max ? d : max),
    null,
  );
  const at = latest ? fromDateStr(latest) : fallback;
  return { year: at.getFullYear(), month: at.getMonth() };
};
