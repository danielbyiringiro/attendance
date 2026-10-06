# Attendance

Class attendance for a university course. Students check in with their ID and a
PIN; teaching assistants keep the register, the roster and the reporting for the
classes they run.

Built with Vite, React, TypeScript, Tailwind and shadcn/ui, on Supabase
(Postgres, Auth and Row Level Security).

## What it does

**Students** open the site, type their student ID and the PIN their TA has put
on the board, and they are marked. That is the whole student-facing app, and it
is deliberately the whole of it — a check-in that needs an account is a check-in
half the room does not complete.

**Teaching assistants** sign in and get, for each class they are on:

- **Attendance** — today's sessions, the PIN each one issued, and the register.
  Marking by hand is a screen of its own: one student at a time, with Present,
  Absent, Excused and Skip, and each marked name leaving the list.
- **Analytics** — every student's standing, filtered by cohort, by name, by
  those below the attendance requirement, or by a number of absences. Absence
  history, weekly reports, flagged records, and a CSV export.
- **Students** — the roster, with single adds and bulk upload from a CAMU or
  Canvas export in CSV or PDF.
- **Class Sessions** — open, close, move or cancel a session.
- **Schedule** — when each cohort meets, and generating a term of sessions from
  that.
- **Classes** — creating a class, its cohorts, its term dates and who else may
  manage it.
- **Admin**, for accounts: approving people who have signed up, and repairing
  class membership when somebody has locked themselves out.

## Two rules worth knowing before reading the code

**An absence is a stored fact, not a calculation.** Closing a session writes an
`unexcused` row for everybody enrolled who did not mark. Nothing recomputes who
was missing from what a screen happens to know — which is what the app did
before, from check-ins plus a guess at which days counted, and it disagreed with
itself in four places.

**You see a class if you are on it.** Not if you are an admin, and not if you
are signed in. `can_access_class` is membership and nothing else, and the admin
functions are separate: an admin can approve accounts and repair membership, and
cannot read a roster, a session or anybody's attendance.

## Running it

```sh
npm i
npm run dev
```

### Supabase

Copy `.env.example` to `.env.local` and fill in both values:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your publishable or anon key>
```

Both are **required**. `vite.config.ts` refuses to build without them and
`src/lib/supabase.ts` throws at startup without them, naming whichever is
missing: a build that cannot reach the database should fail rather than deploy a
white screen to every student. On a host, set the same two names as environment
variables — Vite inlines them at build time, so changing one in a dashboard
takes a fresh deploy to have any effect.

Find them under **Project Settings → API Keys**. Either the newer
`sb_publishable_…` key or the legacy `anon` key works, and the publishable one is
preferred: the legacy `anon` and `service_role` keys are a pair signed by one
secret, so they can only be disabled together. Never the `service_role` key — it
bypasses Row Level Security completely, and everything in that file ships to the
browser.

The key that belongs here is meant to be public: it ships inside the client
bundle, so every rule that matters is enforced by Row Level Security and by
`SECURITY DEFINER` functions, never by the browser.

Then, in **Authentication**:

- Add every origin you deploy to under **URL Configuration → Redirect URLs**, or
  the confirmation links sign-up sends will be refused.
- The built-in email sender is rate limited and documented as development-only.
  Configure custom SMTP under **Emails** before real use.

Note that **the approval flow sends no email at all.** Nobody is told they have
been approved or declined; the waiting screen says so plainly rather than
implying a message is coming. Adding one needs an Edge Function or a database
webhook.

### Schema

The schema is the numbered migrations in [`sql/migrations`](sql/migrations),
applied in order in the Supabase SQL editor. Each is written to be safe to run
twice.

| | |
|---|---|
| `001` | classes, cohorts, enrolments |
| `002` | schedules and sessions |
| `003` | staff and per-class access |
| `004` | attendance records, and absence as a stored fact |
| `005` | backfill of the pre-class data into one class |
| `006` | check-in resolves the class from the PIN |
| `007` | class management, roster upload with dedupe |
| `008` | a class belongs to the people on it |
| `009` | per-day schedule times, colleague search |
| `010` | moving a session, and pushing a pattern change forward |
| `011` | class length and sign-up window as separate settings |
| `012` | deleting a class takes the students only it had |
| `013` | marking everyone present for one session |
| `014` | naming the check-in failures that identify nobody |
| `015` | retiring the pre-class tables |
| `016` | a flag belongs to a class |
| `017` | you cannot dispute a session you were marked present at |
| `018` | you cannot remove yourself from a class by accident |
| `019` | the attendance requirement travels with the history |
| `020` | anyone may ask for an account; an admin decides |
| `021` | keeping the name somebody typed when asking |
| `022` | refusing a disallowed email domain at signup |
| `023` | previewing a roster upload with the code that performs it |
| `024` | correcting a student's name, cohort or ID |
| `025` | tell the student which class they just marked |
| `026` | make the legacy tables' protection explicit, and fix the signup hint |
| `027` | a newly approved colleague can be found |
| `028` | open check-in before class without spending the window on it |
| `029` | how early check-in opens, set per meeting |
| `030` | let the dashboard see a check-in arrive |
| `031` | sessions open and close without anyone pressing a button |
| `032` | cancelling a class removes the attendance, all of it |
| `033` | a session may open itself at any point during the class |
| `034` | a schedule edit leaves any session that has attendance against it |
| `035` | add one session on one date, outside the weekly pattern |
| `036` | a day the class does not meet |
| `037` | declaring a holiday removes the sessions that never ran |
| `038` | a day off cannot name a cohort from another class |
| `039` | add one date, or the same weekday over a range |
| `040` | set the check-in timing for a cohort, or the whole class, in one place |
| `041` | show a class's check-in on another screen, with a link and a code |
| `042` | staff can mark a student on a session from before they were added |
| `043` | how many absences in a week put a student on the weekly report |
| `044` | a check-in says who made it, and the display can count check-ins |
| `045` | a student's history shows the days their class did not meet, and why |
| `046` | a class requires a percentage, or allows a number of absences |
| `047` | clearing a roster: remove everybody, keeping or erasing their record |
| `048` | check-in that shuts when the class starts, with a grace window |
| `049` | help videos, and announcements people can actually be told about |
| `050` | an admin can remove an account |
| `051` | staff can say what is wrong, where the work happens |
| `052` | a day off says what it is, in a colour that was chosen |
| `053` | see what filling would do, before it does it |
| `054` | move a session to another day, or move the run it belongs to |
| `055` | pause the app |
| `056` | schedule a pause, and warn before it starts |
| `057` | a log only admins can read |
| `058` | a pause reaches open screens at once |
| `059` | a report says which kind of report it is |
| `060` | an excuse says why, and happens in one go |
| `061` | an announcement that asks to be read |
| `062` | a note on one student's day |

**`020` needs editing before it is run.** It bootstraps the first admin from an
address near the top of the file, which ships as a placeholder that matches
nobody. Set it to an account that has signed in at least once.

Most of what is under `sql/` but not in `sql/migrations` predates this model and
is kept only as a record of how the database got here. Do not run those files
against a database that has the migrations applied; `sql/secure_database.sql` in
particular rebuilds protection for tables that `015` and `026` retired.

**One exception, and it is load-bearing.** `sql/add_canvas_mappings.sql` creates
`canvas_row_mappings`, and no numbered migration does — the match panel tells
you to run it by name. Until it is folded into a migration, three things follow:
the export works without it but forgets manual Canvas pairings between runs,
`npm run test:sql` never creates the table so nothing about that feature is
covered, and whether a given project has it is discoverable only at runtime.

`sql/diagnostics` is read-only queries for answering "what happened to this
session", not schema.

### The shape of it

A **class** is the top level: a code, a name, term dates and a timezone. It has
**cohorts** (sections), each with its own weekly pattern of meeting days. Those
patterns expand into **class_sessions** — one row per meeting of one cohort,
created before anyone checks in.

**students** is a global registry: one row per person, however many classes they
take. **enrolments** joins a student to a cohort, so the same student can appear
in several classes without being duplicated. That is also why a roster upload
fills a missing name but never overwrites one — a stale spreadsheet in one class
must not rename a student for every other class.

**attendance_records** holds one row per student per session, carrying a state
(`present`, `late`, `excused`, `unexcused`, `exempted`, `pending`) and who
decided it (`student`, `staff` or `system`). That last column is what separates
"nobody looked" from "somebody called them absent". Every change to an existing
state is logged to `attendance_corrections` by a trigger, so a mark cannot be
altered without leaving a record, including from the SQL editor.

A **PIN belongs to a session, not to the installation.** Several classes can be
open at once; `mark_attendance` resolves which one a code belongs to and whether
the student is enrolled in that cohort. It gives one generic refusal for every
failure that depends on the student, because distinguishing them would turn the
endpoint into an enrolment oracle for anyone holding a student ID.

### Accounts

Anyone may sign up, from an email domain on the `allowed_email_domains` list,
and an admin approves them before they can do anything. The domain rule is
enforced twice: as a trigger on `auth.users`, so a disallowed address never
becomes an account or receives an email, and again in `ensure_staff`, which is
what actually gates access.

## Testing

```sh
npm run typecheck     # tsc -b, which is not the same as tsc --noEmit here
npm run lint
npm run test:sql      # migrations against a throwaway Postgres, needs Docker
npm run test:attendance
npm run test:roster
```

`typecheck` runs `tsc -b` deliberately. `tsconfig.json` is a project-references
root with `"files": []`, so `tsc --noEmit` resolves it, finds nothing, and exits
0 whatever the code says.

`test:sql` is the important one. Migrations land on a database holding real
attendance and cannot be rehearsed in Supabase, so this applies them to a
throwaway container — twice, to prove they are re-runnable — against a fixture
shaped like the pre-migration database, then runs the assertions in
[`sql/tests`](sql/tests). It touches no Supabase project.

Those assertions are written to **fail if the rule they describe is removed**,
and each was checked by removing it. They are the closest thing here to a
specification: `021` says an admin cannot read attendance, `023` says a preview
and the write it previews cannot disagree, `025` says correcting a student ID
moves their history rather than deleting it.

**Fixtures use invented people.** A real class list is exactly the personal data
this repository has already had to purge from its own history once.

## Accessibility

The icon beside the theme toggle opens text size, motion, contrast, link
underlines and focus visibility. Every one of them is a class on `<html>` and
CSS in `index.css`, so no component has to honour them individually — a setting
that only some screens respect is worse than none, because it looks like it is
working.

Text size scales the root font size, so the whole interface follows rather than
the words alone.
