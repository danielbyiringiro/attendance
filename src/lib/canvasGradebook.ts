// Filling a Canvas gradebook export with an attendance column.
//
// Canvas documents this round-trip: "you can always download the CSV from
// Canvas, change it, and re-upload the same file". Taking their own export as
// the template means every identity column — Canvas's internal ID, SIS Login
// ID, Section, and the student's name exactly as Canvas spells it — is right by
// construction, with no name reformatting and no guessing.

import { BOM, csvCell, parseCsv } from "@/lib/csv";
import type { SummaryRow } from "@/lib/attendanceExport";

/**
 * Columns Canvas uses to work out which enrolment a row belongs to. These are
 * echoed byte-for-byte: an apostrophe added by the formula guard would stop
 * Canvas matching the student. Section is included because it disambiguates a
 * student enrolled in more than one section.
 *
 * The student's *name* is deliberately not here — Canvas never matches on it,
 * so it can be guarded like any other display text.
 */
const MATCH_KEY_HEADERS = [
  "id",
  "sis user id",
  "sis login id",
  "section",
  "integration id",
  "root account",
];

// Canvas silently ignores an assignment column whose name contains any of
// these, so a generated column title is checked against the list.
export const CANVAS_RESERVED_FRAGMENTS = [
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

export interface ParsedCanvasSheet {
  header: string[];
  /**
   * Canvas's exports carry a "Points Possible" row directly under the header.
   * It is not a student and must survive the round-trip in place.
   */
  pointsPossibleRow: string[] | null;
  rows: string[][];
  /** Column indexes, -1 when the export does not carry that column. */
  columns: {
    name: number;
    canvasId: number;
    sisUserId: number;
    section: number;
  };
}

export interface CanvasMatch {
  /** Index into ParsedCanvasSheet.rows. */
  rowIndex: number;
  canvasName: string;
  canvasSisId: string;
  /** Raw Section cell, e.g. "Cohort B". Empty when the export has no Section. */
  canvasSection: string;
  /** Cohort code read out of canvasSection, when one could be read. */
  canvasCohort: string | null;
  /** Resolved attendance student_id, or null while unmatched. */
  studentId: string | null;
  how: "sis-id" | "name" | "manual" | "remembered" | "unmatched";
  /**
   * Row that is not a person to be matched. Still written to the output file —
   * Canvas needs it back — but never counted as an unmatched student and never
   * offered for pairing.
   */
  ignored: boolean;
  ignoredReason?: "boilerplate" | "manual" | "remembered";
  /** Stable identity for remembering a decision about this row. */
  canvasKey: string;
}

/**
 * A key for this Canvas row that survives into the next export.
 *
 * Row position is useless — a fresh download can reorder freely. Canvas's
 * internal ID is preferred because it is stable per enrolment and never
 * re-typed; SIS User ID next; and failing both, the canonical name, which is
 * the weakest of the three but is all that is left for a row carrying no
 * identifier at all.
 */
export const canvasRowKey = (
  canvasId: string,
  sisUserId: string,
  name: string,
): string => {
  if (canvasId.trim()) return `cid:${norm(canvasId)}`;
  if (sisUserId.trim()) return `sis:${norm(sisUserId)}`;
  return `name:${nameKey(name)}`;
};

/**
 * Rows a Canvas export carries that are not enrolled people.
 *
 * Canvas's Student View adds a "Test Student"; a re-saved sheet can carry a
 * stray "Points Possible"; and a row with no name and no identifier at all is
 * structure, not a person. Extend this list rather than teaching the UI about
 * new special cases — anything missed here is still ignorable by hand.
 */
const BOILERPLATE_NAMES = new Set([
  "points possible",
  "test student",
  "student, test",
  "test, student",
]);

export const isBoilerplateRow = (
  name: string,
  sisId: string,
  canvasId: string,
): boolean => {
  const n = norm(name);
  if (BOILERPLATE_NAMES.has(n)) return true;
  // Nothing to identify a person by.
  return !n && !sisId.trim() && !canvasId.trim();
};

/**
 * Read a cohort code out of a Canvas Section label.
 *
 * Sections are free text — "Cohort B", "Section B", "CS101-B", or just "B" —
 * so this looks for a known cohort code as a standalone token and only commits
 * when exactly one matches. Anything ambiguous returns null and is treated as
 * "no opinion" rather than as a mismatch, because wrongly claiming a mismatch
 * would invite a TA to "correct" a cohort that was right all along.
 */
export const inferCohortFromSection = (
  section: string,
  knownCohorts: string[],
): string | null => {
  const tokens = section
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

  // "Cohort B" / "Section A" — the label says which one outright. This runs
  // first because the cohort a misfiled student *belongs* to may have nobody
  // in the tallied set, so it would not be in knownCohorts to recognise.
  const labelled = new Set<string>();
  tokens.forEach((t, i) => {
    if (t !== "COHORT" && t !== "SECTION") return;
    const next = tokens[i + 1];
    // A cohort code is short; "Section Main" names no cohort.
    if (next && next.length <= 2) labelled.add(next);
  });
  if (labelled.size === 1) return [...labelled][0];
  if (labelled.size > 1) return null; // names several, so it names none

  // Otherwise only commit when exactly one known cohort appears as its own
  // token — a substring like the "A" inside "ACCRA" must not count.
  const set = new Set(tokens);
  const hits = knownCohorts
    .map((c) => c.toUpperCase())
    .filter((c) => set.has(c));
  return hits.length === 1 ? hits[0] : null;
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Canonical form for fallback name matching: lowercase, punctuation stripped,
 * tokens sorted. "Carter, Robin Lee" and "Robin Lee Carter" both
 * become "carter lee robin", so word order stops mattering entirely.
 */
export const nameKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

const findColumn = (header: string[], ...candidates: string[]): number =>
  header.findIndex((h) => candidates.includes(norm(h)));

export const parseCanvasCsv = (text: string): ParsedCanvasSheet => {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("That file is empty.");
  }

  const header = rows[0];
  // The gradebook export heads this column "Student"; the import guide calls it
  // "Student Name". Accept either.
  const name = findColumn(header, "student", "student name");
  const canvasId = findColumn(header, "id");
  const sisUserId = findColumn(header, "sis user id");
  const section = findColumn(header, "section");

  if (name === -1 && sisUserId === -1) {
    throw new Error(
      'That does not look like a Canvas gradebook export — no "Student" or "SIS User ID" column. Download the CSV from your course\'s Grades page and upload that.',
    );
  }

  // Canvas puts Points Possible directly under the header, but scan the whole
  // body rather than trusting the position — a sheet that has been through
  // Excel or a re-sort can move it, and a missed one gets reported as a student
  // called "Points Possible" that the TA is then asked to match.
  const nameCellOf = (r: string[]) =>
    norm((name === -1 ? r[0] : r[name]) ?? r[0] ?? "");

  let pointsPossibleRow: string[] | null = null;
  const body: string[][] = [];
  rows.slice(1).forEach((r) => {
    if (pointsPossibleRow === null && nameCellOf(r) === "points possible") {
      pointsPossibleRow = r;
      return;
    }
    body.push(r);
  });

  // Drop trailing blank lines; a row of empty cells is not a student.
  const isBlank = (r: string[]) => r.every((c) => c.trim() === "");
  while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();

  return {
    header,
    pointsPossibleRow,
    rows: body,
    columns: { name, canvasId, sisUserId, section },
  };
};

/**
 * Pair each Canvas row with an attendance student.
 *
 * SIS User ID first, because it is this app's own student_id and needs no
 * interpretation. Name is a fallback and is only accepted when the canonical
 * form is unique on BOTH sides — two students sharing a name must be resolved
 * by hand rather than paired arbitrarily.
 */
export const matchCanvasRows = (
  sheet: ParsedCanvasSheet,
  summary: SummaryRow[],
): CanvasMatch[] => {
  // Cohort is deliberately not part of matching. Students do get filed under
  // the wrong cohort here, and a cohort-aware match would hide exactly the
  // people who most need correcting.
  const byId = new Map(summary.map((r) => [norm(r.student_id), r.student_id]));
  const knownCohorts = Array.from(
    new Set(summary.map((r) => r.cohort).filter(Boolean)),
  );

  const nameCounts = new Map<string, number>();
  summary.forEach((r) => {
    if (!r.name) return;
    const k = nameKey(r.name);
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  });
  const byName = new Map<string, string>();
  summary.forEach((r) => {
    if (!r.name) return;
    const k = nameKey(r.name);
    if (nameCounts.get(k) === 1) byName.set(k, r.student_id);
  });

  const canvasNameCounts = new Map<string, number>();
  sheet.rows.forEach((row) => {
    const k = nameKey(sheet.columns.name === -1 ? "" : row[sheet.columns.name] ?? "");
    if (k) canvasNameCounts.set(k, (canvasNameCounts.get(k) ?? 0) + 1);
  });

  const taken = new Set<string>();
  const matches: CanvasMatch[] = sheet.rows.map((row, rowIndex) => {
    const canvasName =
      sheet.columns.name === -1 ? "" : (row[sheet.columns.name] ?? "").trim();
    const canvasSisId =
      sheet.columns.sisUserId === -1
        ? ""
        : (row[sheet.columns.sisUserId] ?? "").trim();
    const canvasSection =
      sheet.columns.section === -1
        ? ""
        : (row[sheet.columns.section] ?? "").trim();
    const canvasCohort = canvasSection
      ? inferCohortFromSection(canvasSection, knownCohorts)
      : null;

    const canvasId =
      sheet.columns.canvasId === -1
        ? ""
        : (row[sheet.columns.canvasId] ?? "").trim();

    const base = {
      rowIndex,
      canvasName,
      canvasSisId,
      canvasSection,
      canvasCohort,
      canvasKey: canvasRowKey(canvasId, canvasSisId, canvasName),
    };

    if (isBoilerplateRow(canvasName, canvasSisId, canvasId)) {
      return {
        ...base,
        studentId: null,
        how: "unmatched" as const,
        ignored: true,
        ignoredReason: "boilerplate" as const,
      };
    }

    const viaId = canvasSisId ? byId.get(norm(canvasSisId)) : undefined;
    if (viaId && !taken.has(viaId)) {
      taken.add(viaId);
      return { ...base, studentId: viaId, how: "sis-id" as const, ignored: false };
    }

    return {
      ...base,
      studentId: null,
      how: "unmatched" as const,
      ignored: false,
    };
  });

  // Name fallback runs as a second pass so an ID match always wins the student.
  matches.forEach((m) => {
    if (m.ignored || m.studentId || !m.canvasName) return;
    const k = nameKey(m.canvasName);
    if (canvasNameCounts.get(k) !== 1) return; // ambiguous within the Canvas file
    const candidate = byName.get(k);
    if (!candidate || taken.has(candidate)) return;
    taken.add(candidate);
    m.studentId = candidate;
    m.how = "name";
  });

  return matches;
};

export interface FillOptions {
  sheet: ParsedCanvasSheet;
  matches: CanvasMatch[];
  summary: SummaryRow[];
  /** Sessions held, written into the Points Possible row. */
  sessionDays: number;
  startStr: string;
  endStr: string;
}

export interface FillResult {
  csv: string;
  filename: string;
  columnName: string;
  filled: number;
  blank: number;
}

export const fillCanvasSheet = ({
  sheet,
  matches,
  summary,
  sessionDays,
  startStr,
  endStr,
}: FillOptions): FillResult => {
  const columnName = `Attendance ${startStr} to ${endStr}`;
  const clash = CANVAS_RESERVED_FRAGMENTS.find((f) => columnName.includes(f));
  if (clash) {
    throw new Error(
      `Canvas ignores assignment columns containing "${clash}".`,
    );
  }
  if (sheet.header.some((h) => norm(h) === norm(columnName))) {
    throw new Error(
      `This export already has a column named "${columnName}". Re-upload a fresh gradebook export, or pick a different date range.`,
    );
  }

  const scoreByStudent = new Map(summary.map((r) => [r.student_id, r.present]));
  const scoreByRow = new Map<number, number>();
  matches.forEach((m) => {
    if (!m.studentId) return;
    const score = scoreByStudent.get(m.studentId);
    if (score !== undefined) scoreByRow.set(m.rowIndex, score);
  });

  const matchKeys = new Set(
    sheet.header
      .map((h, i) => (MATCH_KEY_HEADERS.includes(norm(h)) ? i : -1))
      .filter((i) => i !== -1),
  );

  const width = sheet.header.length;
  // Pad short rows so the appended column always lands in the same position.
  const pad = (row: string[]) =>
    row.length >= width ? row.slice(0, width) : [...row, ...Array(width - row.length).fill("")];

  const line = (row: string[], extra: string) =>
    [
      // Match keys are echoed verbatim; everything else is guarded.
      ...pad(row).map((c, i) => csvCell(c, !matchKeys.has(i))),
      csvCell(extra),
    ].join(",");

  const out: string[] = [
    [...sheet.header.map((h) => csvCell(h, false)), csvCell(columnName, false)].join(","),
  ];

  if (sheet.pointsPossibleRow) {
    // Points possible for the new column, so Canvas does not have to ask.
    out.push(line(sheet.pointsPossibleRow, String(sessionDays)));
  }

  sheet.rows.forEach((row, i) => {
    const score = scoreByRow.get(i);
    // An unmatched student gets a blank cell, which Canvas reads as "leave this
    // student's grade alone" rather than as a zero.
    out.push(line(row, score === undefined ? "" : String(score)));
  });

  const filled = scoreByRow.size;
  return {
    csv: `${BOM}${out.join("\r\n")}\r\n`,
    filename: `Grades-Attendance-${startStr}-to-${endStr}.csv`,
    columnName,
    filled,
    blank: sheet.rows.length - filled,
  };
};
