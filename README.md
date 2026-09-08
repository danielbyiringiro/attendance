# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/7bf881f8-ad43-4945-9202-ac8206d01f04

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/7bf881f8-ad43-4945-9202-ac8206d01f04) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## Supabase Setup

Create a `.env.local` file in the project root:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
```

Both are in the Supabase dashboard under Project Settings → API. The anon key
is meant to be public — it ships inside the client bundle — so every rule that
matters is enforced by Row Level Security and by `SECURITY DEFINER` functions,
never by the browser.

### Schema

The schema is defined by the numbered migrations in [`sql/migrations`](sql/migrations),
applied in order. Run each one once, in the Supabase SQL editor. They are
written to be safe to run twice.

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

Anything under `sql/` that is not in `sql/migrations` predates this model and is
kept only as a record of how the database got here. Do not run those files
against a database that has the migrations applied.

### The shape of it

A **class** is the top level: a code, a name, term dates and a timezone. It has
**cohorts** (sections), each with its own weekly pattern of meeting days. Those
patterns expand into **class_sessions** — one row per meeting of one cohort,
created before anyone checks in.

**students** is a global registry: one row per person, however many classes they
take. **enrolments** joins a student to a cohort, so the same student can appear
in several classes without being duplicated.

**attendance_records** holds one row per student per session, carrying a state
(`present`, `late`, `excused`, `unexcused`, `exempted`, `pending`). Closing a
session writes `unexcused` for everyone enrolled who did not mark — which is
what makes an absence a stored fact rather than something a screen recomputes.
Every change to an existing state is logged to `attendance_corrections` by a
trigger, so a mark cannot be altered without leaving a record, including from
the SQL editor.

A **PIN belongs to a session, not to the installation.** Several classes can be
open at once; `mark_attendance` resolves which one a code belongs to and
whether the student is enrolled in that cohort.

### Testing

Migrations land on a database holding real attendance, so they cannot be
rehearsed in Supabase. `npm run test:sql` applies them to a throwaway Postgres
container — twice, to prove they are re-runnable — against a fixture shaped
like the pre-migration database, then runs the assertions in `sql/tests`.
Requires Docker. It touches no Supabase project.

`npm run test:attendance` covers the shared attendance read in
`src/lib/api/attendance.ts` against a stubbed client, with no database at all.

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/7bf881f8-ad43-4945-9202-ac8206d01f04) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/features/custom-domain#custom-domain)
