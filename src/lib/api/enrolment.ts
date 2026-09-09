// Enrolment: who is in which cohort of which class.
//
// `students` is a global person registry — a student exists once regardless of
// how many classes they take — so everything here works on enrolments and
// never on the student row itself.

import { supabase } from "@/lib/supabase";
import type { EnrolledStudent, UpsertEnrolmentsResult } from "@/lib/api/types";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

const PAGE_SIZE = 1000;

interface RawEnrolment {
  student_id: string;
  cohort_id: string;
  enrolled_on: string;
  dropped_on: string | null;
  cohorts: { label: string } | null;
  students: { name: string | null } | null;
}

/**
 * The roster for a class, or one cohort of it.
 *
 * Paginated. PostgREST caps a response at 1000 rows, and a silently truncated
 * roster is how a screen ends up confidently showing a class as smaller than it
 * is — the same bug the exporter had to fix.
 */
export const listEnrolments = async (
  classId: string,
  opts: { cohortId?: string; includeDropped?: boolean } = {},
): Promise<EnrolledStudent[]> => {
  const rows: RawEnrolment[] = [];
  let from = 0;

  for (;;) {
    let query = supabase
      .from("enrolments")
      .select("student_id, cohort_id, enrolled_on, dropped_on, cohorts(label), students(name)")
      .eq("class_id", classId)
      .order("student_id")
      .range(from, from + PAGE_SIZE - 1);

    if (opts.cohortId) query = query.eq("cohort_id", opts.cohortId);
    if (!opts.includeDropped) query = query.is("dropped_on", null);

    const { data, error } = await query;
    if (error) fail("Could not load the roster", error);

    const page = (data ?? []) as unknown as RawEnrolment[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows.map((r) => ({
    student_id: r.student_id,
    name: r.students?.name ?? null,
    cohort_id: r.cohort_id,
    cohort_label: r.cohorts?.label ?? "",
    enrolled_on: r.enrolled_on,
    dropped_on: r.dropped_on,
  }));
};

export interface RosterRow {
  student_id: string;
  name?: string | null;
}

/**
 * Upload a roster into a cohort.
 *
 * One server call, whatever the size: a two-hundred-row CSV as client-side
 * round trips is four hundred requests with no atomicity, and a failure halfway
 * leaves a half-enrolled class.
 *
 * A student_id that already exists is reused rather than duplicated, so the
 * same person can be enrolled in several classes. A missing name is filled in;
 * an existing one is never overwritten, because one class's stale spreadsheet
 * must not rename a student for every other class.
 *
 * Someone already in a different cohort of THIS class is reported in
 * `in_other_cohort` rather than moved. Pass `moveExisting` only after the TA
 * has seen that list and agreed — moving a student changes which sessions they
 * count as absent from.
 */
export const upsertEnrolments = async (
  cohortId: string,
  rows: RosterRow[],
  moveExisting = false,
  dryRun = false,
): Promise<UpsertEnrolmentsResult> => {
  const { data, error } = await supabase.rpc("upsert_enrolments", {
    p_cohort_id: cohortId,
    p_rows: rows.map((r) => ({
      student_id: r.student_id,
      name: r.name ?? null,
    })),
    p_move_existing: moveExisting,
    p_dry_run: dryRun,
  });
  if (error) fail("Could not upload the roster", error);
  return data as UpsertEnrolmentsResult;
};

/**
 * What an upload would do, having done none of it.
 *
 * Deliberately the same function as the write rather than an equivalent
 * calculation: see migration 023. Everything a preview shows is therefore a
 * promise the write is checked against, not an estimate.
 */
export const previewEnrolments = (
  cohortId: string,
  rows: RosterRow[],
  moveExisting = false,
): Promise<UpsertEnrolmentsResult> =>
  upsertEnrolments(cohortId, rows, moveExisting, true);

/** A student the Canvas match believes is filed under the wrong cohort. */
export interface CohortChange {
  studentId: string;
  from: string;
  to: string;
}

/**
 * Move one student to another cohort of the same class.
 *
 * Replaces src/lib/rosterUpdates.ts, which existed only because `cohort` was a
 * denormalised copy: it had to write students.cohort AND retag every historical
 * present_students row, non-atomically. Attendance now hangs off session_id,
 * and a session already knows its cohort, so this is one update.
 */
export const moveToCohort = async (
  classId: string,
  studentId: string,
  cohortId: string,
): Promise<void> => {
  const { error } = await supabase
    .from("enrolments")
    .update({ cohort_id: cohortId })
    .eq("class_id", classId)
    .eq("student_id", studentId);
  if (error) fail("Could not move the student", error);
};

/**
 * Take a student off the roster from a date, without deleting anything.
 *
 * Dropping rather than deleting is what keeps their past attendance intact and
 * stops close_session marking them absent from sessions after they left.
 */
export const dropEnrolment = async (
  classId: string,
  studentId: string,
  droppedOn?: string,
): Promise<void> => {
  const date =
    droppedOn ??
    (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    })();

  const { error } = await supabase
    .from("enrolments")
    .update({ dropped_on: date })
    .eq("class_id", classId)
    .eq("student_id", studentId);
  if (error) fail("Could not remove the student", error);
};
