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
  sessionWasHeld,
  dayStateFor,
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
  // Scheduled, and somebody took the register by hand before opening it.
  { id: "s4", class_id: CLASS, cohort_id: "coh-a", session_date: "2026-12-01", starts_at: "2026-12-01T09:00:00Z", status: "scheduled", cancellation_reason: null },
  // Scheduled and untouched. Must stay out of the log entirely.
  { id: "s5", class_id: CLASS, cohort_id: "coh-a", session_date: "2026-12-08", starts_at: "2026-12-08T09:00:00Z", status: "scheduled", cancellation_reason: null },
  // A day declared off: closed, with every enrolled student exempted.
  { id: "s6", class_id: CLASS, cohort_id: "coh-b", session_date: "2026-05-26", starts_at: "2026-05-26T14:00:00Z", status: "closed",    cancellation_reason: null },
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
  // Taken by hand before the session was opened. This was written to the
  // database and then filtered out of every read, so it existed and could not
  // be seen anywhere in the app.
  { session_id: "s4", class_id: CLASS, student_id: "stu-1", state: "present",   marked_at: "2026-11-30T09:00:00Z" },
  { session_id: "s6", class_id: CLASS, student_id: "stu-5", state: "exempted",  marked_at: null },
  { session_id: "s6", class_id: CLASS, student_id: "stu-6", state: "exempted",  marked_at: null },
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

// This used to assert ["s1", "s2", "s3"] — no scheduled session, ever.
//
// That was half a rule. A class next Tuesday is not a session anybody missed,
// and counting it would turn every future date into an absence. But "not opened
// yet" and "never happened" are different, and the dashboard offers Mark
// manually on a session before it is opened, so a register taken early was
// written and then hidden from every screen that reads it — including the one
// that took it.
//
// s4 is scheduled and marked, so it is in. s5 is scheduled and untouched, so it
// is not.
eq(
  "a scheduled session counts once somebody has marked it",
  log.sessions.map((s) => s.session_id).sort(),
  ["s1", "s2", "s3", "s4", "s6"],
);

ok(
  "and an untouched scheduled session stays out",
  !log.sessions.some((s) => s.session_id === "s5"),
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
  "marks exclude the other class, and include a register taken early",
  log.marks.map((m) => `${m.session_id}:${m.student_id}`).sort(),
  [
    "s1:stu-1",
    "s1:stu-2",
    "s1:stu-3",
    "s2:stu-1",
    "s3:stu-4",
    "s4:stu-1",
    // The declared day off. Its records are real and belong in the log; what
    // they must not do is make the day look like a session nobody attended.
    "s6:stu-5",
    "s6:stu-6",
  ],
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

// s1 closed and present, s2 cancelled (dropped), s4 scheduled but marked
// present by hand, s5 scheduled and untouched (never in the log).
eq(
  "one entry per session the cohort held, cancelled ones dropped",
  sessionStatesFor(forRate, "stu-1", "coh-a"),
  ["present", "present"],
);
// Two entries now, because s4 is in the log: stu-2 has no record against it.
// null, not 'unexcused' — the session has not closed, so nobody has decided
// they were absent. tallyStates counts null in neither half, so taking a
// register early cannot move anybody's rate before the session runs.
eq(
  "the state comes from the record when there is one, and null when there is not",
  sessionStatesFor(forRate, "stu-2", "coh-a"),
  ["unexcused", null],
);
eq(
  "somebody who marked nothing is null, not an empty list",
  sessionStatesFor(forRate, "never-marked", "coh-a"),
  [null, null],
);
eq(
  "and that null does not become an absence",
  tallyStates(sessionStatesFor(forRate, "never-marked", "coh-a")).absent,
  0,
);

// A cohort move rewrites one column of an enrolment and leaves the records
// alone, so stu-4 — marked late on s3, cohort B's session — keeps that mark
// after moving to cohort A. Counted from A's sessions alone it disappeared,
// and their rate was taken over the days since the move.
{
  const moved = sessionStatesFor(forRate, "stu-4", "coh-a");
  eq("a mark from the cohort they left still counts", tallyStates(moved).late, 1);
  eq("so the rate is taken over it", tallyStates(moved).rate, 100);
  eq(
    "their own cohort's sessions are still there too",
    moved.length,
    sessionStatesFor(forRate, "never-marked", "coh-a").length + 1,
  );
  eq(
    "but not the sessions of that cohort they were never marked on",
    sessionStatesFor(forRate, "stu-1", "coh-a"),
    ["present", "present"],
  );
}


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
  duration_minutes: 60,
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

// ---------------------------------------------------------------------------
// 048: check-in that shuts when the class starts
//
// The same rule as session_closes_at, restated here for the same reason as
// everything above it. Off, every number below is identical to 028's.
// ---------------------------------------------------------------------------

const shuts = { ...base, closes_at_start: true, grace_minutes: 5 };

// Opened early: the door shuts as the class starts, not a window later.
const shutsEarly = { ...shuts, opened_at: "2026-09-11T08:45:00Z" };
eq(
  "shuts at the start — opened early, it closes at 09:00",
  sessionWindow(shutsEarly, at("08:50")).closesAt.toISOString(),
  "2026-09-11T09:00:00.000Z",
);
eq(
  "and 08:50 is still on time",
  sessionWindow(shutsEarly, at("08:50")).phase,
  "live",
);
eq(
  "at 09:01 the window has gone",
  sessionWindow(shutsEarly, at("09:01")).phase,
  "expired",
);
eq(
  "late_window_minutes never bites, because the window shuts first",
  sessionWindow(shutsEarly, at("08:59")).phase,
  "live",
);

// Opened in the same instant the class begins: the same branch, deliberately.
eq(
  "opened exactly at the start, it closes at the start",
  sessionWindow(
    { ...shuts, opened_at: CLASS_AT },
    at("09:00"),
  ).closesAt.toISOString(),
  "2026-09-11T09:00:00.000Z",
);

// Opened after: grace measured from the click, or there would be no window.
const shutsLate = { ...shuts, opened_at: "2026-09-11T09:07:00Z" };
eq(
  "opened late — grace runs from the click",
  sessionWindow(shutsLate, at("09:08")).closesAt.toISOString(),
  "2026-09-11T09:12:00.000Z",
);
eq(
  "a mark inside grace is on time by default",
  sessionWindow(shutsLate, at("09:08")).phase,
  "live",
);
eq(
  "and late when the class asks for that",
  sessionWindow({ ...shutsLate, grace_counts_late: true }, at("09:08")).phase,
  "live_late",
);
eq(
  "grace_counts_late does not leak into a session opened before the class",
  sessionWindow({ ...shutsEarly, grace_counts_late: true }, at("08:50")).phase,
  "live",
);

// The sweep's bound, which the card reads to say whether the chance has gone.
const shutsUnopened = { ...shuts, opened_at: null, status: "scheduled" };
eq(
  "unopened — the sweep will not open it once the class has begun",
  sessionWindow(shutsUnopened, at("08:00")).autoOpenUntil.toISOString(),
  "2026-09-11T09:00:00.000Z",
);
eq(
  "whereas an ordinary session can still open itself mid-class (033)",
  sessionWindow(
    { ...base, opened_at: null, status: "scheduled" },
    at("08:00"),
  ).autoOpenUntil.toISOString(),
  "2026-09-11T10:00:00.000Z",
);
ok(
  "and at 09:30 that chance has gone for the one that shuts at the start",
  sessionWindow(shutsUnopened, at("09:30")).autoOpenMissed === true,
);

// Off: every number is 028's, unchanged.
eq(
  "with the setting off nothing moves",
  sessionWindow({ ...early, closes_at_start: false }, at("08:50")).closesAt.toISOString(),
  "2026-09-11T09:15:00.000Z",
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

// The countdown a TA actually watches is the one to the close, not to the next
// phase change. Mid-session the next change is the late threshold, so a badge
// driven by msUntilChange counted down to "late" and then restarted from a
// bigger number — the clock appearing to run backwards.
const midway = sessionWindow(early, at("09:05"));
eq(
  "mid-session, the close is ten minutes off",
  midway.msUntilClose,
  10 * 60 * 1000,
);
eq(
  "while the late threshold is only five",
  midway.msUntilLate,
  5 * 60 * 1000,
);
ok(
  "so the two are not the same number",
  midway.msUntilClose !== midway.msUntilLate,
);

const pastLate = sessionWindow(early, at("09:12"));
eq(
  "once late, the close countdown keeps running",
  pastLate.msUntilClose,
  3 * 60 * 1000,
);
eq("and there is no late threshold left to reach", pastLate.msUntilLate, null);

eq(
  "an expired window has nothing left to count",
  sessionWindow(early, at("11:00")).msUntilClose,
  0,
);
eq(
  "and an unopened one has no close to count to",
  sessionWindow(unopened, at("08:50")).msUntilClose,
  null,
);

// The auto-open span, which is what makes "why did this not open?" answerable.
// Migration 031 opens a session only between starts_at - early_open and
// starts_at + auto_close, and only while its status is still 'scheduled'. That
// is a twenty-minute chance on the defaults, and nothing on screen said so.
const waiting = sessionWindow(unopened, at("08:30"));
eq(
  "the sweep can open it from the early-open moment",
  waiting.autoOpenFrom.toISOString(),
  "2026-09-11T08:45:00.000Z",
);
// Migration 033: to the end of the class, not to the end of the check-in
// window. auto_close is 15 minutes and the class is an hour, and using the
// former meant a lecture already running could no longer open itself — which
// is what "auto-open does not work" turned out to be.
eq(
  "and keeps trying until the class is over",
  waiting.autoOpenUntil.toISOString(),
  "2026-09-11T10:00:00.000Z",
);
ok("not missed while it is still ahead", waiting.autoOpenMissed === false);

ok(
  "not missed during the span either",
  sessionWindow(unopened, at("09:00")).autoOpenMissed === false,
);
ok(
  "a lecture 30 minutes in has NOT missed its chance",
  sessionWindow(unopened, at("09:30")).autoOpenMissed === false,
);
ok(
  "nor one 59 minutes in",
  sessionWindow(unopened, at("09:59")).autoOpenMissed === false,
);
ok(
  "missed once the class is over — only a person can open it now",
  sessionWindow(unopened, at("10:30")).autoOpenMissed === true,
);

eq(
  "an open session has no auto-open span left to speak of",
  sessionWindow(early, at("09:05")).autoOpenFrom,
  null,
);

eq("countdown reads in minutes and seconds", countdown(125_000), "2m 05s");
eq("and in hours when it is long", countdown(3_900_000), "1h 05m");
eq("and says now at zero", countdown(0), "now");


// ---------------------------------------------------------------------------
// dayStateFor — what one student's record says about one day
//
// Analytics answers for a day, and the list beneath it has to answer for the
// same day. The distinctions are the ones migration 004 exists to keep: a day
// the cohort did not meet is not a day anybody missed, and a session nobody has
// marked is not an absence. Getting either wrong turns a Sunday into a room
// full of absentees.
// ---------------------------------------------------------------------------

console.log("\ndayStateFor");

const dayLog = await attendanceLog(CLASS);

eq("present on the day", dayStateFor(dayLog, "stu-1", "A", "2026-05-19"), "present");
eq("an absence is an absence", dayStateFor(dayLog, "stu-2", "A", "2026-05-19"), "absent");
eq("excused is not absent", dayStateFor(dayLog, "stu-3", "A", "2026-05-19"), "excused");
eq("late is its own answer", dayStateFor(dayLog, "stu-4", "B", "2026-05-19"), "late");
eq(
  "somebody the register never mentioned is not marked, which is not an absence",
  dayStateFor(dayLog, "stu-9", "A", "2026-05-19"),
  "unmarked",
);
eq(
  "a day the cohort does not meet at all",
  dayStateFor(dayLog, "stu-1", "A", "2026-05-21"),
  "no-class",
);
eq(
  "the other cohort's day is not this student's day",
  dayStateFor(dayLog, "stu-1", "A", "2026-05-26"),
  "no-class",
);
eq(
  "a cancelled session is no class, not an absence — even with a mark on it",
  dayStateFor(dayLog, "stu-1", "A", "2026-05-20"),
  "no-class",
);
eq(
  "a declared day off reads as exempt for the students it exempted",
  dayStateFor(dayLog, "stu-5", "B", "2026-05-26"),
  "exempt",
);
eq(
  "and as not marked for somebody it never wrote a record for — the log cannot invent one",
  dayStateFor(dayLog, "stu-4", "B", "2026-05-26"),
  "unmarked",
);
eq("no log at all is no class", dayStateFor(null, "stu-1", "A", "2026-05-19"), "no-class");

// ---------------------------------------------------------------------------
// sessionWasHeld — a day declared off is not a session nobody attended
//
// Migration 036 records a holiday by closing the session and marking every
// enrolled student exempted, which keeps the date visible as one that formally
// did not count. Analytics counted "held" as anything not cancelled, so the
// same screen would say the day did not count AND that attendance was zero.
// ---------------------------------------------------------------------------

console.log("\nsessionWasHeld");

const heldLog = await attendanceLog(CLASS);

ok(
  "an ordinary closed session was held",
  sessionWasHeld(heldLog, "s1") === true,
);
ok(
  "a cancelled one was not",
  sessionWasHeld(heldLog, "s2") === false,
);
ok(
  "a whole register of exempted means the day did not happen",
  sessionWasHeld(heldLog, "s6") === false,
);
ok(
  "one exempted student among a normal register changes nothing",
  sessionWasHeld(heldLog, "s1") === true,
);
ok(
  "a session with no records yet is held — it may just not be closed",
  sessionWasHeld(heldLog, "s3") === true,
);
ok(
  "an unknown session id is not held rather than throwing",
  sessionWasHeld(heldLog, "nope") === false,
);


// ---------------------------------------------------------------------------
// monthGrid — the shape behind the month view
//
// Month boundaries are where date code goes wrong, so this is pinned rather
// than eyeballed. The cases are the ones that break a naive implementation: a
// month starting on a Monday (offset zero), one starting on a Sunday (the
// widest case), February in a leap year, and a December that has to roll the
// year forward.
// ---------------------------------------------------------------------------

const gridOut = join(mkdtempSync(join(tmpdir(), "dates-")), "dates.mjs");
await build({
  entryPoints: [join(root, "src/lib/dates.ts")],
  outfile: gridOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { monthGrid, toDateStr } = await import(pathToFileURL(gridOut).href);

console.log("\nmonthGrid");

const iso = (year, month) => monthGrid(year, month).map(toDateStr);

// Always six weeks. A grid that changes height makes the page jump on every
// press of "next".
ok(
  "always 42 days, whatever the month",
  [
    iso(2026, 0),
    iso(2026, 1),
    iso(2026, 10),
    iso(2024, 1),
  ].every((g) => g.length === 42),
);

ok(
  "always starts on a Monday",
  [iso(2026, 0), iso(2026, 5), iso(2026, 10)].every(
    (g) => new Date(`${g[0]}T00:00:00`).getDay() === 1,
  ),
);

// June 2026 begins on a Monday, so there is no leading spill at all.
eq("a month starting on Monday starts there", iso(2026, 5)[0], "2026-06-01");

// November 2026 begins on a Sunday — the widest case, six days of spill.
eq("a month starting on Sunday spills six days", iso(2026, 10)[0], "2026-10-26");

// The whole month has to be inside the grid, or days silently vanish.
const march = iso(2026, 2);
ok(
  "every day of the month is in the grid",
  march.includes("2026-03-01") && march.includes("2026-03-31"),
);

// Leap year, and the day after it.
const feb2024 = iso(2024, 1);
ok("a leap day is present", feb2024.includes("2024-02-29"));

// December has to roll the year.
const dec = iso(2026, 11);
ok(
  "December reaches into January",
  dec.some((d) => d.startsWith("2027-01")),
);

// Consecutive, with no repeats or gaps. This is what a fixed 86400000ms step
// gets wrong either side of a daylight-saving change.
const consecutive = iso(2026, 9);
ok(
  "the 42 days are consecutive and distinct",
  new Set(consecutive).size === 42 &&
    consecutive.every((d, i) => {
      if (i === 0) return true;
      const prev = new Date(`${consecutive[i - 1]}T00:00:00`);
      prev.setDate(prev.getDate() + 1);
      return toDateStr(prev) === d;
    }),
);

// ---------------------------------------------------------------------------
// checkinLink — what the QR carries, and reading it back
//
// The presenter builds the link and the check-in form reads it, in different
// files. These pin that the two ends agree, and that a value from an address bar
// — which anybody can type — cannot put something odd in the PIN field.
// ---------------------------------------------------------------------------

const linkOut = join(mkdtempSync(join(tmpdir(), "link-")), "link.mjs");
await build({
  entryPoints: [join(root, "src/lib/checkinLink.ts")],
  outfile: linkOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const {
  checkinUrl,
  pinFromSearch,
  searchWithoutPin,
  MAX_PIN_LENGTH,
  isUnreachableFromPhone,
} =
  await import(pathToFileURL(linkOut).href);

console.log("\ncheckinLink");

eq(
  "a live code goes into the link",
  checkinUrl("https://attend.test", "K7M2P"),
  "https://attend.test/?pin=K7M2P",
);
eq(
  "a trailing slash on the origin does not double up",
  checkinUrl("https://attend.test/", "K7M2P"),
  "https://attend.test/?pin=K7M2P",
);
eq(
  "no code gives the bare site",
  checkinUrl("https://attend.test", null),
  "https://attend.test/",
);
eq(
  "a blank code gives the bare site, not ?pin=",
  checkinUrl("https://attend.test", "   "),
  "https://attend.test/",
);
eq(
  "characters that mean something in a URL are encoded",
  checkinUrl("https://attend.test", "A&B=C"),
  "https://attend.test/?pin=A%26B%3DC",
);

// The two ends agree: whatever the presenter builds, the form reads back.
for (const code of ["K7M2P", "ZZ9Y8", "A&B=C"]) {
  eq(
    `round trip: ${code}`,
    pinFromSearch(new URL(checkinUrl("https://attend.test", code)).search),
    code,
  );
}

eq("a lower-case code is shown in capitals", pinFromSearch("?pin=k7m2p"), "K7M2P");
eq("no pin parameter is null", pinFromSearch("?other=1"), null);
eq("an empty pin is null, not an empty field", pinFromSearch("?pin="), null);
eq("whitespace inside is refused", pinFromSearch("?pin=K7%20M2P"), null);
eq("a control character is refused", pinFromSearch("?pin=K7%0AM2P"), null);
eq(
  "an absurdly long value is refused",
  pinFromSearch(`?pin=${"A".repeat(MAX_PIN_LENGTH + 1)}`),
  null,
);

eq("tidying keeps other parameters", searchWithoutPin("?a=1&pin=K7M2P&b=2"), "?a=1&b=2");
eq("tidying the only parameter leaves nothing", searchWithoutPin("?pin=K7M2P"), "");
eq("tidying an address without a pin changes nothing", searchWithoutPin("?a=1"), "?a=1");

// A QR built on localhost points a phone at itself. The presenter warns when
// that is the case, so the helper deciding it has to be right both ways.
ok("localhost is unreachable from a phone", isUnreachableFromPhone("localhost"));
ok("so is 127.0.0.1", isUnreachableFromPhone("127.0.0.1"));
ok("and IPv6 loopback", isUnreachableFromPhone("[::1]"));
ok("a network address is reachable", !isUnreachableFromPhone("192.168.1.20"));
ok("and so is the deployed site", !isUnreachableFromPhone("attend.example.app"));

// ---------------------------------------------------------------------------
// classDisplay — what a signed-out screen shows, and how its code is compared
//
// A screen left up all day has to move from one session to the next without
// anybody touching it, so which session it picks is the whole behaviour. And
// the code normalisation has a twin in get_class_display (041): if the two
// disagree, a correctly typed code is refused and nothing on screen says why.
// ---------------------------------------------------------------------------

const displayOut = join(mkdtempSync(join(tmpdir(), "display-")), "display.mjs");
await build({
  entryPoints: [join(root, "src/lib/classDisplay.ts")],
  outfile: displayOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { pickDisplay, normalizeDisplayCode, displayUrl } = await import(
  pathToFileURL(displayOut).href
);

console.log("\nclassDisplay");

{
  const base = {
    opened_at: null,
    closed_at: null,
    early_open_minutes: 10,
    auto_close_minutes: 30,
    late_window_minutes: 15,
    duration_minutes: 60,
    status: "scheduled",
    pin: null,
  };
  const at = (id, cohort, startsAt, extra = {}) => ({
    ...base,
    id,
    cohort_label: cohort,
    starts_at: startsAt,
    ...extra,
  });
  const now = new Date("2026-09-14T09:05:00Z");

  // 09:00, opened 08:55: on time until 09:15, open until 09:30.
  const liveA = at("a", "A", "2026-09-14T09:00:00Z", {
    status: "open",
    opened_at: "2026-09-14T08:55:00Z",
    pin: "K7M2P",
  });
  // 09:02, opened 08:58: also running at 09:05.
  const liveB = at("b", "B", "2026-09-14T09:02:00Z", {
    status: "open",
    opened_at: "2026-09-14T08:58:00Z",
    pin: "Q4P9R",
  });
  const elevenC = at("c", "C", "2026-09-14T11:00:00Z");
  const twoD = at("d", "D", "2026-09-14T14:00:00Z");

  eq(
    "a running session holds the screen over later ones",
    pickDisplay([twoD, liveA, elevenC], now),
    { kind: "active", sessions: [liveA] },
  );
  eq(
    "two cohorts checking in at once are both shown, earliest first",
    pickDisplay([liveB, liveA], now).sessions.map((s) => s.id),
    ["a", "b"],
  );

  // Opened at 09:00 for a 10:00 class that may open 10 minutes early: the
  // window is not accepting marks until 09:50, but the code is already minted.
  const opensSoon = at("s", "A", "2026-09-14T10:00:00Z", {
    status: "open",
    opened_at: "2026-09-14T09:00:00Z",
    pin: "SOON7",
  });
  eq("opened and about to accept marks counts as running", pickDisplay([opensSoon], now).kind, "active");

  // Still says open, but its window shut at 07:30. The sweep just has not got
  // to it; the room needs the next class, not a dead code.
  const staleOpen = at("x", "A", "2026-09-14T07:00:00Z", {
    status: "open",
    opened_at: "2026-09-14T07:00:00Z",
    pin: "OLD12",
  });
  const staleThenNext = pickDisplay([twoD, staleOpen, elevenC], now);
  eq("an open session past its window does not hold the screen", staleThenNext.kind, "upcoming");
  eq("the screen counts down to the soonest session instead", staleThenNext.session?.id, "c");

  // Started 08:30 and never opened; the class runs until 09:30, so the sweep
  // will still open it.
  const inProgress = at("p", "A", "2026-09-14T08:30:00Z");
  eq("a class in progress the sweep can still open is shown", pickDisplay([inProgress, twoD], now).session?.id, "p");

  // Ran 07:00 to 08:00 and was never opened. Nothing will open it now.
  const missed = at("m", "A", "2026-09-14T07:00:00Z");
  eq("a session nothing will open any more is not counted down to", pickDisplay([missed], now), { kind: "idle" });
  eq("no sessions is idle", pickDisplay([], now), { kind: "idle" });
}

eq("case, spaces and dashes in a typed code are ignored", normalizeDisplayCode(" k7m-2pq "), "K7M2PQ");
// Uppercasing first turns ß into SS, which then survives the strip. The
// database strips first, so the two would disagree about this input.
eq("the code is stripped before it is uppercased, as the database does", normalizeDisplayCode("ßk7m2p"), "K7M2P");

eq("the display link", displayUrl("https://attend.test/", "ab12cd"), "https://attend.test/display/ab12cd");

// ---------------------------------------------------------------------------
// rosterForSession — a student added after a session is still on its register
//
// The register filtered enrolled_on <= session_date, and a roster uploaded
// mid-term sets enrolled_on to the upload day, so every past session had
// nobody on it who could be marked (migration 042). Dropped students still go.
// ---------------------------------------------------------------------------

console.log("\nrosterForSession");

stub.__setTables({
  class_sessions: [
    { id: "past", class_id: "c42", cohort_id: "k42", session_date: "2026-09-07" },
  ],
  enrolments: [
    { cohort_id: "k42", student_id: "early", enrolled_on: "2026-08-01", dropped_on: null },
    // Added a week after the session, as a mid-term roster upload is.
    { cohort_id: "k42", student_id: "late", enrolled_on: "2026-09-14", dropped_on: null },
    { cohort_id: "k42", student_id: "gone", enrolled_on: "2026-08-01", dropped_on: "2026-09-01" },
    { cohort_id: "other", student_id: "elsewhere", enrolled_on: "2026-08-01", dropped_on: null },
  ],
  students: [
    { student_id: "early", name: "Early" },
    { student_id: "late", name: "Late" },
    { student_id: "gone", name: "Gone" },
    { student_id: "elsewhere", name: "Elsewhere" },
  ],
  attendance_records: [
    { session_id: "past", student_id: "early", state: "present", marked_at: "2026-09-07T09:01:00Z", marked_by_role: "student" },
  ],
});

{
  const roster = await mod.rosterForSession("past");
  eq(
    "a student added after the session is still on its register",
    roster.map((a) => a.student_id),
    ["early", "late"],
  );
  const late = roster.find((a) => a.student_id === "late");
  eq("and carries the day they were added, so the register can say so", late?.enrolled_on, "2026-09-14");
  eq("with nothing recorded, so they are there to be marked", late?.state, null);
}

// ---------------------------------------------------------------------------
// weeklyAbsence — who the Weekly Absences report lists
//
// The threshold was a literal 2 in three places in the dashboard. It is a class
// setting now (migration 043), applied here, so a 3 has to exclude a student
// absent twice and a 1 has to include everybody absent at all.
// ---------------------------------------------------------------------------

const weeklyOut = join(mkdtempSync(join(tmpdir(), "weekly-")), "weekly.mjs");
await build({
  entryPoints: [join(root, "src/lib/weeklyAbsence.ts")],
  outfile: weeklyOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { reportableAbsences, thresholdPhrase, DEFAULT_WEEKLY_ABSENCE_THRESHOLD } =
  await import(pathToFileURL(weeklyOut).href);

console.log("\nweeklyAbsence");

{
  const week = [
    { student_id: "once", cohort: "A", frequency: 1 },
    { student_id: "twice", cohort: "A", frequency: 2 },
    { student_id: "thrice", cohort: "B", frequency: 3 },
  ];
  const ids = (rows) => rows.map((a) => a.student_id);

  eq("the default is still 2, what the report always used", DEFAULT_WEEKLY_ABSENCE_THRESHOLD, 2);
  eq("at 2, a single absence is left out", ids(reportableAbsences(week, 2, "all")), ["twice", "thrice"]);
  eq("at 3, twice is no longer enough", ids(reportableAbsences(week, 3, "all")), ["thrice"]);
  eq("at 1, every absence is reported", ids(reportableAbsences(week, 1, "all")), ["once", "twice", "thrice"]);
  eq("the cohort filter still applies", ids(reportableAbsences(week, 1, "A")), ["once", "twice"]);
  eq("the message says the number that was used", thresholdPhrase(3), "3 times or more");
  eq("and reads naturally for the default", thresholdPhrase(2), "twice or more");
}

// ---------------------------------------------------------------------------
// checkInSound — when the check-in beep plays
//
// The beep is only worth having if it means "a student just checked in". A TA's
// mark, an absence written at close, or a later edit to a check-in must not
// beep; a check-in over an existing absence must (migration 044 stores it as
// the student's). The display link has no realtime, so it compares counts
// between polls — and must not beep for what was already there when it looked.
// ---------------------------------------------------------------------------

const soundOut = join(mkdtempSync(join(tmpdir(), "sound-")), "sound.mjs");
await build({
  entryPoints: [join(root, "src/lib/checkInSound.ts")],
  outfile: soundOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { isStudentCheckIn, newCheckIns, checkInCounts } = await import(
  pathToFileURL(soundOut).href
);

console.log("\ncheckInSound");

{
  const row = (marked_by_role, state) => ({ session_id: "s1", marked_by_role, state });

  ok("a student checking in beeps", isStudentCheckIn({ eventType: "INSERT", new: row("student", "present"), old: {} }));
  ok("so does checking in late", isStudentCheckIn({ eventType: "INSERT", new: row("student", "late"), old: {} }));
  ok("a TA marking somebody present does not", !isStudentCheckIn({ eventType: "INSERT", new: row("staff", "present"), old: {} }));
  ok("an absence written at close does not", !isStudentCheckIn({ eventType: "INSERT", new: row("system", "unexcused"), old: {} }));
  ok(
    "a check-in over an existing absence beeps",
    isStudentCheckIn({ eventType: "UPDATE", new: row("student", "present"), old: row("system", "unexcused") }),
  );
  ok(
    "a later edit to a check-in does not beep again",
    !isStudentCheckIn({ eventType: "UPDATE", new: row("student", "late"), old: row("student", "present") }),
  );
  ok("a deletion does not", !isStudentCheckIn({ eventType: "DELETE", new: {}, old: row("student", "present") }));

  const before = checkInCounts([{ id: "a", checked_in: 2 }, { id: "b", checked_in: 0 }]);
  eq("nothing beeps on the first look", newCheckIns(null, [{ id: "a", checked_in: 9 }]), 0);
  eq(
    "new check-ins across sessions add up",
    newCheckIns(before, [{ id: "a", checked_in: 5 }, { id: "b", checked_in: 1 }]),
    4,
  );
  eq("a session that just appeared does not beep for what it already has", newCheckIns(before, [{ id: "c", checked_in: 7 }]), 0);
  eq("a count that went down is not a check-in", newCheckIns(before, [{ id: "a", checked_in: 1 }]), 0);
}

// ---------------------------------------------------------------------------
// studentTotals — one count for a student, whichever tab opened them
//
// The Students tab and the attendance tab both open the student dialog, and it
// heads with these numbers. They were computed inline in StudentRoster; moved
// here so the attendance tab cannot grow its own slightly different count.
// Uses the attendanceLog fixture built at the top of this file.
// ---------------------------------------------------------------------------

console.log("\nstudentTotals");

{
  const { studentTotals } = mod;
  const zeros = { sessions: 0, present: 0, late: 0, excused: 0, absent: 0, rate: 0 };
  const t = tallyStates(sessionStatesFor(log, "stu-1", "coh-a"));

  eq(
    "the totals are exactly what the Students tab counted inline",
    studentTotals(log, "stu-1", "coh-a"),
    {
      sessions: t.sessions,
      present: t.present,
      late: t.late,
      excused: t.excused,
      absent: t.absent,
      rate: t.rate,
    },
  );
  ok("and are real for a student with marks", studentTotals(log, "stu-1", "coh-a").sessions > 0);
  eq("before the log has loaded, every total is zero", studentTotals(null, "stu-1", "coh-a"), zeros);
  eq("a cohort that cannot be resolved counts nothing", studentTotals(log, "stu-1", undefined), zeros);
}

// ---------------------------------------------------------------------------
// attendanceCalendar — what colour a day is on a student's calendar
//
// The record dialog and the student history page both show one student's
// sessions as a month. The colour is the whole message, so which state maps to
// which tone, and which tone wins on a day with several sessions, are pinned.
// ---------------------------------------------------------------------------

const calOut = join(mkdtempSync(join(tmpdir(), "cal-")), "cal.mjs");
await build({
  entryPoints: [join(root, "src/lib/attendanceCalendar.ts")],
  outfile: calOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { toneOf, dayTone, entriesByDate, latestMonth } = await import(
  pathToFileURL(calOut).href
);

console.log("\nattendanceCalendar");

eq("an unexcused mark shows as absent", toneOf("unexcused"), "absent");
eq("present stays present", toneOf("present"), "present");
eq("late stays late", toneOf("late"), "late");
eq("no record yet is not closed", toneOf(null), "pending");
eq("a cancelled class is no class, whatever is stored", toneOf("present", true), "cancelled");

eq("an absence in one class outweighs a check-in in another", dayTone(["present", "absent"]), "absent");
eq("late outweighs present", dayTone(["present", "late"]), "late");
eq("a real mark outweighs one not closed yet", dayTone(["pending", "present"]), "present");
eq("a real mark outweighs a cancelled class", dayTone(["cancelled", "present"]), "present");
eq("a day with nothing has no tone", dayTone([]), null);

eq(
  "entries are grouped by their date",
  [...entriesByDate([
    { date: "2026-09-14", tone: "present" },
    { date: "2026-09-15", tone: "absent" },
    { date: "2026-09-14", tone: "late" },
  ]).entries()].map(([d, es]) => [d, es.length]),
  [["2026-09-14", 2], ["2026-09-15", 1]],
);

eq(
  "the calendar opens on the latest month with a session, not today's",
  latestMonth(["2026-05-19", "2026-09-14", "2026-07-01"]),
  { year: 2026, month: 8 },
);
eq("with no sessions it opens on the fallback month", latestMonth([], new Date(2026, 0, 15)), { year: 2026, month: 0 });

// Days off on a student's own history (migration 045).
{
  const { historyEntries } = await import(pathToFileURL(calOut).href);

  eq("a day off outranks the exemption it caused", dayTone(["exempted", "dayoff"]), "dayoff");
  eq("a real mark still outranks a day off", dayTone(["dayoff", "present"]), "present");

  const records = [
    { date: "2026-09-22", className: "Data Structures", tone: "exempted" },
    { date: "2026-09-23", className: "Data Structures", tone: "present" },
    { date: "2026-09-24", className: "Data Structures", tone: "absent" },
  ];
  const daysOff = [
    { date: "2026-09-22", className: "Data Structures", mode: "exempt", reason: "Public holiday", hue: "violet" },
    // No hue: what a record written before 052 was run looks like.
    { date: "2026-09-23", className: "Data Structures", mode: "present", reason: "Lab credit" },
    // Declared on a date nothing was held: no session to pair with.
    { date: "2026-09-30", className: "Data Structures", mode: "exempt", reason: "Reading week" },
    // The same date declared twice, whole class and cohort.
    { date: "2026-09-30", className: "Data Structures", mode: "exempt", reason: "Reading week (cohort)" },
  ];
  const entries = historyEntries(records, daysOff, false);
  const on = (date) => entries.filter((e) => e.date === date).map((e) => `${e.tone}:${e.label ?? ""}`);

  eq("a day that did not count shows the day off, not Exempt", on("2026-09-22"), ["dayoff:Public holiday"]);
  eq("a day that counted keeps Present and adds the reason", on("2026-09-23"), ["present:", "dayoff:Lab credit (counted)"]);
  eq("a day off with no session still shows", on("2026-09-30"), ["dayoff:Reading week"]);
  eq("an ordinary absence is untouched", on("2026-09-24"), ["absent:"]);
  eq(
    "with several classes, the reason names its class",
    historyEntries([], [daysOff[0]], true).map((e) => e.label),
    ["Data Structures: Public holiday"],
  );

  // 052. The student is looking at the same date on the same term as the staff
  // calendar, so it has to be drawn the same colour there — and a day declared
  // before the migration ran has no colour stored, which is exactly the amber
  // every day off already was.
  eq(
    "a day off carries the colour staff gave it",
    entries.filter((e) => e.date === "2026-09-22").map((e) => e.hue),
    ["violet"],
  );
  eq(
    "a day off stored without a colour falls back to amber",
    entries.filter((e) => e.tone === "dayoff" && e.date === "2026-09-23").map((e) => e.hue),
    ["amber"],
  );

  // One rule for both calendars of a student: the TA's record and their own.
  const { sessionTone, studentCalendar } = await import(pathToFileURL(calOut).href);
  const s = (status, state, date = "2026-09-15") => ({ date, className: "", status, state });

  eq("a mark shows as itself", sessionTone(s("closed", "unexcused")), "absent");
  eq("a cancelled class is no class", sessionTone(s("cancelled", null)), "cancelled");
  eq("an open session with no mark yet is not closed", sessionTone(s("open", null)), "pending");
  eq("a closed session with no mark is left off: it predates the student", sessionTone(s("closed", null)), null);
  eq("a register taken early shows", sessionTone(s("scheduled", "present")), "present");

  eq(
    "both screens get the same entries from the same facts",
    studentCalendar(
      [s("closed", "exempted", "2026-09-22"), s("closed", null, "2026-09-01"), s("open", null, "2026-09-29")],
      [{ date: "2026-09-22", className: "", mode: "exempt", reason: "Public holiday" }],
      false,
    ).map((e) => `${e.date}:${e.tone}:${e.label ?? ""}`),
    ["2026-09-29:pending:", "2026-09-22:dayoff:Public holiday"],
  );
}

// ---------------------------------------------------------------------------
// taNavigation — where a remembered dashboard tab lands
//
// Classes, Schedule and Class Sessions became one Class page. The last tab is
// kept in sessionStorage, so a tab left open across the change still says
// "schedule" or "sessions", and has to land on the matching Class tab.
// ---------------------------------------------------------------------------

const navOut = join(mkdtempSync(join(tmpdir(), "nav-")), "nav.mjs");
await build({
  entryPoints: [join(root, "src/lib/taNavigation.ts")],
  outfile: navOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { restoreNavigation } = await import(pathToFileURL(navOut).href);

console.log("\ntaNavigation");

eq("the old Schedule tab opens Sessions, where the pattern now lives", restoreNavigation("schedule", null), { tab: "class", classTab: "sessions" });
eq("the old Class Sessions tab opens Sessions", restoreNavigation("sessions", "settings"), { tab: "class", classTab: "sessions" });
eq("Classes kept its name and opens the list of all classes", restoreNavigation("classes", null), { tab: "classes", classTab: "sessions" });
eq("a current tab is kept, with its class tab", restoreNavigation("class", "settings"), { tab: "class", classTab: "settings" });
// A browser tab left open on Weekly pattern: that tab is gone, and the
// fallback has to put it on the screen the pattern moved into.
eq("a remembered Weekly pattern lands on Sessions", restoreNavigation("class", "pattern"), { tab: "class", classTab: "sessions" });
eq("so is any other tab", restoreNavigation("students", "settings"), { tab: "students", classTab: "settings" });
eq("nothing remembered starts on Attendance", restoreNavigation(null, null), { tab: "attendance", classTab: "sessions" });
eq("an unknown tab starts on Attendance", restoreNavigation("reports", null), { tab: "attendance", classTab: "sessions" });
eq("an unknown class tab falls back to Sessions", restoreNavigation("class", "timetable"), { tab: "class", classTab: "sessions" });

// ---------------------------------------------------------------------------
// attendanceRule — what a class requires, and whether a student has met it
//
// A class requires a percentage, or allows a number of absences (046). The
// roster, the record a TA opens and the student's own page all ask that same
// question, so the bands and the wording are pinned here instead of being
// written out three times and drifting apart.
// ---------------------------------------------------------------------------

const ruleOut = join(mkdtempSync(join(tmpdir(), "rule-")), "rule.mjs");
await build({
  entryPoints: [join(root, "src/lib/attendanceRule.ts")],
  outfile: ruleOut,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const {
  standingOf,
  standingValue,
  requirementLabel,
  requirementSummary,
  shortFilterLabel,
  shortfallLine,
  requirementOf,
} = await import(pathToFileURL(ruleOut).href);

console.log("\nattendanceRule");

const pctRule = { rule: "percentage", minPercentage: 75, maxAbsences: 4 };
const absRule = { rule: "absences", minPercentage: 75, maxAbsences: 3 };

eq("at the required percentage, met", standingOf(pctRule, { counted: 10, rate: 75, absent: 2 }), "met");
eq("just under is a warning, not a failure", standingOf(pctRule, { counted: 10, rate: 72, absent: 3 }), "warning");
eq("well under is short", standingOf(pctRule, { counted: 10, rate: 40, absent: 6 }), "short");
eq("nothing counted yet is not failing", standingOf(pctRule, { counted: 0, rate: 0, absent: 0 }), "none");

eq("inside the allowance, met", standingOf(absRule, { counted: 5, rate: 60, absent: 2 }), "met");
eq("on the last allowed absence is a warning", standingOf(absRule, { counted: 5, rate: 40, absent: 3 }), "warning");
eq("one over the allowance is short", standingOf(absRule, { counted: 5, rate: 40, absent: 4 }), "short");
eq(
  "a rate far below the percentage does not matter under the absences rule",
  standingOf(absRule, { counted: 9, rate: 10, absent: 1 }),
  "met",
);
eq(
  "an allowance is spent before anything has closed",
  standingOf(absRule, { counted: 0, rate: 0, absent: 4 }),
  "short",
);

eq(
  "the number shown is the rate, or the absences against the allowance",
  [
    standingValue(pctRule, { counted: 4, rate: 80, absent: 1 }),
    standingValue(absRule, { counted: 4, rate: 80, absent: 1 }),
  ],
  ["80%", "1/3"],
);
eq("nothing counted shows a dash, not 0%", standingValue(pctRule, { counted: 0, rate: 0, absent: 0 }), "—");

eq(
  "each rule says what it requires in its own words",
  [requirementLabel(pctRule), requirementLabel(absRule)],
  ["of 75% needed", "of 3 absences allowed"],
);
eq(
  "one absence allowed is not pluralised",
  requirementLabel({ rule: "absences", minPercentage: 75, maxAbsences: 1 }),
  "of 1 absence allowed",
);
eq(
  "the roster's filter is named for the rule",
  [shortFilterLabel(pctRule), shortFilterLabel(absRule)],
  ["Below 75%", "Over 3 absences"],
);
eq(
  "and the settings row says it plainly",
  [requirementSummary(pctRule), requirementSummary(absRule)],
  ["75%", "Up to 3 absences"],
);

eq(
  "a student who is short is told which rule they are short of",
  [
    shortfallLine(pctRule, { counted: 10, rate: 40, absent: 6 }),
    shortfallLine(absRule, { counted: 10, rate: 40, absent: 6 }),
  ],
  ["Below the 75% this class requires.", "6 absences, more than the 3 this class allows."],
);
eq("nobody who has met it is told anything", shortfallLine(pctRule, { counted: 10, rate: 90, absent: 0 }), null);

eq(
  "a class row from before the rule existed reads as the percentage one",
  requirementOf({ min_attendance_percentage: 60 }),
  { rule: "percentage", minPercentage: 60, maxAbsences: 4 },
);
eq(
  "a class on the absences rule carries its allowance",
  requirementOf({ attendance_rule: "absences", min_attendance_percentage: 75, max_absences: 2 }),
  { rule: "absences", minPercentage: 75, maxAbsences: 2 },
);

// Printed last, immediately before the exit. It used to sit in the middle of
// the file, so every block appended after it ran without being counted: the
// exit code still caught failures, but the number on screen was short by
// everything added since, and that number is what gets quoted.
console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
