/**
 * Roster upload: the shapes every source produces and the pipeline consumes.
 *
 * A class list arrives as a CAMU CSV, a CAMU PDF, or a page printed out of
 * Canvas. Those differ only in how the text is got out of the file. Once it is
 * out, it is a grid of strings, and everything after that — finding the header
 * row, deciding which column is the ID, previewing, uploading — is shared.
 *
 * NOTHING IS EVER SAVED. The file is read in the browser, parsed in memory,
 * and dropped when the dialog closes. What crosses the network is the
 * {student_id, name} list and nothing else: not the file, not its name, not
 * the columns that were discarded. A class list is exactly the kind of
 * personal data this project has already had to purge from its own history
 * once, and the cheapest way not to leak it is never to send it.
 */

/** Where a grid of text came from. Used for wording, not for logic. */
export type SourceKind = "csv" | "pdf";

/**
 * A rectangle of strings, exactly as it appeared in the file.
 *
 * Deliberately not yet interpreted: no header row is nominated, no column has
 * a meaning, nothing is trimmed away. A PDF extractor's guesses about layout
 * are wrong often enough that the raw grid has to survive as far as the
 * screen, where somebody can see what happened.
 */
export interface ExtractedTable {
  kind: SourceKind;
  /** Every row, including whatever preamble sat above the real header. */
  rows: string[][];
  /**
   * Free text found above the table — the CAMU report puts the year,
   * department, semester, course name and course code up there. Kept so the
   * upload can check it is going into the right class.
   */
  preamble: string[];
  /** Pages, for a PDF. One for a CSV. Reported so a truncated read is visible. */
  pageCount: number;
}

/** Which column of the grid means what. Indices into a row. */
export interface ColumnMapping {
  /** The ID a student types at check-in. Nothing works if this is wrong. */
  studentId: number | null;
  /** Optional: a roster with no names still enrols people correctly. */
  name: number | null;
  /** Index of the row holding the column titles, or null if there is none. */
  headerRow: number | null;
  /**
   * The first row that is actually a student.
   *
   * Separate from headerRow because a document can have neither titles nor a
   * blank line before its data — a report's own heading is just another row of
   * text, and uploading it enrols a student called "Faculty of Science". The
   * server enforces no format on an ID, so nothing downstream would object.
   */
  firstDataRow: number;
}

/** One row as the upload will send it. */
export interface RosterRow {
  student_id: string;
  name: string | null;
}

/** A row the pipeline dropped before sending, and why. */
export interface SkippedRow {
  /** 1-based index into ExtractedTable.rows, so it can be pointed at. */
  row: number;
  reason: string;
  cells: string[];
}

/** What the mapping step produced, ready to preview. */
export interface MappedRoster {
  rows: RosterRow[];
  skipped: SkippedRow[];
}

/**
 * What the server says an upload would do — or did.
 *
 * Returned verbatim by upsert_enrolments, whether or not p_dry_run was set, so
 * the preview and the result are the same shape because they are the same
 * function. See migration 023.
 */
export interface UploadOutcome {
  dry_run: boolean;
  created_students: number;
  reused_students: number;
  enrolled: number;
  already_enrolled: number;
  moved: number;
  in_other_cohort: { student_id: string; current_cohort: string }[];
  invalid: { row: number; reason: string }[];
}
