// Attendance export — turns the raw check-in tables into a downloadable CSV
// covering any date range, one cohort or all of them, one student or everyone.
//
// The counting rules here mirror the weekly report in TADashboard: a class day
// is a Tue/Wed/Thu that is not cancelled, a student is "present" if they have a
// check-in row for it, "excused" if a TA granted permission, and "absent"
// otherwise. Excused days are never counted as absences.

import { supabase } from "@/lib/supabase";

// Attendance is only tracked from this date forward; anything earlier has no
// check-in rows at all and would read as everybody being absent.
export const SEMESTER_START = new Date(Date.UTC(2026, 4, 18));
export const SEMESTER_START_STR = SEMESTER_START.toISOString().slice(0, 10);

// Class meets Tuesday, Wednesday and Thursday.
const CLASS_WEEKDAYS = new Set([2, 3, 4]);

export type CohortFilter = "all" | string;
export type ExportShape = "summary" | "detail";
export type DayStatus = "Present" | "Excused" | "Absent";

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
}

export interface SummaryRow {
  student_id: string;
  name: string;
  cohort: string;
  classDays: number;
  present: number;
  absent: number;
  excused: number;
  /** Present / (class days - excused), as a percentage. */
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
// CSV
// ---------------------------------------------------------------------------

// Byte-order mark. Without it Excel opens the file as the local ANSI code
// page and mangles any non-ASCII name.
const BOM = String.fromCharCode(0xfeff);

// A cell that opens with one of these is run as a formula when the file is
// opened in Excel or Sheets. Names and IDs come from user input, so they get a
// leading apostrophe to force them back to text.
const RISKY_LEAD = /^[=+\-@\t\r]/;

const csvCell = (value: string | number): string => {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = RISKY_LEAD.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
};

const toCsv = (header: string[], rows: (string | number)[][]): string => {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  // CRLF line endings, because that is what Excel itself writes.
  return `${BOM}${lines.join("\r\n")}\r\n`;
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
  const { cohort, studentId, shape } = options;

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
  const presentRows = await fetchAll<{ student_id: string; timestamp: string }>(
    "present_students",
    "student_id, timestamp",
    (q) =>
      q
        .gte("timestamp", `${startStr}T00:00:00`)
        .lte("timestamp", `${endStr}T23:59:59.999`)
        .order("timestamp", { ascending: true }),
  );
  const presentSet = new Set(
    presentRows.map(
      (r) => `${r.student_id}-${String(r.timestamp).slice(0, 10)}`,
    ),
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

  // --- class days per cohort ----------------------------------------------
  const allDays = eachDateStr(startStr, endStr).filter((ds) =>
    CLASS_WEEKDAYS.has(weekdayOf(ds)),
  );

  if (allDays.length === 0) {
    return empty(
      `No class days (Tue/Wed/Thu) fall between ${startStr} and ${endStr}.`,
    );
  }

  const classDaysFor = new Map<string, string[]>();
  const daysForCohort = (c: string): string[] => {
    if (!classDaysFor.has(c)) {
      const cancelled = cancelledByCohort.get(c);
      classDaysFor.set(
        c,
        cancelled ? allDays.filter((ds) => !cancelled.has(ds)) : allDays,
      );
    }
    return classDaysFor.get(c)!;
  };

  // --- tally --------------------------------------------------------------
  const summary: SummaryRow[] = [];
  const detail: DetailRow[] = [];

  roster.forEach((student) => {
    const days = daysForCohort(student.cohort);
    let present = 0;
    let excused = 0;
    let absent = 0;

    days.forEach((ds) => {
      const key = `${student.student_id}-${ds}`;
      let status: DayStatus;
      if (presentSet.has(key)) {
        status = "Present";
        present += 1;
      } else if (excusedSet.has(key)) {
        status = "Excused";
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

    // Excused days come out of the denominator rather than counting against
    // the student.
    const gradedDays = days.length - excused;
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

  // --- csv ----------------------------------------------------------------
  const scopeLabel = studentId
    ? studentId
    : cohort === "all"
      ? "all-cohorts"
      : `cohort-${cohort}`;
  const filename = `attendance_${shape}_${scopeLabel}_${startStr}_to_${endStr}.csv`;

  const csv =
    shape === "detail"
      ? toCsv(
          ["Student ID", "Name", "Cohort", "Date", "Status"],
          detail.map((r) => [r.student_id, r.name, r.cohort, r.date, r.status]),
        )
      : toCsv(
          [
            "Student ID",
            "Name",
            "Cohort",
            "Class Days",
            "Present",
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
        );

  return {
    csv,
    filename,
    rowCount: shape === "detail" ? detail.length : summary.length,
    effectiveStart: startStr,
    effectiveEnd: endStr,
    notice: clampNotes.length
      ? `Range adjusted: ${clampNotes.join("; ")}.`
      : undefined,
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
