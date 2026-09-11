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

const {
  attendanceLog,
  isPresentState,
  isAbsentState,
  isGradedState,
  stateLabel,
  tallyStates,
  sessionStatesFor,
} = mod;

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

console.log("\ntallyStates — the one definition of a rate");

eq("present and late are attendance", tallyStates(["present", "late"]).rate, 100);
eq("unexcused is the denominator only", tallyStates(["present", "unexcused"]).rate, 50);
eq("excused leaves both sides", tallyStates(["present", "excused"]).rate, 100);
eq("exempted leaves both sides", tallyStates(["present", "exempted"]).rate, 100);

// The disagreement this function exists to end. StudentRoster counted MARKS,
// so a session with no record was invisible to it; the exporter counted
// SESSIONS and looked the state up, so the same session landed in its
// denominator contributing nothing and read as an absence. A session has no
// record while it is still open — so exporting mid-class charged everyone who
// had not scanned yet with an absence for a class still running.
eq(
  "a session with no record yet does not count against anybody",
  tallyStates(["present", null]).rate,
  100,
);
eq(
  "and is reported as pending, not absent",
  [tallyStates(["present", null]).pending, tallyStates(["present", null]).absent],
  [1, 0],
);

eq(
  "mergeExcused puts an excused day back on both sides",
  tallyStates(["present", "excused"], { mergeExcused: true }).rate,
  100,
);
eq(
  "and it lifts a rate that excusal alone does not",
  [
    tallyStates(["unexcused", "excused"]).rate,
    tallyStates(["unexcused", "excused"], { mergeExcused: true }).rate,
  ],
  [0, 50],
);
eq("nothing graded is 0, not NaN", tallyStates(["excused", null]).rate, 0);

// ---------------------------------------------------------------------------

console.log("\nsessionStatesFor");

stub.__setTables({
  class_sessions: sessions,
  attendance_records: records,
  cohorts: [
    { id: "coh-a", class_id: CLASS, label: "A" },
    { id: "coh-b", class_id: CLASS, label: "B" },
    { id: "coh-z", class_id: "class-2", label: "Z" },
  ],
});
const forRate = await attendanceLog(CLASS);

// s1 closed, s2 cancelled (dropped), s4 scheduled (never in the log).
eq(
  "one entry per session the cohort held, cancelled ones dropped",
  sessionStatesFor(forRate, "stu-1", "coh-a"),
  ["present"],
);
eq(
  "the state comes from the record when there is one",
  sessionStatesFor(forRate, "stu-2", "coh-a"),
  ["unexcused"],
);
eq(
  "somebody who marked nothing is null, not an empty list",
  sessionStatesFor(forRate, "never-marked", "coh-a"),
  [null],
);
eq(
  "and that null does not become an absence",
  tallyStates(sessionStatesFor(forRate, "never-marked", "coh-a")).absent,
  0,
);


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The check-in window
//
// sessionWindow restates migration 028's rule in TypeScript so the dashboard
// can count down without refetching. Two implementations of one rule is how
// they drift, so these are 028's OWN worked examples, copied from its header:
//
//   opens  at  max(opened_at, starts_at - early_open_minutes)
//   closes at  max(opened_at, starts_at) + auto_close_minutes
//
// If the database rule changes and this file still passes, the mismatch is
// here.
// ---------------------------------------------------------------------------

const windowOut = join(mkdtempSync(join(tmpdir(), "win-")), "window.mjs");
await build({
  entryPoints: [join(root, "src/lib/sessionWindow.ts")],
  outfile: windowOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { sessionWindow, countdown } = await import(pathToFileURL(windowOut).href);

// A 09:00 class with a 15 minute auto-close and a 10 minute late window.
const CLASS_AT = "2026-09-11T09:00:00Z";
const base = {
  starts_at: CLASS_AT,
  early_open_minutes: 15,
  auto_close_minutes: 15,
  late_window_minutes: 10,
  status: "open",
};
const at = (hhmm) => new Date(`2026-09-11T${hhmm}:00Z`);

// 028: "Opened EARLY, 09:00 class, 15 minute window, opened 08:45"
const early = { ...base, opened_at: "2026-09-11T08:45:00Z" };
eq(
  "opened early — opens at the click, not before",
  sessionWindow(early, at("08:50")).opensAt.toISOString(),
  "2026-09-11T08:45:00.000Z",
);
eq(
  "opened early — the window still counts from the class, not the click",
  sessionWindow(early, at("08:50")).closesAt.toISOString(),
  "2026-09-11T09:15:00.000Z",
);
eq(
  "opened early — a student arriving at 08:50 is on time",
  sessionWindow(early, at("08:50")).phase,
  "live",
);

// 028: "Opened LATE, same class, opened 09:10 — opens 09:10, closes 09:25"
const late = { ...base, opened_at: "2026-09-11T09:10:00Z" };
eq(
  "opened late — a full window from opening",
  sessionWindow(late, at("09:12")).closesAt.toISOString(),
  "2026-09-11T09:25:00.000Z",
);

// 028: "Opened EARLIER than early_open allows, opened 08:00 with early_open 15
//       — opens 08:45, the setting is a permission"
const tooEarly = { ...base, opened_at: "2026-09-11T08:00:00Z" };
eq(
  "opened before the allowance — the allowance wins",
  sessionWindow(tooEarly, at("08:30")).opensAt.toISOString(),
  "2026-09-11T08:45:00.000Z",
);
eq(
  "and before that it is not yet accepting marks",
  sessionWindow(tooEarly, at("08:30")).phase,
  "opens_soon",
);

// The late window, measured from the class starting.
eq(
  "at 09:09 a mark is still on time",
  sessionWindow(early, at("09:09")).phase,
  "live",
);
eq(
  "at 09:11 it is late",
  sessionWindow(early, at("09:11")).phase,
  "live_late",
);

// The bug this was written for: status says open long after the window passed.
const stale = sessionWindow(early, at("11:00"));
eq("a window that has passed reads as expired", stale.phase, "expired");
ok(
  "and is flagged stale, because the row still says 'open'",
  stale.staleOpen === true,
);
ok(
  "a live session is not flagged stale",
  sessionWindow(early, at("09:05")).staleOpen === false,
);

// Never opened: there is no window, only a time from which opening is free.
const unopened = { ...base, opened_at: null, status: "scheduled" };
eq(
  "an unopened session has no window at all",
  sessionWindow(unopened, at("08:00")).opensAt,
  null,
);
eq(
  "it is not live, whatever the clock says",
  sessionWindow(unopened, at("09:05")).phase,
  "not_opened",
);
ok(
  "nothing opens it by itself — early_open is a permission, not a trigger",
  sessionWindow(unopened, at("08:50")).phase === "not_opened",
);

eq(
  "a closed session is done regardless of the clock",
  sessionWindow({ ...early, status: "closed" }, at("09:05")).phase,
  "done",
);
eq(
  "so is a cancelled one",
  sessionWindow({ ...early, status: "cancelled" }, at("09:05")).phase,
  "done",
);

eq("countdown reads in minutes and seconds", countdown(125_000), "2m 05s");
eq("and in hours when it is long", countdown(3_900_000), "1h 05m");
eq("and says now at zero", countdown(0), "now");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
