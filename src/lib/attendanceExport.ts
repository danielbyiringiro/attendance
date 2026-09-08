// Attendance export — turns stored attendance into a downloadable CSV covering
// any date range, one cohort or all of them, one student or everyone.
//
// It used to infer which days had counted: every Tue/Wed/Thu in range was a
// candidate, and a cohort was taken to have met on one if somebody in it had
// checked in. That was the only option when absence was not stored. Sessions
// are rows now, so the days come from the class and the states come from
// attendance_records — the same read every screen uses.

import { toCsv } from "@/lib/csv";
import { attendanceLog, isPresentState } from "@/lib/api/attendance";
import type { AttendanceState } from "@/lib/api/types";
import { listEnrolments } from "@/lib/api/enrolment";
import { getClass } from "@/lib/api/classes";
import { toDateStr } from "@/lib/dates";

export { toDateStr };

export type CohortFilter = "all" | string;
export type ExportShape = "summary" | "detail";
/** The words the CSV uses. Widened from three so `late` and `exempted` — real
 *  stored states — do not have to be flattened before they are rendered. */
export type DayStatus =
  | "Present"
  | "Late"
  | "Excused"
  | "Absent"
  | "Exempt"
  | "No record";

/**
 * Target system for the file. "default" is this app's own layout; the others
 * shape the same numbers into whatever a downstream gradebook expects. New
 * targets are added to FORMATS below — nothing else needs to change.
 */
export type ExportFormat = "default" | "canvas" | "canvas-fill";

export interface ExportOptions {
  /** The class being exported. Every count is scoped to it. */
  classId: string;
  /** First day of the range, inclusive (clamped to the term start). */
  start: Date;
  /** Last day of the range, inclusive (clamped to today). */
  end: Date;
  /** "all" for every cohort, or one cohort's uuid. */
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
  /** Distinct dates with a session, across the cohorts in scope. */
  sessionDays: number;
  /** Sessions in range before cancelled ones were removed. */
  candidateDays: number;
  summary: SummaryRow[];
  detail: DetailRow[];
}

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

export const buildAttendanceExport = async (
  options: ExportOptions,
): Promise<ExportResult> => {
  const {
    classId,
    cohort,
    studentId,
    shape,
    format = "default",
    mergeExcusedIntoPresent: mergeExcused = false,
  } = options;

  const requestedStart = toDateStr(options.start);
  const requestedEnd = toDateStr(options.end);
  const today = toDateStr(new Date());

  // The term comes from the class rather than a constant in this file. There
  // used to be two such constants, in this module and in StudentDashboard, and
  // they disagreed by eight days — so a student's own history and the CSV about
  // them counted from different mornings.
  const klass = await getClass(classId);

  const startStr =
    klass && requestedStart < klass.term_starts_on
      ? klass.term_starts_on
      : requestedStart;
  const endStr = requestedEnd > today ? today : requestedEnd;

  const clampNotes: string[] = [];
  if (startStr !== requestedStart) {
    clampNotes.push(`start moved to ${startStr} (term start)`);
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
      "That range has no tracked sessions — it falls entirely before the term started or in the future.",
    );
  }

  // --- roster -------------------------------------------------------------
  // The class's enrolments, not every student in the database. `cohort` is a
  // cohort uuid now, so two classes can both have a Cohort A.
  const enrolled = await listEnrolments(classId, {
    cohortId: cohort === "all" ? undefined : cohort,
  });

  const roster = enrolled
    .map((r) => ({
      student_id: r.student_id,
      cohort_id: r.cohort_id,
      cohort: r.cohort_label,
      name: r.name || "",
    }))
    .filter((r) => (studentId ? r.student_id === studentId : true))
    .sort((a, b) => a.student_id.localeCompare(b.student_id));

  if (roster.length === 0) {
    return empty("No students matched that cohort/student selection.");
  }

  // --- attendance ---------------------------------------------------------
  // One read, the same one every screen uses. Everything the old version had to
  // assemble by hand — which days a cohort met, which were cancelled, who was
  // excused, who checked in — is a column on these rows.
  const log = await attendanceLog(classId, {
    from: startStr,
    to: endStr,
    cohortId: cohort === "all" ? undefined : cohort,
  });

  const held = log.sessions.filter((sn) => sn.status !== "cancelled");

  if (held.length === 0) {
    return empty(
      `No sessions ran between ${startStr} and ${endStr}, so there is nothing to count anyone absent from.`,
    );
  }

  // Sessions per cohort, so a cancellation for one cohort leaves the others
  // alone. That was a per-date lookup before, and cancelling A's Wednesday
  // removed it from B and C too.
  const sessionsByCohort = new Map<string, number>();
  held.forEach((sn) =>
    sessionsByCohort.set(
      sn.cohort_id,
      (sessionsByCohort.get(sn.cohort_id) ?? 0) + 1,
    ),
  );

  const stateOf = new Map<string, AttendanceState>();
  log.marks.forEach((m) => stateOf.set(`${m.student_id}-${m.session_id}`, m.state));

  const STATUS: Record<string, DayStatus> = {
    present: "Present",
    late: "Late",
    excused: "Excused",
    unexcused: "Absent",
    exempted: "Exempt",
  };

  // --- tally --------------------------------------------------------------
  const summary: SummaryRow[] = [];
  const detail: DetailRow[] = [];

  // A student's sessions are their own cohort's, so a cohort that met twice a
  // week and one that met three times are each counted over their own days.
  const sessionsFor = new Map<string, typeof held>();
  held.forEach((sn) => {
    const list = sessionsFor.get(sn.cohort_id);
    if (list) list.push(sn);
    else sessionsFor.set(sn.cohort_id, [sn]);
  });

  roster.forEach((student) => {
    const sessions = (sessionsFor.get(student.cohort_id) ?? [])
      .slice()
      .sort((x, y) => x.session_date.localeCompare(y.session_date));

    let attended = 0;
    let excused = 0;
    let absent = 0;
    let exempt = 0;

    sessions.forEach((sn) => {
      const state = stateOf.get(`${student.student_id}-${sn.session_id}`) ?? null;

      // Read, not derived. A student with no row for a closed session has one
      // by definition — close_session writes `unexcused` for everyone enrolled
      // who did not mark — so "No record" means the session is still open.
      let status: DayStatus = state ? (STATUS[state] ?? "No record") : "No record";

      if (isPresentState(state)) attended += 1;
      else if (state === "excused") {
        excused += 1;
        // Merged, an excused day reports as attendance everywhere — including
        // the per-day status, so the detail sheet agrees with the totals.
        if (mergeExcused) status = "Present";
      } else if (state === "unexcused") absent += 1;
      else if (state === "exempted") exempt += 1;

      if (shape === "detail") {
        detail.push({
          student_id: student.student_id,
          name: student.name,
          cohort: student.cohort,
          date: sn.session_date,
          status,
        });
      }
    });

    // Exempted days leave both sides of the fraction, always. Excused days do
    // too, unless the caller asked for them to be merged into present.
    const countable = sessions.length - exempt;
    const present = mergeExcused ? attended + excused : attended;
    const gradedDays = mergeExcused ? countable : countable - excused;

    summary.push({
      student_id: student.student_id,
      name: student.name,
      cohort: student.cohort,
      classDays: countable,
      present,
      absent,
      excused,
      attendanceRate:
        gradedDays > 0 ? Math.round((present / gradedDays) * 1000) / 10 : 0,
    });
  });

  const heldDays = new Set(held.map((sn) => sn.session_date));

  const notes: string[] = [];
  if (clampNotes.length) {
    notes.push(`Range adjusted: ${clampNotes.join("; ")}`);
  }
  const cancelled = log.sessions.length - held.length;
  if (cancelled > 0) {
    notes.push(
      `${cancelled} cancelled session${cancelled === 1 ? "" : "s"} excluded, for the cohorts they belonged to`,
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
    candidateDays: log.sessions.length,
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
