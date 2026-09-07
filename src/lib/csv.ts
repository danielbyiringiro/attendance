// CSV reading and writing, shared by the attendance export and the Canvas
// gradebook round-trip.

// Byte-order mark. Without it Excel opens the file as the local ANSI code page
// and mangles any non-ASCII name.
export const BOM = String.fromCharCode(0xfeff);

// A cell that opens with one of these is run as a formula when the file is
// opened in Excel or Sheets.
const RISKY_LEAD = /^[=+\-@\t\r]/;

/**
 * Quote one cell. `guardFormulas` prefixes an apostrophe to anything Excel
 * would execute — correct for values this app generates, but NOT for identity
 * columns being echoed back to another system, where an altered string stops
 * matching.
 */
export const csvCell = (
  value: string | number,
  guardFormulas = true,
): string => {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = guardFormulas && RISKY_LEAD.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Serialise rows to an Excel-friendly CSV: UTF-8 BOM, CRLF, every cell quoted. */
export const toCsv = (
  header: string[],
  rows: (string | number)[][],
  guardFormulas = true,
): string => {
  const lines = [header, ...rows].map((r) =>
    r.map((c) => csvCell(c, guardFormulas)).join(","),
  );
  return `${BOM}${lines.join("\r\n")}\r\n`;
};

/**
 * Parse CSV text into rows of cells.
 *
 * Handles quoted fields containing commas, newlines and doubled quotes, plus a
 * leading BOM and either line ending. Blank trailing lines are dropped; a blank
 * line in the middle is kept, because in a gradebook a row of empty cells is
 * still a row.
 */
export const parseCsv = (text: string): string[][] => {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endCell();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Swallow CRLF as one break.
      endRow();
      i += src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  // Whatever is still buffered is the last row, unless the file ended on a
  // line break and left nothing behind.
  if (cell !== "" || row.length > 0) endRow();

  return rows;
};
