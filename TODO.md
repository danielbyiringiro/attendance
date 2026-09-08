# TODO

Deferred work, with enough context to pick it up cold.

## Export templates, once an overadmin role exists

**Do not build this yet — it is blocked on the overadmin role.**

Attendance export formats are currently hard-coded in `FORMATS` in
[src/lib/attendanceExport.ts](src/lib/attendanceExport.ts). Adding a destination
system means editing that object and shipping a release, which puts every new
gradebook or SIS layout on a developer.

Once an overadmin role lands, that role should be able to define export
templates from the UI instead — name the file, choose the columns and their
order, map each column to a field the exporter already computes (student ID,
name, cohort, class days, present, absent, excused, rate, per-day status), and
save it for the TAs to pick from the Format dropdown.

The registry was written with this in mind. `FormatDefinition` is a label, a
description, a `usesShape` flag and a `render(ctx)` function over already-tallied
rows — a stored template is the same thing with `render` driven by saved column
config rather than code. The fetching and counting layer should not need to
change.

Worth deciding at that point:

- Where templates live (a `export_templates` table, presumably, with RLS
  restricting writes to overadmins and reads to authenticated staff).
- Whether templates are global or per-institution, once institutions exist.
- Whether a template can add a computed column (e.g. "pass/fail at 80%") or only
  reorder and rename the fields the exporter already produces.
- Canvas has rules a generic template builder can break: assignment column names
  containing `Current Score`, `Final Grade`, `Override Status` and similar are
  silently ignored on import. `CANVAS_RESERVED_FRAGMENTS` guards this for the
  built-in format; a user-defined template needs the same check surfaced at
  template-save time, not at export time.

## CAMU export format — needs a real sample

A CAMU option was requested alongside Canvas, but we have no specification or
sample file for what CAMU accepts on import, and guessing at a layout produces a
file that fails silently on the other end.

If CAMU can export its own roster or gradebook, prefer the round-trip that
Canvas uses: upload CAMU's file, fill a column, hand it back. See
[src/lib/canvasGradebook.ts](src/lib/canvasGradebook.ts) — matching on the
institutional student ID means no name reformatting and no guessing at
identity columns.

To implement: get one real CAMU attendance or grade import template (ideally an
export from CAMU itself, which is usually round-trippable), confirm the required
columns, their order, and how CAMU matches students, then add an entry to
`FORMATS`. The Canvas entry in
[src/lib/attendanceExport.ts](src/lib/attendanceExport.ts) is the model to copy.

## Migration to run

`sql/add_canvas_mappings.sql` stores remembered Canvas row pairings. Until it
is run in the Supabase SQL Editor, the export still works but forgets manual
pairings and ignores between exports, and the match panel says so.

## Deferred by the class data model branch

### Bulk roster upload

`upsert_enrolments` exists, is tested, and does the hard part: one server call
whatever the size, reusing an existing `student_id` so somebody taking two
courses is not duplicated, filling in a missing name but never overwriting one,
and reporting anyone already in a different cohort rather than moving them
silently. What is missing is the screen.

The only way to enrol somebody today is Add Student, one at a time, which for a
cohort of sixty is sixty round trips through a dialog. This is the next feature
branch.

`parseCsv` in [src/lib/csv.ts](src/lib/csv.ts) already handles BOM, quotes and
CRLF and needs no changes. The shape worth building is a preview before any
write, in five buckets: new student / existing student, new enrolment / already
enrolled / in another cohort of this class (offer to move) / invalid.

### Retiring the legacy schema for real

Migration 015 moved the pre-class tables into a `legacy` schema rather than
dropping them, so the rows survive if the reconciliation ever turns out to have
been wrong. `v_bridge_reconciliation` has read 0 unexplained since. Once a term
has passed without anyone wanting them, `DROP SCHEMA legacy CASCADE` finishes
the job.

### Two functions removed, worth reviving

Both were written and left uncalled, and are in git history rather than the
tree:

- `createAdHocSession` — a one-off session outside the weekly pattern, for a
  make-up class. There is no UI for one; a session can only come from the
  pattern or be moved by hand.
- `classSummary` — per-student totals from its own queries. Removed because
  `StudentRoster` computes the same numbers from `attendanceLog`, and two
  implementations of one rate is how they drift.

### Percentages are still computed in two places

`StudentRoster` and `attendanceExport` each work out an attendance rate from
the same stored states. They agree today. A `v_student_class_attendance` view
both read would make that structural rather than a coincidence.

## Smaller items

All of the items that were here — the two disagreeing `SEMESTER_START`
constants, the unpaginated roster read, and `buildWeeklyReport` disagreeing
with the exporter about cancellations and about what counts as a class day —
were resolved by the class data model branch. Absence is a stored row now, so
the derivations that disagreed no longer exist.
