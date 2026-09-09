import type {
  ColumnMapping,
  ExtractedTable,
  MappedRoster,
  RosterRow,
  SkippedRow,
} from "./types";

/**
 * Working out which column is which, and turning a grid into roster rows.
 *
 * The guesses here are only ever a starting point: every one of them is shown
 * to the TA and can be overridden before anything is uploaded. That matters
 * because the failure this code can cause is silent. `mark_attendance` matches
 * `students.student_id` exactly and no format is enforced anywhere, so a
 * roster uploaded from the wrong column does not error — it enrols a set of
 * people whose IDs nobody will ever type, and every one of them is marked
 * absent for the rest of term. It looks like a check-in bug.
 */

/**
 * Header titles that mean "the ID a student types", best first.
 *
 * Order is the whole point. A CAMU report carries BOTH "ROLL NO" and "ROLL
 * NO/REGISTER NO.", and it is the register number that students actually use.
 * A naive substring match on "roll no" finds the wrong one, because it comes
 * first in the file and matches both.
 */
const ID_TITLES = [
  "roll no/register no",
  "roll no / register no",
  "register no",
  "registration no",
  "registration number",
  "student id",
  "student number",
  "index no",
  "index number",
  "id no",
  "roll no",
  "id",
];

const NAME_TITLES = [
  "student name",
  "full name",
  "name of student",
  "name",
];

/**
 * Titles that must never be taken for an ID.
 *
 * "S.NO." is a serial column: 1, 2, 3… It looks enough like an identifier to
 * be chosen by any value-shape heuristic, and enrolling a class as students
 * "1" through "40" is the worst outcome this feature has.
 */
const NEVER_ID = ["s.no", "sno", "serial", "sl.no", "#"];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[^a-z0-9/ -]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** How well a header cell matches a list of titles. Higher is better; 0 is no match. */
const scoreAgainst = (cell: string, titles: string[]): number => {
  const c = norm(cell);
  if (!c) return 0;

  for (let i = 0; i < titles.length; i += 1) {
    const t = titles[i];
    // Exact beats contained, and earlier in the list beats later, so
    // "roll no/register no" wins over the "roll no" that is inside it.
    if (c === t) return 1000 - i;
    if (c.includes(t)) return 500 - i;
  }
  return 0;
};

const isNeverId = (cell: string) => {
  const c = norm(cell);
  return NEVER_ID.some((t) => c === t || c.startsWith(t));
};

/**
 * Find the row that holds the column titles.
 *
 * A CAMU export puts a block of course details above the table, and a PDF adds
 * whatever the page header contained. The header row is the first one where
 * something scores as an ID column and something else scores as a name.
 * Falling back to "the first row" would silently treat a line of course
 * details as titles.
 */
export const findHeaderRow = (rows: string[][]): number | null => {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length < 2) continue;

    const hasId = row.some((c) => !isNeverId(c) && scoreAgainst(c, ID_TITLES) > 0);
    const hasName = row.some((c) => scoreAgainst(c, NAME_TITLES) > 0);

    if (hasId && hasName) return i;
  }
  return null;
};

/** Everything above the header row, as text worth showing or checking. */
export const preambleOf = (rows: string[][], headerRow: number | null): string[] =>
  rows
    .slice(0, headerRow ?? 0)
    .map((r) => r.filter((c) => c.trim()).join(" | "))
    .filter(Boolean);

/**
 * Does this cell look like somebody's ID rather than a word?
 *
 * Contains a digit, holds together as one token, and is long enough to be an
 * identifier. "20250001" passes; "Matric", "Faculty of Science" and "Semester
 * 3" do not.
 */
const looksLikeAnId = (cell: string): boolean => {
  const c = cell.trim();
  return c.length >= 3 && c.length <= 24 && !/\s/.test(c) && /\d/.test(c);
};

/**
 * Where the students start, when there are no column titles to go by.
 *
 * A report's own heading is just more text: nothing separates "Faculty of
 * Science" from a student except that it does not look like a roster row. So
 * two things have to hold. The row must be as wide as the table — preamble
 * lines are usually one cell where the data has five — and it must contain
 * something shaped like an ID.
 *
 * Both are needed. Width alone stops at the untitled header row, whose cells
 * are words; the ID test alone would accept a stray "2025-2026" sitting on its
 * own line above the table.
 */
export const findFirstDataRow = (
  rows: string[][],
  headerRow: number | null,
): number => {
  if (headerRow !== null) return headerRow + 1;
  if (rows.length === 0) return 0;

  const widths = new Map<number, number>();
  for (const row of rows) {
    const w = row.filter((c) => c.trim()).length;
    if (w > 1) widths.set(w, (widths.get(w) ?? 0) + 1);
  }

  if (widths.size === 0) return 0;

  const table = [...widths.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const full = rows.findIndex(
    (row) =>
      row.filter((c) => c.trim()).length === table &&
      row.some((c) => looksLikeAnId(c)),
  );
  if (full !== -1) return full;

  // No ID-shaped cell anywhere — an all-alphabetic roster is unusual but
  // possible. Fall back to the first row of table width and let the sample on
  // screen show whether that was right.
  const wide = rows.findIndex(
    (row) => row.filter((c) => c.trim()).length === table,
  );
  return wide === -1 ? 0 : wide;
};

/**
 * Guess the mapping. Every field may be null, and null means "ask".
 *
 * With no header row this returns nulls rather than guessing from the shape of
 * the values. A wrong guess here is invisible and expensive, and there is a
 * person right there who can look at the grid and say which column it is.
 */
export const autoMap = (rows: string[][]): ColumnMapping => {
  const headerRow = findHeaderRow(rows);
  if (headerRow === null) {
    return {
      studentId: null,
      name: null,
      headerRow: null,
      firstDataRow: findFirstDataRow(rows, null),
    };
  }

  const header = rows[headerRow];

  let studentId: number | null = null;
  let bestId = 0;
  let name: number | null = null;
  let bestName = 0;

  header.forEach((cell, i) => {
    if (!isNeverId(cell)) {
      const s = scoreAgainst(cell, ID_TITLES);
      if (s > bestId) {
        bestId = s;
        studentId = i;
      }
    }

    const n = scoreAgainst(cell, NAME_TITLES);
    if (n > bestName) {
      bestName = n;
      name = i;
    }
  });

  return {
    studentId,
    name,
    headerRow,
    firstDataRow: findFirstDataRow(rows, headerRow),
  };
};

/**
 * Does this row repeat the header?
 *
 * A PDF of several pages repeats the column titles on each one, and they would
 * otherwise be enrolled as a student called "STUDENT NAME".
 */
const repeatsHeader = (row: string[], header: string[]): boolean => {
  const a = row.map(norm).filter(Boolean);
  const b = header.map(norm).filter(Boolean);
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((cell, i) => cell === b[i]);
};

/**
 * Apply a mapping and produce the rows to upload.
 *
 * Rows that cannot be used are returned alongside rather than dropped, so the
 * preview can account for every line in the file. Duplicates are NOT removed
 * here: the server reports them with row numbers, and doing it in both places
 * is how the two drift apart.
 */
export const applyMapping = (
  table: ExtractedTable,
  mapping: ColumnMapping,
): MappedRoster => {
  const rows: RosterRow[] = [];
  const skipped: SkippedRow[] = [];

  if (mapping.studentId === null) return { rows, skipped };

  const header =
    mapping.headerRow === null ? [] : table.rows[mapping.headerRow] ?? [];

  // Not headerRow + 1: a document can have data that starts well below its
  // titles, or no titles at all above a block of report headings. Uploading
  // those enrols students called "Faculty of Science", and nothing downstream
  // objects because no format is enforced on an ID.
  const first = Math.max(0, mapping.firstDataRow ?? 0);

  for (let i = first; i < table.rows.length; i += 1) {
    const cells = table.rows[i];
    const at = (col: number | null) =>
      col === null ? "" : (cells[col] ?? "").trim();

    if (cells.every((c) => !c.trim())) continue; // blank line, not worth reporting

    if (header.length > 0 && repeatsHeader(cells, header)) {
      skipped.push({ row: i + 1, reason: "repeated column titles", cells });
      continue;
    }

    const id = at(mapping.studentId);
    if (!id) {
      skipped.push({ row: i + 1, reason: "no ID in that column", cells });
      continue;
    }

    rows.push({ student_id: id, name: at(mapping.name) || null });
  }

  return { rows, skipped };
};

/**
 * Pull a course code out of the preamble, if one is there.
 *
 * The CAMU report ends its detail line with the code — "… | Introduction to
 * Artificial Intelligence | CS254". Comparing that to the class being uploaded
 * into catches the other way this goes wrong: the right file, the wrong class.
 * Returns null rather than guessing wildly; a missing code is not a problem,
 * a wrong warning would be.
 */
export const courseCodeIn = (preamble: string[]): string | null => {
  const pattern = /\b([A-Z]{2,4})[ -]?(\d{3,4})\b/;

  for (const line of preamble) {
    const segments = line.split("|").map((s) => s.trim());
    // Last segment first: that is where the code sits in the CAMU layout.
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const m = segments[i].match(pattern);
      if (m) return `${m[1]}${m[2]}`;
    }
  }
  return null;
};

/** Loose comparison, so "CS 254" and "cs254" match a class coded "CS254". */
export const codesMatch = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return true; // nothing to disagree about
  const strip = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return strip(a) === strip(b);
};
