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

## Smaller items

- `SEMESTER_START` disagrees across the app: the export module and TA dashboard
  use 2026-05-18, while [src/components/StudentDashboard.tsx](src/components/StudentDashboard.tsx)
  uses 2026-05-26. One of them is wrong and students see the other number.
- The roster load in [src/pages/Index.tsx](src/pages/Index.tsx) is not paginated,
  so it silently truncates past 1000 students. Affects the dashboard and the
  export dialog's student picker; the export itself paginates its own read.
- `buildWeeklyReport` in [src/components/TADashboard.tsx](src/components/TADashboard.tsx)
  now disagrees with the exporter in two ways. Decide which is right and make
  them match:
  1. It treats a cancelled session as cancelled for **every** cohort, ignoring
     the `cohort` column on `cancelled_sessions`. The exporter respects it.
  2. It counts **every** Tue/Wed/Thu as a class day, so any day the cohort did
     not actually meet — a holiday, a reading week, a day nobody recorded as
     cancelled — is charged to every student as an absence. The exporter counts
     a day only when there is evidence the session ran (a check-in, or a
     `class_dates` row), which is the same inference `loadAbsenceHistory`
     already makes. The weekly report's `weekNumber > 1` skip is a symptom of
     this: week 1 had to be special-cased precisely because no attendance was
     taken then.
