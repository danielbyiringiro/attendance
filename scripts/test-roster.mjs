// Assertions for roster-file parsing.
//
// Run with `npm run test:roster`. Bundles src/lib/roster/* — which touches no
// database and imports no Supabase — and asserts against invented class lists
// shaped like the real exports.
//
// EVERY NAME AND ID IN THIS FILE IS MADE UP. Fixtures for this feature must
// never be taken from a real class list: that is precisely the personal data
// the project has already had to purge from its own history once.
//
// The failure being guarded against is silent. mark_attendance matches
// students.student_id exactly and no format is enforced anywhere, so choosing
// the wrong column does not error — it enrols people whose IDs nobody will
// ever type, and marks every one of them absent for the rest of term.

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath, not .pathname: this repo's path contains a space, which
// .pathname hands back percent-encoded and esbuild cannot resolve.
const root = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
let checks = 0;

const ok = (label, condition, detail = "") => {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const eq = (label, actual, expected) =>
  ok(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

const out = join(mkdtempSync(join(tmpdir(), "roster-")), "roster.mjs");

await build({
  entryPoints: [join(root, "src/lib/roster/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "warning",
});

const {
  tableFromCsv,
  findHeaderRow,
  autoMap,
  applyMapping,
  courseCodeIn,
  codesMatch,
  buildGrid,
  detectColumns,
  groupIntoLines,
} = await import(pathToFileURL(out).href);

// ---------------------------------------------------------------------------
// A CAMU-shaped export. Invented people, real layout.
//
// Two ID columns, and the one students actually type is the SECOND. A match on
// "roll no" finds the wrong one, because it comes first and is a substring of
// the right one.
// ---------------------------------------------------------------------------

const CAMU = [
  "Example University",
  "2025-2026 | Computer Science and Information Systems | Semester 3 | Introduction to Artificial Intelligence | CS254",
  "",
  "Enrolled Students",
  "",
  "S.NO.,ROLL NO,ROLL NO/REGISTER NO.,STUDENT NAME,ENROLLED DEPARTMENT,ENROLLED PROGRAM,YEAR OF ADMISSION",
  "1,101,20250001,Ama Serwaa,Computer Science,BSc CS,2025",
  "2,102,20250002,Kofi Boateng,Computer Science,BSc CS,2025",
  "3,103,20250003,Yaa Owusu,Information Systems,BSc IS,2025",
].join("\r\n");

const camu = tableFromCsv(CAMU);
const camuMap = autoMap(camu.rows);

eq("the header row is found below the preamble", camuMap.headerRow, 5);

ok(
  "the ID column is ROLL NO/REGISTER NO., not ROLL NO",
  camuMap.studentId === 2,
  `picked column ${camuMap.studentId} (${camu.rows[5][camuMap.studentId]})`,
);

eq("the name column is STUDENT NAME", camuMap.name, 3);

const camuRows = applyMapping(camu, camuMap);

eq("every data row is mapped", camuRows.rows, [
  { student_id: "20250001", name: "Ama Serwaa" },
  { student_id: "20250002", name: "Kofi Boateng" },
  { student_id: "20250003", name: "Yaa Owusu" },
]);

eq("nothing is skipped from a clean file", camuRows.skipped, []);

eq("the preamble is kept", camu.preamble.length > 0, true);
eq("the course code is read out of it", courseCodeIn(camu.preamble), "CS254");

// ---------------------------------------------------------------------------
// S.NO. must never be taken for an ID
//
// It is 1, 2, 3… — enough like an identifier for any value-shape heuristic to
// choose it, and enrolling a class as students "1" through "40" is the worst
// thing this feature could do.
// ---------------------------------------------------------------------------

const SERIAL_ONLY = [
  "S.NO.,STUDENT NAME,ENROLLED PROGRAM",
  "1,Ama Serwaa,BSc CS",
  "2,Kofi Boateng,BSc CS",
].join("\n");

const serial = tableFromCsv(SERIAL_ONLY);
const serialMap = autoMap(serial.rows);

ok(
  "a serial column is never chosen as the ID",
  serialMap.studentId !== 0,
  `chose column 0 (${serial.rows[0][0]})`,
);

// ---------------------------------------------------------------------------
// A PDF of several pages repeats its column titles
// ---------------------------------------------------------------------------

const REPEATED = [
  "ROLL NO/REGISTER NO.,STUDENT NAME",
  "20250001,Ama Serwaa",
  "ROLL NO/REGISTER NO.,STUDENT NAME",
  "20250002,Kofi Boateng",
].join("\n");

const repeated = tableFromCsv(REPEATED);
const repeatedRows = applyMapping(repeated, autoMap(repeated.rows));

eq("a repeated header is not enrolled as a student", repeatedRows.rows, [
  { student_id: "20250001", name: "Ama Serwaa" },
  { student_id: "20250002", name: "Kofi Boateng" },
]);

eq(
  "and it is reported rather than dropped quietly",
  repeatedRows.skipped.map((s) => s.reason),
  ["repeated column titles"],
);

// ---------------------------------------------------------------------------
// Rows without an ID are accounted for
// ---------------------------------------------------------------------------

const GAPPY = [
  "ROLL NO/REGISTER NO.,STUDENT NAME",
  "20250001,Ama Serwaa",
  ",Missing An ID",
  "",
  "20250003,Yaa Owusu",
].join("\n");

const gappy = tableFromCsv(GAPPY);
const gappyRows = applyMapping(gappy, autoMap(gappy.rows));

eq("rows with no ID are excluded", gappyRows.rows.length, 2);
eq("and reported with their line number", gappyRows.skipped.map((s) => s.row), [3]);

// ---------------------------------------------------------------------------
// Duplicates are NOT removed here
//
// The server reports them with row numbers. Doing it in both places is how the
// two drift apart, which is the bug this project already fixed once for
// attendance percentage.
// ---------------------------------------------------------------------------

const DUPES = [
  "ROLL NO/REGISTER NO.,STUDENT NAME",
  "20250001,Ama Serwaa",
  "20250001,Ama Serwaa Again",
].join("\n");

const dupes = tableFromCsv(DUPES);
eq(
  "duplicates are left for the server to report",
  applyMapping(dupes, autoMap(dupes.rows)).rows.length,
  2,
);

// ---------------------------------------------------------------------------
// Spreadsheet realities: BOM, CRLF, a quoted comma in a name
// ---------------------------------------------------------------------------

const EXCEL =
  "﻿" +
  ['ROLL NO/REGISTER NO.,STUDENT NAME', '20250001,"Owusu, Ama"'].join("\r\n");

const excel = tableFromCsv(EXCEL);
eq("BOM, CRLF and a quoted comma survive", applyMapping(excel, autoMap(excel.rows)).rows, [
  { student_id: "20250001", name: "Owusu, Ama" },
]);

// ---------------------------------------------------------------------------
// No recognisable header: refuse to guess
//
// There is a person looking at the screen who can say which column it is. A
// wrong guess here is invisible and expensive.
// ---------------------------------------------------------------------------

const HEADERLESS = ["20250001,Ama Serwaa", "20250002,Kofi Boateng"].join("\n");
const headerless = tableFromCsv(HEADERLESS);
const headerlessMap = autoMap(headerless.rows);

eq("no header row is claimed", headerlessMap.headerRow, null);
eq("and no ID column is guessed", headerlessMap.studentId, null);
eq(
  "so nothing is uploaded until somebody says which column",
  applyMapping(headerless, headerlessMap).rows,
  [],
);

// ---------------------------------------------------------------------------
// Course-code comparison, which catches the right file in the wrong class
// ---------------------------------------------------------------------------

ok("CS 254 matches CS254", codesMatch("CS 254", "CS254"));
ok("cs254 matches CS254", codesMatch("cs254", "CS254"));
ok("CS254 does not match CS255", !codesMatch("CS254", "CS255"));
ok("a missing code is not a disagreement", codesMatch(null, "CS254"));

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PDF layout reconstruction
//
// A PDF has no table -- only glyphs at coordinates. These fixtures are the
// CAMU layout expressed as positions, including the thing that actually breaks
// naive extraction: the header wraps three deep. "ROLL NO/REGISTER NO." is
// three runs on three lines, and treating each visual line as a table row
// would put "NO." in a row of its own and hide the header completely.
//
// Coordinates are invented. So is everybody in them.
// ---------------------------------------------------------------------------

const COL = [20, 70, 140, 230, 340, 430, 520];
const at = (text, col, y, height = 10) => ({
  text,
  x: COL[col],
  y,
  width: text.length * 5,
  height,
});

const CAMU_PDF = [
  at("2025-2026 | Computer Science | Semester 3 | Introduction to AI | CS254", 0, 20),
  at("Enrolled Students", 0, 50),

  // Header, wrapped exactly as it renders
  at("S.NO.", 0, 100), at("ROLL NO", 1, 100), at("ROLL", 2, 100),
  at("STUDENT NAME", 3, 100), at("ENROLLED", 4, 100),
  at("ENROLLED", 5, 100), at("YEAR OF", 6, 100),

  at("NO./REGISTER", 2, 112), at("DEPARTME", 4, 112),
  at("PROGRAM", 5, 112), at("ADMISSION", 6, 112),

  at("NO.", 2, 124), at("NT", 4, 124),

  // Data
  at("1", 0, 145), at("101", 1, 145), at("20250001", 2, 145),
  at("Ama Serwaa", 3, 145), at("Computer Science", 4, 145),
  at("BSc CS", 5, 145), at("2025", 6, 145),

  // A name that wraps, with no serial number beside the continuation
  at("2", 0, 165), at("102", 1, 165), at("20250002", 2, 165),
  at("Kwabena", 3, 165), at("Information Systems", 4, 165),
  at("BSc IS", 5, 165), at("2025", 6, 165),
  at("Osei-Bonsu", 3, 177),
];

eq("every column is found", detectColumns(CAMU_PDF).length, 7);

const grid = buildGrid(CAMU_PDF);
const pdfHeaderRow = findHeaderRow(grid);

ok(
  "the wrapped header is one row, not three",
  pdfHeaderRow !== null,
  `findHeaderRow returned null; grid was ${JSON.stringify(grid)}`,
);

if (pdfHeaderRow !== null) {
  eq("and its cells are rejoined", grid[pdfHeaderRow][2], "ROLL NO./REGISTER NO.");
}

const pdfMap = autoMap(grid);
ok(
  "so the register-number column is still the one chosen",
  pdfMap.studentId === 2,
  `picked column ${pdfMap.studentId}`,
);

const pdfRows = applyMapping(
  { kind: "pdf", rows: grid, preamble: [], pageCount: 1 },
  pdfMap,
);

eq("a name wrapped onto a second line is rejoined", pdfRows.rows, [
  { student_id: "20250001", name: "Ama Serwaa" },
  { student_id: "20250002", name: "Kwabena Osei-Bonsu" },
]);

// A run split mid-cell, which PDFs do at every font or kerning change.
const SPLIT = [
  at("ROLL NO/REGISTER NO.", 0, 100), at("STUDENT NAME", 1, 100),
  at("20250003", 0, 120), at("Yaa", 1, 120),
  { text: "Owusu", x: COL[1] + 22, y: 120, width: 25, height: 10 },
];

eq("runs split mid-cell are joined with a space", buildGrid(SPLIT)[1][1], "Yaa Owusu");

// Grouped by vertical centre, so a bigger font beside a smaller one on the
// same line does not split it.
const MIXED = [
  { text: "Big", x: 20, y: 100, width: 30, height: 16 },
  { text: "small", x: 90, y: 103, width: 30, height: 10 },
  { text: "next row", x: 20, y: 140, width: 40, height: 10 },
];
eq("mixed font sizes on one line stay on one line", groupIntoLines(MIXED).length, 2);


// ---------------------------------------------------------------------------
// A roster that is not a CAMU report
//
// Unfamiliar column titles, or none at all, with the document's own headings
// sitting above the table. Nothing distinguishes "Faculty of Science" from a
// student except that it does not look like a roster row -- and the server
// enforces no format on an ID, so an upload of it would succeed silently.
// ---------------------------------------------------------------------------

const UNFAMILIAR = tableFromCsv(
  [
    "Faculty of Science",
    "Class list, Semester 3",
    "Matric,Student,Programme",
    "20250001,Ama Serwaa,BSc CS",
    "20250002,Kofi Boateng,BSc CS",
  ].join("\n"),
);

const unfamiliarMap = autoMap(UNFAMILIAR.rows);

eq("unrecognised titles are not guessed at", unfamiliarMap.studentId, null);
eq(
  "but the data is found below the headings and the untitled header",
  unfamiliarMap.firstDataRow,
  3,
);

eq(
  "so picking the column by hand uploads students only",
  applyMapping(UNFAMILIAR, { ...unfamiliarMap, studentId: 0, name: 1 }).rows,
  [
    { student_id: "20250001", name: "Ama Serwaa" },
    { student_id: "20250002", name: "Kofi Boateng" },
  ],
);

const NO_TITLES = tableFromCsv(
  [
    "Faculty of Science",
    "Class list, Semester 3",
    "20250001,Ama Serwaa",
    "20250002,Kofi Boateng",
  ].join("\n"),
);

const noTitlesMap = autoMap(NO_TITLES.rows);
eq("with no titles at all the data still starts in the right place", noTitlesMap.firstDataRow, 2);
eq(
  "and the headings are not enrolled as students",
  applyMapping(NO_TITLES, { ...noTitlesMap, studentId: 0, name: 1 }).rows,
  [
    { student_id: "20250001", name: "Ama Serwaa" },
    { student_id: "20250002", name: "Kofi Boateng" },
  ],
);

// A stray year on its own line must not be mistaken for the start of the table.
const STRAY = tableFromCsv(
  ["2025-2026", "20250001,Ama Serwaa", "20250002,Kofi Boateng"].join("\n"),
);
eq("a one-cell line containing digits is not the first data row", autoMap(STRAY.rows).firstDataRow, 1);

// Where titles ARE recognised, the row after them is still the answer.
eq("a recognised header still decides where data starts", camuMap.firstDataRow, 6);


console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
