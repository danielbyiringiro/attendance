// Attendance export — turns the raw check-in tables into a downloadable CSV
// covering any date range, one cohort or all of them, one student or everyone.
//
// The counting rules here mirror the weekly report in TADashboard: a class day
// is a Tue/Wed/Thu that is not cancelled, a student is "present" if they have a
// check-in row for it, "excused" if a TA granted permission, and "absent"
// otherwise. Excused days are never counted as absences.

import { supabase } from "@/lib/supabase";
import { toCsv } from "@/lib/csv";

// Attendance is only tracked from this date forward; anything earlier has no
// check-in rows at all and would read as everybody being absent.
export const SEMESTER_START = new Date(Date.UTC(2026, 4, 18));
export const SEMESTER_START_STR = SEMESTER_START.toISOString().slice(0, 10);

// Class meets Tuesday, Wednesday and Thursday.
const CLASS_WEEKDAYS = new Set([2, 3, 4]);

export type CohortFilter = "all" | string;
export type ExportShape = "summary" | "detail";
export type DayStatus = "Present" | "Excused" | "Absent";

/**
 * Target system for the file. "default" is this app's own layout; the others
 * shape the same numbers into whatever a downstream gradebook expects. New
 * targets are added to FORMATS below — nothing else needs to change.
 */
export type ExportFormat = "default" | "canvas" | "canvas-fill";

export interface ExportOptions {
  /** First day of the range, inclusive (clamped to the semester start). */
  start: Date;
  /** Last day of the range, inclusive (clamped to today). */
  end: Date;
  /** "all" for every cohort, or a single cohort code such as "A". */
  cohort: CohortFilter;
  /** A single student ID, or null/undefined for the whole roster. */
  studentId?: string | null;
  /** "summary" = one row per student, "detail" = one row per student per day. */
  shape: ExportShape;
  /** Which system the file is destined for. Defaults to this app's layout. */
  format?: ExportFormat;
  /**
   * Count excused days as present rather than setting them aside. Changes the
   * denominator too: merged, the rate is over every class day; unmerged, it is
   * over the days the student was actually expected to attend.
   */
  mergeExcusedIntoPresent?: boolean;
}

export interface SummaryRow {
  student_id: string;
  name: string;
  cohort: string;
  classDays: number;
  /** Includes the excused days when mergeExcusedIntoPresent is set. */
  present: number;
  absent: number;
  /** Always the raw excused count — informational once merged into present. */
  excused: number;
  /**
   * Merged: present / class days. Unmerged: present / (class days - excused),
   * so an excused day neither helps nor hurts.
   */
  attendanceRate: number;
}

export interface DetailRow {
  student_id: string;
  name: string;
  cohort: string;
  date: string;
  status: DayStatus;
}

export interface ExportResult {
  csv: string;
  filename: string;
  /** Rows written, excluding the header. */
  rowCount: number;
  /** Range actually used after clamping, so the UI can say what it covered. */
  effectiveStart: string;
  effectiveEnd: string;
  /** Set when the requested range was narrowed, or when nothing matched. */
  notice?: string;
  /** Distinct dates counted as sessions across the cohorts in scope. */
  sessionDays: number;
  /** Tue/Wed/Thu in the range, before the session and cancellation filters. */
  candidateDays: number;
  summary: SummaryRow[];
  detail: DetailRow[];
}

// ---------------------------------------------------------------------------
// Dates
//
// Everything is compared as a "YYYY-MM-DD" string. Calendar pickers hand back a
// Date at local midnight, so the date string is read off the LOCAL components —
// toISOString() would shift the day for anyone west of UTC. Iteration then runs
// in UTC so a daylight-saving change cannot skip or repeat a day.
// ---------------------------------------------------------------------------

export const toDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

const eachDateStr = (startStr: string, endStr: string): string[] => {
  const out: string[] = [];
  const cursor = new Date(`${startStr}T00:00:00Z`);
  const last = new Date(`${endStr}T00:00:00Z`);
  while (cursor <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
};

const weekdayOf = (dateStr: string): number =>
  new Date(`${dateStr}T00:00:00Z`).getUTCDay();

// ---------------------------------------------------------------------------
// Fetching
//
// PostgREST caps a single response at 1000 rows. Every table read here is
// paginated — a silently truncated read would drop check-ins and report present
// students as absent, which is exactly the error an export must not make.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

// Supabase's builder changes type with every chained call, which makes a precise
// annotation impractical here. This structural type covers exactly the methods
// the reads below use, and keeps `any` out of the module.
interface PagedQuery {
  eq: (column: string, value: unknown) => PagedQuery;
  gte: (column: string, value: unknown) => PagedQuery;
  lte: (column: string, value: unknown) => PagedQuery;
  order: (column: string, options?: { ascending?: boolean }) => PagedQuery;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>;
}

const fetchAll = async <T>(
  table: string,
  columns: string,
  refine?: (q: PagedQuery) => PagedQuery,
): Promise<T[]> => {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const base = supabase.from(table).select(columns) as unknown as PagedQuery;
    const query = refine ? refine(base) : base;
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to read ${table}: ${error.message}`);
    }
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Formats
//
// Each entry turns the same tallied rows into one destination system's layout.
// Adding a target means adding an entry here and a case to ExportFormat — the
// fetching and counting above never change.
// ---------------------------------------------------------------------------

interface RenderContext {
  summary: SummaryRow[];
  detail: DetailRow[];
  shape: ExportShape;
  mergeExcused: boolean;
  /** "all-cohorts", "cohort-A", or a single student ID. */
  scopeLabel: string;
  startStr: string;
  endStr: string;
}

interface FormatDefinition {
  label: string;
  /** Shown under the picker so a TA knows what they are about to download. */
  description: string;
  /** Whether the summary/detail choice applies to this format. */
  usesShape: boolean;
  /**
   * Absent when the format fills a template the user supplies. The tally still
   * comes back on the result; the caller renders it against the upload.
   */
  render?: (ctx: RenderContext) => {
    csv: string;
    filename: string;
    rowCount: number;
  };
  /** The dialog must collect a Canvas gradebook export before exporting. */
  requiresCanvasExport?: boolean;
}

const renderDefault = (ctx: RenderContext) => {
  const { summary, detail, shape, mergeExcused, scopeLabel } = ctx;
  const filename = `attendance_${shape}_${scopeLabel}_${ctx.startStr}_to_${ctx.endStr}.csv`;

  if (shape === "detail") {
    return {
      filename,
      rowCount: detail.length,
      csv: toCsv(
        ["Student ID", "Name", "Cohort", "Date", "Status"],
        detail.map((r) => [r.student_id, r.name, r.cohort, r.date, r.status]),
      ),
    };
  }

  return {
    filename,
    rowCount: summary.length,
    csv: toCsv(
      [
        "Student ID",
        "Name",
        "Cohort",
        // Not "Class Days" — this counts sessions actually held, which is the
        // only thing an absence can be measured against.
        "Sessions Held",
        // Naming the merge in the header stops the file being ambiguous once it
        // is separated from the dialog that produced it.
        mergeExcused ? "Present (incl. Excused)" : "Present",
        "Absent",
        "Excused",
        "Attendance Rate (%)",
      ],
      summary.map((r) => [
        r.student_id,
        r.name,
        r.cohort,
        r.classDays,
        r.present,
        r.absent,
        r.excused,
        r.attendanceRate,
      ]),
    ),
  };
};

// Canvas rejects an assignment column whose name contains any of these, and
// does so silently, so the column title is checked before the file is built.
const CANVAS_RESERVED_FRAGMENTS = [
  "Current Score",
  "Current Points",
  "Current Grade",
  "Final Score",
  "Final Points",
  "Final Grade",
  "Override Score",
  "Override Grade",
  "Override Status",
];

/**
 * This app stores names given-name-first ("Robin Lee Carter"); Canvas wants
 * them surname-first ("Carter, Robin Lee").
 *
 * HEURISTIC, and a lossy one: it assumes the surname is the last whitespace-
 * separated token. That is wrong for a multi-word surname ("van der Berg"), and
 * wrong again where the final token is actually a middle name, which nothing in
 * the roster distinguishes. Prefer filling a real Canvas export, where the name
 * comes from Canvas itself and no guess is needed.
 *
 * A name that already contains a comma is assumed to be surname-first and is
 * left alone.
 */
export const toSurnameFirst = (name: string): string => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.includes(",")) return trimmed;
  const parts = trimmed.split(" ");
  if (parts.length < 2) return trimmed;
  const surname = parts[parts.length - 1];
  return `${surname}, ${parts.slice(0, -1).join(" ")}`;
};

const renderCanvas = (ctx: RenderContext) => {
  const { summary, scopeLabel, startStr, endStr } = ctx;

  // Canvas's documented import layout: Student Name, Student ID, SIS User ID,
  // SIS Login ID, Section, then one column per assignment. There is no
  // "Points Possible" row on import — Canvas asks for the points interactively
  // when it meets a column it does not recognise.
  //
  // Student ID is Canvas's own internal user id, which this app has never seen,
  // so it is left blank and Canvas matches on SIS User ID instead.
  const assignmentColumn = `Attendance ${startStr} to ${endStr}`;
  const clash = CANVAS_RESERVED_FRAGMENTS.find((f) =>
    assignmentColumn.includes(f),
  );
  if (clash) {
    throw new Error(
      `Canvas ignores assignment columns containing "${clash}". Rename the column before exporting.`,
    );
  }

  return {
    filename: `Grades-Attendance-${scopeLabel}-${startStr}-to-${endStr}.csv`,
    rowCount: summary.length,
    csv: toCsv(
      [
        "Student Name",
        "Student ID",
        "SIS User ID",
        "SIS Login ID",
        "Section",
        assignmentColumn,
      ],
      summary.map((r) => [
        r.name ? toSurnameFirst(r.name) : r.student_id,
        "",
        r.student_id,
        "",
        `Cohort ${r.cohort}`,
        // The score is days attended. The TA sets points possible to the class
        // day count, which the dialog shows them.
        r.present,
      ]),
    ),
  };
};

export const FORMATS: Record<ExportFormat, FormatDefinition> = {
  default: {
    label: "Standard (this app)",
    description:
      "Attendance counts and rate, laid out for Excel or Google Sheets.",
    usesShape: true,
    render: renderDefault,
  },
  "canvas-fill": {
    label: "Canvas — fill a gradebook export",
    description:
      "Upload the CSV you downloaded from your Canvas Grades page. Every column Canvas gave you is preserved and one attendance column is added, so names and IDs are Canvas's own.",
    usesShape: false,
    requiresCanvasExport: true,
  },
  canvas: {
    label: "Canvas — build from scratch",
    description:
      "For when you have no gradebook export to hand. Canvas's ID and Section columns are left blank and the name order is guessed, so prefer filling a real export.",
    usesShape: false,
    render: renderCanvas,
  },
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

interface RosterRow {
  student_id: string;
  cohort: string;
  name: string | null;
}

export const buildAttendanceExport = async (
  options: ExportOptions,
): Promise<ExportResult> => {
  const {
    cohort,
    studentId,
    shape,
    format = "default",
    mergeExcusedIntoPresent: mergeExcused = false,
  } = options;

  const requestedStart = toDateStr(options.start);
  const requestedEnd = toDateStr(options.end);
  const todayStr = toDateStr(new Date());

  // Clamp: nothing is tracked before the semester starts, and a class day that
  // has not happened yet is not an absence.
  const startStr =
    requestedStart < SEMESTER_START_STR ? SEMESTER_START_STR : requestedStart;
  const endStr = requestedEnd > todayStr ? todayStr : requestedEnd;

  const clampNotes: string[] = [];
  if (startStr !== requestedStart) {
    clampNotes.push(`start moved to ${startStr} (semester start)`);
  }
  if (endStr !== requestedEnd) {
    clampNotes.push(`end moved to ${endStr} (today)`);
  }

  const empty = (notice: string): ExportResult => ({
    csv: "",
    filename: "",
    rowCount: 0,
    effectiveStart: startStr,
    effectiveEnd: endStr,
    notice,
    sessionDays: 0,
    candidateDays: 0,
    summary: [],
    detail: [],
  });

  if (startStr > endStr) {
    return empty(
      "That range has no tracked class days — it falls entirely before the semester started or in the future.",
    );
  }

  // --- roster -------------------------------------------------------------
  const rosterRows = await fetchAll<RosterRow>(
    "students",
    "student_id, cohort, name",
    (q) => q.order("student_id", { ascending: true }),
  );

  const roster = rosterRows
    .map((r) => ({
      student_id: String(r.student_id),
      cohort: String(r.cohort || "").toUpperCase(),
      name: r.name || "",
    }))
    .filter((r) => (cohort === "all" ? true : r.cohort === cohort))
    .filter((r) => (studentId ? r.student_id === studentId : true));

  if (roster.length === 0) {
    return empty("No students matched that cohort/student selection.");
  }

  // --- check-ins ----------------------------------------------------------
  // The stored timestamp is already UTC; slicing the date off the string avoids
  // re-parsing it through the browser's local timezone.
  const presentRows = await fetchAll<{
    student_id: string;
    cohort: string;
    timestamp: string;
  }>("present_students", "student_id, cohort, timestamp", (q) =>
    q
      .gte("timestamp", `${startStr}T00:00:00`)
      .lte("timestamp", `${endStr}T23:59:59.999`)
      .order("timestamp", { ascending: true }),
  );
  // Presence is matched on student + date alone. A student who changed cohort
  // mid-term still has their old check-ins tagged with the old cohort, and those
  // days were still attended.
  const presentSet = new Set(
    presentRows.map(
      (r) => `${r.student_id}-${String(r.timestamp).slice(0, 10)}`,
    ),
  );

  // A cohort met on a date if anyone in it checked in — the same inference the
  // dashboard's absence history makes ("if someone was present, it was a class
  // day"). This is what stops an untaught Tuesday from being read as everyone
  // being absent.
  const sessionDaysByCohort = new Map<string, Set<string>>();
  const markSession = (rawCohort: string, date: string) => {
    const key = String(rawCohort || "").toUpperCase();
    if (!key) return;
    if (!sessionDaysByCohort.has(key)) sessionDaysByCohort.set(key, new Set());
    sessionDaysByCohort.get(key)!.add(date);
  };
  presentRows.forEach((r) =>
    markSession(r.cohort, String(r.timestamp).slice(0, 10)),
  );

  // Explicitly scheduled dates count too, so a session where nobody turned up
  // is still a session — provided the TA generated the class dates.
  const classDateRows = await fetchAll<{ date: string; cohort: string }>(
    "class_dates",
    "date, cohort",
    (q) => q.gte("date", startStr).lte("date", endStr),
  );
  classDateRows.forEach((r) =>
    markSession(r.cohort, String(r.date).slice(0, 10)),
  );

  // --- cancelled sessions -------------------------------------------------
  // Cancellations are recorded per cohort, so a date cancelled for A still
  // counts as a class day for B.
  const cancelledRows = await fetchAll<{ date: string; cohort: string }>(
    "cancelled_sessions",
    "date, cohort",
    (q) => q.eq("is_cancelled", true).gte("date", startStr).lte("date", endStr),
  );
  const cancelledByCohort = new Map<string, Set<string>>();
  cancelledRows.forEach((r) => {
    const key = String(r.cohort || "").toUpperCase();
    if (!cancelledByCohort.has(key)) cancelledByCohort.set(key, new Set());
    cancelledByCohort.get(key)!.add(String(r.date).slice(0, 10));
  });

  // --- excused ------------------------------------------------------------
  const excusedRows = await fetchAll<{ student_id: string; date: string }>(
    "excused_absences",
    "student_id, date",
    (q) => q.gte("date", startStr).lte("date", endStr),
  );
  const excusedSet = new Set(
    excusedRows.map((r) => `${r.student_id}-${String(r.date).slice(0, 10)}`),
  );

  // --- sessions per cohort -------------------------------------------------
  //
  // A student can only be absent from a session that actually happened. Every
  // Tue/Wed/Thu in the range is a *candidate*; it becomes a counted session for
  // a cohort only if there is evidence that cohort met — a check-in or a
  // scheduled class date — and it was not cancelled.
  //
  // Counting bare weekdays instead inflates absences by every reading week,
  // holiday and untaught day nobody thought to record as cancelled.
  const candidateDays = eachDateStr(startStr, endStr).filter((ds) =>
    CLASS_WEEKDAYS.has(weekdayOf(ds)),
  );

  if (candidateDays.length === 0) {
    return empty(
      `No class days (Tue/Wed/Thu) fall between ${startStr} and ${endStr}.`,
    );
  }

  const classDaysFor = new Map<string, string[]>();
  const daysForCohort = (c: string): string[] => {
    if (!classDaysFor.has(c)) {
      const held = sessionDaysByCohort.get(c);
      const cancelled = cancelledByCohort.get(c);
      classDaysFor.set(
        c,
        candidateDays.filter(
          (ds) => Boolean(held?.has(ds)) && !cancelled?.has(ds),
        ),
      );
    }
    return classDaysFor.get(c)!;
  };

  // --- tally --------------------------------------------------------------
  const summary: SummaryRow[] = [];
  const detail: DetailRow[] = [];

  roster.forEach((student) => {
    const days = daysForCohort(student.cohort);
    let attended = 0;
    let excused = 0;
    let absent = 0;

    days.forEach((ds) => {
      const key = `${student.student_id}-${ds}`;
      let status: DayStatus;
      if (presentSet.has(key)) {
        status = "Present";
        attended += 1;
      } else if (excusedSet.has(key)) {
        // Merged, an excused day reports as attendance everywhere — including
        // the per-day status, so the detail sheet agrees with the totals.
        status = mergeExcused ? "Present" : "Excused";
        excused += 1;
      } else {
        status = "Absent";
        absent += 1;
      }
      if (shape === "detail") {
        detail.push({
          student_id: student.student_id,
          name: student.name,
          cohort: student.cohort,
          date: ds,
          status,
        });
      }
    });

    // Merged: excused days count as attended, over every class day.
    // Unmerged: they leave the denominator, so they neither help nor hurt.
    const present = mergeExcused ? attended + excused : attended;
    const gradedDays = mergeExcused ? days.length : days.length - excused;

    summary.push({
      student_id: student.student_id,
      name: student.name,
      cohort: student.cohort,
      classDays: days.length,
      present,
      absent,
      excused,
      attendanceRate:
        gradedDays > 0 ? Math.round((present / gradedDays) * 1000) / 10 : 0,
    });
  });

  // Distinct dates that counted for at least one cohort in scope.
  const heldDays = new Set<string>();
  roster.forEach((s) =>
    daysForCohort(s.cohort).forEach((ds) => heldDays.add(ds)),
  );

  if (heldDays.size === 0) {
    return empty(
      `No sessions were recorded between ${startStr} and ${endStr} — no check-ins and no scheduled class dates in that window, so there is nothing to count anyone absent from.`,
    );
  }

  const notes: string[] = [];
  if (clampNotes.length) {
    notes.push(`Range adjusted: ${clampNotes.join("; ")}`);
  }
  if (heldDays.size < candidateDays.length) {
    notes.push(
      `Counted ${heldDays.size} of ${candidateDays.length} possible class days — the rest have no check-ins and no scheduled date on record`,
    );
  }

  // --- csv ----------------------------------------------------------------
  const scopeLabel = studentId
    ? studentId
    : cohort === "all"
      ? "all-cohorts"
      : `cohort-${cohort}`;

  const definition = FORMATS[format];
  const rendered = definition.render
    ? definition.render({
        summary,
        detail,
        shape,
        mergeExcused,
        scopeLabel,
        startStr,
        endStr,
      })
    : // A template-filling format renders from the caller's upload; the tally
      // below is still what it renders against.
      { csv: "", filename: "", rowCount: summary.length };

  return {
    csv: rendered.csv,
    filename: rendered.filename,
    rowCount: rendered.rowCount,
    effectiveStart: startStr,
    effectiveEnd: endStr,
    notice: notes.length ? `${notes.join(". ")}.` : undefined,
    sessionDays: heldDays.size,
    candidateDays: candidateDays.length,
    summary,
    detail,
  };
};

/** Hands the CSV to the browser as a file download. */
export const downloadCsv = (csv: string, filename: string): void => {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
