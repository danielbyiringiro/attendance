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
import type { NoClassHue } from "@/lib/api/sessions";
import type { AttendanceState } from "@/lib/api/types";

export type DayTone =
  | "present"
  | "late"
  | "absent"
  | "excused"
  | "exempted"
  | "dayoff"
  | "pending"
  | "cancelled";

/** Legend order: attendance first, then the ones that do not count. */
export const DAY_TONES: DayTone[] = [
  "present",
  "late",
  "absent",
  "excused",
  "exempted",
  "dayoff",
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
  dayoff: "Day off",
  pending: "Not closed",
  cancelled: "No class",
};

export interface CalendarEntry {
  /** YYYY-MM-DD, the session's date in its class's timezone. */
  date: string;
  tone: DayTone;
  /** Shown instead of the tone's word, e.g. a class name when several show. */
  label?: string;
  /**
   * Only on a `dayoff`: the colour staff gave that day (052). Carried so the
   * student's month and the staff month draw the same date the same way —
   * they are looking at one day, and a calendar that disagrees with itself
   * teaches people not to trust either half.
   */
  hue?: NoClassHue;
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
 * Which tone a day with several entries shows: the one most worth noticing.
 * An absence in one class and a check-in in another reads as the absence, and
 * a real mark always beats "not closed yet" or a cancelled class. A day off
 * outranks a bare exemption, because it is the reason for it.
 */
const SEVERITY: DayTone[] = [
  "absent",
  "late",
  "excused",
  "present",
  "dayoff",
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

// ---------------------------------------------------------------------------
// A student's own history: records and the days their classes did not meet
// ---------------------------------------------------------------------------

/** One session of the student's, as far as the calendar needs it. */
export interface HistoryRecord {
  date: string;
  className: string;
  tone: DayTone;
}

/** A day off from get_student_attendance (migration 045, colour added in 052). */
export interface HistoryDayOff {
  date: string;
  className: string;
  /** "exempt": the day does not count. "present": it counts, and everybody got it. */
  mode: "exempt" | "present";
  reason: string;
  /** Missing on a record written before 052 was run; amber is what those were. */
  hue?: NoClassHue;
}

const dayKey = (date: string, className: string) => `${date}|${className}`;

/**
 * Calendar entries for a student's records and their classes' days off.
 *
 * A day off is shown by name, with its reason. On a day that did not count, the
 * "Exempt" (or unclosed, or cancelled) session it produced is dropped: the day
 * off explains it, and "Exempt" beside "Public holiday" says the same thing
 * twice. On a day that counted, the "Present" stays — it is real credit — and
 * the reason is added beside it.
 *
 * With several classes on screen, each label names its class.
 */
export const historyEntries = (
  records: readonly HistoryRecord[],
  daysOff: readonly HistoryDayOff[],
  nameClasses: boolean,
): CalendarEntry[] => {
  // A class-wide and a cohort day off can share a date; one is enough.
  const off = new Map<string, HistoryDayOff>();
  daysOff.forEach((d) => {
    const key = dayKey(d.date, d.className);
    if (!off.has(key)) off.set(key, d);
  });

  const entries: CalendarEntry[] = [];

  records.forEach((r) => {
    const d = off.get(dayKey(r.date, r.className));
    const explained =
      d?.mode === "exempt" &&
      (r.tone === "exempted" || r.tone === "pending" || r.tone === "cancelled");
    if (explained) return;
    entries.push({
      date: r.date,
      tone: r.tone,
      label: nameClasses ? r.className : undefined,
    });
  });

  off.forEach((d) => {
    const reason = d.mode === "present" ? `${d.reason} (counted)` : d.reason;
    entries.push({
      date: d.date,
      tone: "dayoff",
      label: nameClasses ? `${d.className}: ${reason}` : reason,
      hue: d.hue ?? "amber",
    });
  });

  return entries;
};

// ---------------------------------------------------------------------------
// One calendar for one student, whoever is looking
// ---------------------------------------------------------------------------

/** A session of the student's cohort and what they have on it. */
export interface StudentSession {
  date: string;
  className: string;
  /** scheduled | open | closed | cancelled */
  status: string;
  /** The student's state on it, or null when nothing is recorded. */
  state: AttendanceState | null;
}

/**
 * The tone a session shows on a student's calendar, or null to leave it off.
 *
 * Cancelled is "no class" whatever is stored. A mark shows as itself. No mark
 * is "not closed" only while the session is open; once it has closed without
 * one, close_session would have written an absence for anybody enrolled, so an
 * empty closed session is one from before the student joined, and not theirs.
 */
export const sessionTone = (s: StudentSession): DayTone | null => {
  if (s.status === "cancelled") return "cancelled";
  if (s.state === null) return s.status === "open" ? "pending" : null;
  return toneOf(s.state);
};

/**
 * A student's calendar entries: their sessions and the days off that applied.
 *
 * The one rule behind both calendars of a student — the record a TA opens and
 * the student's own history — so the two show the same days in the same way.
 * Each screen feeds it the same facts from its own source.
 */
export const studentCalendar = (
  sessions: readonly StudentSession[],
  daysOff: readonly HistoryDayOff[],
  nameClasses: boolean,
): CalendarEntry[] =>
  historyEntries(
    sessions.flatMap((s) => {
      const tone = sessionTone(s);
      return tone ? [{ date: s.date, className: s.className, tone }] : [];
    }),
    daysOff,
    nameClasses,
  );
