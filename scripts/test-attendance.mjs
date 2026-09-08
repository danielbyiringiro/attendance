// Assertions for the shared attendance read.
//
// Run with `npm run test:attendance`. It bundles src/lib/api/attendance.ts with
// @/lib/supabase aliased to the fixture stub, so nothing here touches a
// database. Six screens read through attendanceLog; if it is wrong they are all
// wrong the same way, which is exactly why it is worth pinning down.

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
// Bundle the real module against the stub
// ---------------------------------------------------------------------------

const out = join(mkdtempSync(join(tmpdir(), "att-")), "attendance.mjs");

const stubUrl = pathToFileURL(join(root, "scripts/stub-supabase.mjs")).href;

await build({
  entryPoints: [join(root, "src/lib/api/attendance.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "warning",
  plugins: [
    {
      // Resolved to the stub AND left external, so the bundle imports the very
      // same module instance the test writes fixtures into. Aliasing alone
      // inlines a second copy, whose tables are always empty.
      name: "stub-supabase",
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({
          path: stubUrl,
          external: true,
        }));
      },
    },
  ],
});

const mod = await import(pathToFileURL(out).href);
const stub = await import(stubUrl);

const { attendanceLog, isPresentState, isAbsentState, isGradedState, stateLabel } = mod;

// ---------------------------------------------------------------------------
// Fixture: one class, two cohorts, four sessions, one of them cancelled and one
// still scheduled. Three students, one of whom is in cohort B.
// ---------------------------------------------------------------------------

const CLASS = "class-1";

const sessions = [
  { id: "s1", class_id: CLASS, cohort_id: "coh-a", session_date: "2026-05-19", starts_at: "2026-05-19T09:00:00Z", status: "closed",    cancellation_reason: null },
  { id: "s2", class_id: CLASS, cohort_id: "coh-a", session_date: "2026-05-20", starts_at: "2026-05-20T09:00:00Z", status: "cancelled", cancellation_reason: "Public holiday" },
  { id: "s3", class_id: CLASS, cohort_id: "coh-b", session_date: "2026-05-19", starts_at: "2026-05-19T14:00:00Z", status: "closed",    cancellation_reason: null },
  { id: "s4", class_id: CLASS, cohort_id: "coh-a", session_date: "2026-12-01", starts_at: "2026-12-01T09:00:00Z", status: "scheduled", cancellation_reason: null },
  // A different class entirely. Nothing below should ever see it.
  { id: "x1", class_id: "class-2", cohort_id: "coh-z", session_date: "2026-05-19", starts_at: "2026-05-19T09:00:00Z", status: "closed", cancellation_reason: null },
];

const records = [
  { session_id: "s1", class_id: CLASS, student_id: "stu-1", state: "present",   marked_at: "2026-05-19T09:03:00Z" },
  { session_id: "s1", class_id: CLASS, student_id: "stu-2", state: "unexcused", marked_at: null },
  { session_id: "s1", class_id: CLASS, student_id: "stu-3", state: "excused",   marked_at: null },
  { session_id: "s3", class_id: CLASS, student_id: "stu-4", state: "late",      marked_at: "2026-05-19T14:12:00Z" },
  // Written before the session was cancelled; cancel_session keeps these.
  { session_id: "s2", class_id: CLASS, student_id: "stu-1", state: "present",   marked_at: "2026-05-20T09:01:00Z" },
  // A scheduled session must never contribute a mark.
  { session_id: "s4", class_id: CLASS, student_id: "stu-1", state: "pending",   marked_at: null },
  { session_id: "x1", class_id: "class-2", student_id: "stu-1", state: "unexcused", marked_at: null },
];

stub.__setTables({
  class_sessions: sessions,
  attendance_records: records,
  cohorts: [
    { id: "coh-a", class_id: CLASS, label: "A" },
    { id: "coh-b", class_id: CLASS, label: "B" },
    { id: "coh-z", class_id: "class-2", label: "Z" },
  ],
});

// ---------------------------------------------------------------------------

console.log("\nattendanceLog");

const log = await attendanceLog(CLASS);

eq(
  "only this class's sessions, and no scheduled ones",
  log.sessions.map((s) => s.session_id).sort(),
  ["s1", "s2", "s3"],
);

ok(
  "a cancelled session is kept and labelled",
  log.sessions.some(
    (s) => s.session_id === "s2" && s.status === "cancelled" &&
           s.cancellation_reason === "Public holiday",
  ),
);

eq("cohort labels are resolved", log.sessionById.get("s3").cohort_label, "B");

eq(
  "marks exclude the other class and the scheduled session",
  log.marks.map((m) => `${m.session_id}:${m.student_id}`).sort(),
  ["s1:stu-1", "s1:stu-2", "s1:stu-3", "s2:stu-1", "s3:stu-4"],
);

eq(
  "a mark carries the session's date and cohort, not the browser's guess",
  log.byStudent.get("stu-4").map((m) => [m.session_date, m.cohort_label]),
  [["2026-05-19", "B"]],
);

eq("byDate groups across cohorts", log.byDate.get("2026-05-19").length, 4);

// ---------------------------------------------------------------------------

console.log("\nfiltering");

const cohortA = await attendanceLog(CLASS, { cohortId: "coh-a" });
ok(
  "cohortId filters sessions and marks together",
  cohortA.sessions.every((s) => s.cohort_label === "A") &&
    cohortA.marks.every((m) => m.cohort_label === "A"),
);
ok(
  "the other cohort's mark is gone",
  !cohortA.marks.some((m) => m.student_id === "stu-4"),
);

const window = await attendanceLog(CLASS, { from: "2026-05-20", to: "2026-05-20" });
eq(
  "a date range filters on the stored session_date",
  window.sessions.map((s) => s.session_id),
  ["s2"],
);
eq("and its marks come with it", window.marks.map((m) => m.session_id), ["s2"]);

// ---------------------------------------------------------------------------

console.log("\npagination");

const many = [];
for (let i = 0; i < 1500; i += 1) {
  many.push({
    session_id: "s1",
    class_id: CLASS,
    student_id: `bulk-${i}`,
    state: "unexcused",
    marked_at: null,
  });
}
stub.__setTables({
  class_sessions: sessions,
  attendance_records: many,
  cohorts: [{ id: "coh-a", class_id: CLASS, label: "A" }],
});
stub.__requests.length = 0;

const big = await attendanceLog(CLASS);
eq("reads past the 1000-row PostgREST cap", big.marks.length, 1500);
ok(
  "by asking for more than one page",
  stub.__requests.filter((r) => r.table === "attendance_records").length >= 2,
);

// ---------------------------------------------------------------------------

console.log("\nstate predicates");

eq("late counts as present",            [isPresentState("present"), isPresentState("late")], [true, true]);
eq("excused is not present",            isPresentState("excused"), false);
eq("only unexcused counts against",     [isAbsentState("unexcused"), isAbsentState("excused")], [true, false]);
eq("exempted leaves the denominator",   isGradedState("exempted"), false);
eq("excused leaves the denominator",    isGradedState("excused"), false);
eq("unexcused is in the denominator",   isGradedState("unexcused"), true);
eq("labels are the words screens show", [stateLabel("unexcused"), stateLabel("late"), stateLabel(null)], ["Absent", "Late", "No record"]);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
