import { findHeaderRow, preambleOf } from "./columns";
import type { ExtractedTable } from "./types";

/**
 * A spreadsheet turned into a grid.
 *
 * CAMU exports a class list as .xlsx as well as CSV and PDF, and it is the one
 * people actually download — a browser saves it without asking, where CSV
 * needs a menu.
 *
 * The shape it arrives in is not the CSV's. The course details are stacked one
 * per row in the first column with a blank row between each, rather than on a
 * single pipe-separated line, and there is one ID column (`Register No`) where
 * the PDF has two. Neither needs special handling here: findHeaderRow looks
 * for a row carrying both an ID title and a name title, and `register no` was
 * already in ID_TITLES.
 *
 * Split the same way as the PDF reader: the part that needs a library is thin
 * and untested, the part that decides anything is pure and tested.
 */

/** A cell as a spreadsheet hands it over, before anything is decided about it. */
export type SheetCell = string | number | boolean | Date | null;

/**
 * Cells to strings, and the grid to an ExtractedTable.
 *
 * Numbers matter here in a way they do not for CSV. A student ID that happens
 * to be all digits arrives as a NUMBER, and `20250001` stringifies fine — but
 * a long one becomes `2.0250001e+7`, and one with a leading zero loses it.
 * Neither is recoverable later, so both are handled at the boundary.
 */
export const tableFromRows = (rows: SheetCell[][]): ExtractedTable => {
  const text = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return "";
      if (cell instanceof Date) return cell.toISOString().slice(0, 10);
      if (typeof cell === "number") {
        // Not String(n): that gives exponent notation past 1e21 and, more
        // pressingly, a float that is really an integer picks up ".0" in some
        // producers. An ID is an identifier, not a quantity.
        return Number.isInteger(cell)
          ? BigInt(cell).toString()
          : String(cell);
      }
      return String(cell).trim();
    }),
  );

  // Trailing blank rows are usual: a sheet's used range often runs past its
  // content, and a spreadsheet with a hundred empty rows below the roster
  // would otherwise report a hundred unusable lines.
  while (text.length > 0 && text[text.length - 1].every((c) => !c.trim())) {
    text.pop();
  }

  const headerRow = findHeaderRow(text);

  return {
    kind: "xlsx",
    rows: text,
    preamble: preambleOf(text, headerRow),
    pageCount: 1,
  };
};

/** One worksheet, as the library hands a workbook over: every sheet at once. */
export interface SheetOfCells {
  sheet: string;
  data: SheetCell[][];
}

/**
 * The first sheet's cells, and how many sheets there were.
 *
 * Separated out and exported because getting this wrong is what shipped: the
 * library's default export returns EVERY sheet as {sheet, data} objects, not a
 * grid of cells, so treating the result as rows gives "row.map is not a
 * function" the moment a real file is opened. TypeScript said so —
 * "Type 'Sheet<number>' is missing the following properties" — and the error
 * was overridden with a cast rather than read.
 *
 * So the decision lives here, where a test can reach it, rather than inside
 * the part that needs a real workbook to run at all.
 */
export const firstSheetOf = (
  sheets: SheetOfCells[],
): { rows: SheetCell[][]; sheetCount: number } => ({
  rows: sheets[0]?.data ?? [],
  sheetCount: sheets.length,
});

/**
 * Read a workbook the user picked.
 *
 * The library is loaded on demand — an .xlsx is a zip of XML and the reader is
 * not small, while most uploads are not spreadsheets.
 *
 * Only the first sheet is used. Concatenating several would merge two classes
 * into one roster, so the count comes back on the table and the dialog says so
 * when there is more than one: taking the first silently is still a choice
 * somebody should be told about.
 */
export const readXlsxFile = async (file: File): Promise<ExtractedTable> => {
  // The /browser entry point specifically: the package exports no root, and
  // the Node one would pull in its stream handling.
  const readWorkbook = (await import("read-excel-file/browser")).default;

  const { rows, sheetCount } = firstSheetOf(
    (await readWorkbook(file)) as unknown as SheetOfCells[],
  );

  return { ...tableFromRows(rows), pageCount: sheetCount };
};
