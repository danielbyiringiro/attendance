import { parseCsv } from "@/lib/csv";
import { findHeaderRow, preambleOf } from "./columns";
import type { ExtractedTable } from "./types";

/**
 * A CSV export turned into a grid.
 *
 * parseCsv already handles the BOM Excel writes, quoted cells containing
 * commas, and CRLF line endings, so there is nothing to do here but decide
 * what counts as preamble.
 *
 * The file is read with File.text() and never stored: no upload, no
 * IndexedDB, no Blob URL kept alive after this returns.
 */
export const tableFromCsv = (text: string): ExtractedTable => {
  const rows = parseCsv(text);

  // Trailing blank lines are usual in an exported CSV and carry no meaning.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => !c.trim())) {
    rows.pop();
  }

  const headerRow = findHeaderRow(rows);

  return {
    kind: "csv",
    rows,
    preamble: preambleOf(rows, headerRow),
    pageCount: 1,
  };
};

/**
 * Read a File the user picked. Separated from tableFromCsv so the parsing can
 * be tested without a File object.
 *
 * Latin-1 fallback: a CAMU export is normally UTF-8, but a spreadsheet saved
 * on a Windows machine can arrive as Windows-1252, where a name with an accent
 * decodes to U+FFFD under UTF-8. Retrying gives a mangled-but-recognisable
 * name rather than a replacement character, and the TA can see and fix it in
 * the preview.
 */
export const readCsvFile = async (file: File): Promise<ExtractedTable> => {
  const buffer = await file.arrayBuffer();

  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("�")) {
    text = new TextDecoder("windows-1252").decode(buffer);
  }

  return tableFromCsv(text);
};
