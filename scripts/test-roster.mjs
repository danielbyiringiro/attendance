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

console.log(`\n${checks} checks, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
