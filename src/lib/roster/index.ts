/**
 * Roster upload.
 *
 * A class list arrives as a CAMU CSV, a CAMU PDF, or a page printed out of
 * Canvas. Only the extraction differs; everything after it is shared.
 *
 * Nothing is ever saved. The file is read in the browser, parsed in memory,
 * and dropped when the dialog closes. What crosses the network is the
 * {student_id, name} list and nothing else.
 */

export type {
  ColumnMapping,
  ExtractedTable,
  MappedRoster,
  RosterRow,
  SkippedRow,
  SourceKind,
  UploadOutcome,
} from "./types";

export {
  applyMapping,
  autoMap,
  codesMatch,
  courseCodeIn,
  findHeaderRow,
  preambleOf,
} from "./columns";

export { readCsvFile, tableFromCsv } from "./csvSource";
