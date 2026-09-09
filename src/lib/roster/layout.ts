/**
 * Turning positioned text back into a table.
 *
 * A PDF has no table. It has glyphs at coordinates, and whatever structure a
 * reader sees is inferred from where they sit. Everything here is that
 * inference, kept deliberately apart from pdfjs so it can be tested against
 * made-up coordinates rather than against a real class list.
 *
 * None of it is trusted. The result goes through the same mapping and preview
 * screens as a CSV, where a person can see the columns before anything is
 * uploaded — which is the actual safeguard. This code only has to be right
 * often enough to be useful.
 */

/** One run of text, as a PDF hands it over: a position and a size. */
export interface PositionedText {
  text: string;
  /** Left edge, in PDF units, origin at the page's top-left. */
  x: number;
  /** Top edge, increasing downwards. */
  y: number;
  width: number;
  height: number;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Group runs that sit on the same visual line.
 *
 * Two runs belong together when their vertical centres are within a fraction
 * of a line height. Comparing tops instead would split a line wherever a
 * smaller font sat beside a larger one, which is what a header does.
 */
export const groupIntoLines = (
  items: PositionedText[],
): PositionedText[][] => {
  if (items.length === 0) return [];

  const tolerance = Math.max(1, median(items.map((i) => i.height)) * 0.5);
  const centre = (i: PositionedText) => i.y + i.height / 2;

  const sorted = [...items].sort((a, b) => centre(a) - centre(b));
  const lines: PositionedText[][] = [];
  let current: PositionedText[] = [sorted[0]];
  let currentY = centre(sorted[0]);

  for (let i = 1; i < sorted.length; i += 1) {
    const item = sorted[i];
    if (Math.abs(centre(item) - currentY) <= tolerance) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
      currentY = centre(item);
    }
  }
  lines.push(current);

  return lines.map((line) => [...line].sort((a, b) => a.x - b.x));
};

/**
 * Work out where the columns are, across the whole page.
 *
 * Per-line guessing cannot work: a line with three filled cells out of seven
 * says nothing about which three. Gathering every run's left edge and
 * clustering them gives the column positions the document was laid out on.
 */
export const detectColumns = (items: PositionedText[]): number[] => {
  if (items.length === 0) return [];

  // A column is a place text starts. Two runs start in the same column when
  // their left edges are within about a character of each other.
  const tolerance = Math.max(2, median(items.map((i) => i.height)) * 0.9);
  const lines = groupIntoLines(items);

  const tagged: { x: number; line: number }[] = [];
  lines.forEach((line, index) =>
    line.forEach((item) => tagged.push({ x: item.x, line: index })),
  );
  tagged.sort((a, b) => a.x - b.x);

  const clusters: { at: number; lines: Set<number> }[] = [];
  let at = tagged[0].x;
  let last = tagged[0].x;
  let seen = new Set<number>([tagged[0].line]);

  for (let i = 1; i < tagged.length; i += 1) {
    if (tagged[i].x - last <= tolerance) {
      last = tagged[i].x;
      seen.add(tagged[i].line);
    } else {
      clusters.push({ at, lines: seen });
      at = tagged[i].x;
      last = tagged[i].x;
      seen = new Set<number>([tagged[i].line]);
    }
  }
  clusters.push({ at, lines: seen });

  // A column has to appear on more than one line to be believed.
  //
  // PDFs split text at every font and kerning change, so "Yaa Owusu" can
  // arrive as two runs with the second starting partway into the cell. That
  // start position is an accident of the name's length: it appears on exactly
  // one line and never recurs. Treated as a column it would cut every long
  // name in the document in half, and — worse — shift what "column 3" means,
  // so the ID column chosen on screen would not be the one read from the file.
  //
  // A real column is where the layout puts text on line after line.
  const threshold = lines.length >= 2 ? 2 : 1;
  const kept = clusters.filter((c) => c.lines.size >= threshold);

  // Unless that leaves nothing, in which case the document is too small for
  // the evidence to exist and every candidate is as good as it gets.
  return (kept.length > 0 ? kept : clusters).map((c) => c.at);
};

/** Which column a run belongs to: the rightmost one that starts at or before it. */
const columnOf = (item: PositionedText, columns: number[]): number => {
  let found = 0;
  for (let c = 0; c < columns.length; c += 1) {
    if (item.x + 0.5 >= columns[c]) found = c;
    else break;
  }
  return found;
};

/**
 * Should this line be folded into the one above it?
 *
 * Cells wrap. In the CAMU report the header alone wraps three deep — "ROLL
 * NO/REGISTER NO." over three lines, "ENROLLED DEPARTMENT" over two — and a
 * long student name wraps the same way. Treating each visual line as a table
 * row would put "NO." in a row of its own and hide the header entirely.
 *
 * The cue is the first column. Every real row has something in it: a serial
 * number, or an ID if the document has no serial column. A continuation line
 * never does, because the cell it continues is further right. That reads the
 * document the way a person does — the left-hand column is what says "new
 * row" — rather than guessing from line spacing, which varies with font size
 * and is very nearly the same for a wrapped line and a fresh row.
 */
const isContinuation = (
  cells: string[],
  previous: string[] | null,
): boolean => {
  if (!previous) return false;
  if (cells.length === 0) return false;
  return !cells[0]?.trim();
};

/**
 * Positioned text to a grid of strings.
 *
 * Runs landing in the same cell are joined with a space: a PDF splits text at
 * every font or kerning change, so "Ama Serwaa" can arrive in three pieces.
 */
export const buildGrid = (items: PositionedText[]): string[][] => {
  const usable = items.filter((i) => i.text.trim().length > 0);
  if (usable.length === 0) return [];

  const columns = detectColumns(usable);
  const lines = groupIntoLines(usable);

  const grid: string[][] = [];

  for (const line of lines) {
    const cells: string[] = new Array(columns.length).fill("");

    for (const item of line) {
      const c = columnOf(item, columns);
      cells[c] = cells[c] ? `${cells[c]} ${item.text.trim()}` : item.text.trim();
    }

    const previous = grid.length > 0 ? grid[grid.length - 1] : null;

    if (isContinuation(cells, previous) && previous) {
      // Append into the cell it continues, rather than making a row of it.
      for (let c = 0; c < cells.length; c += 1) {
        if (!cells[c]) continue;
        previous[c] = previous[c] ? `${previous[c]} ${cells[c]}` : cells[c];
      }
      continue;
    }

    grid.push(cells);
  }

  // Trailing empty columns appear when a stray run sits past the last column.
  return grid.map((row) => {
    let end = row.length;
    while (end > 0 && !row[end - 1].trim()) end -= 1;
    return row.slice(0, end);
  });
};
