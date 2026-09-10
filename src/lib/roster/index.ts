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
  findFirstDataRow,
  findHeaderRow,
  preambleOf,
} from "./columns";

export { readCsvFile, tableFromCsv } from "./csvSource";

/*
 * The pure half of the spreadsheet reader. readXlsxFile stays out of here for
 * the same reason readPdfFile does: it pulls in a library the main bundle does
 * not need, and a plain-Node consumer of this module cannot load it. Import it
 * directly and dynamically:
 *
 *   const { readXlsxFile } = await import("@/lib/roster/xlsxSource");
 */
export {
  firstSheetOf,
  tableFromRows,
  type SheetCell,
  type SheetOfCells,
} from "./xlsxSource";

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
