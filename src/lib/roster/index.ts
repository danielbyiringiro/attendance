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

export {
  buildGrid,
  detectColumns,
  groupIntoLines,
  type PositionedText,
} from "./layout";

/*
 * pdfSource is deliberately NOT re-exported here.
 *
 * It pulls in pdfjs, about a megabyte, and a Vite-only `?url` import for the
 * worker. Re-exporting it would drag both into the main bundle for everybody
 * and break any plain-Node consumer of this module — the tests included.
 * Import it directly, and dynamically:
 *
 *   const { readPdfFile } = await import("@/lib/roster/pdfSource");
 */
