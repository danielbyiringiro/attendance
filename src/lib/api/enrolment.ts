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

/**
 * Correct a student's name.
 *
 * `students` is a global registry, so this changes the name in every class the
 * person takes — which is why the server permits it only to somebody who
 * manages a class they are enrolled in, and why a roster upload deliberately
 * cannot do it. Say so wherever this is offered.
 *
 * Their ID is not editable here. It is the join key for every attendance
 * record, and the foreign keys carry no ON UPDATE CASCADE.
 */
export const updateStudent = async (
  studentId: string,
  name: string | null,
): Promise<{ student_id: string; name: string | null }> => {
  const { data, error } = await supabase.rpc("update_student", {
    p_student_id: studentId,
    p_name: name,
  });
  if (error) fail("Could not update the student", error);
  return data as { student_id: string; name: string | null };
};

/** What a corrected ID took with it. */
export interface StudentIdChange {
  student_id: string;
  previous_id?: string;
  unchanged: boolean;
  enrolments?: number;
  attendance_records?: number;
  flags?: number;
}

/**
 * Correct a mistyped student ID, carrying their history with them.
 *
 * The symptom this fixes is silent: with the wrong ID on the roster the
 * student types their real one, nothing matches, and they are marked absent
 * all term while looking perfectly enrolled.
 *
 * Their enrolments, attendance records and flags move with them — they are the
 * same person, not a new one. Migration 024 had to add ON UPDATE CASCADE to
 * every foreign key onto `students` for that to be possible at all.
 *
 * An ID somebody else already holds is refused: that is a merge, which has to
 * decide what happens when both records have attendance for the same session.
 */
export const changeStudentId = async (
  from: string,
  to: string,
): Promise<StudentIdChange> => {
  const { data, error } = await supabase.rpc("change_student_id", {
    p_from: from,
    p_to: to,
  });
  if (error) fail("Could not change the student ID", error);
  return data as StudentIdChange;
};

/** What one edit is asking to change. A key present means "change this". */
export interface StudentEdit {
  /** null clears the name; omit the key to leave it alone. */
  name?: string | null;
  cohort_id?: string;
  student_id?: string;
}

/** What actually changed, as the server reports it. */
export interface StudentEditResult {
  student_id: string;
  previous_id?: string;
  name?: string | null;
  cohort_label?: string;
  attendance_records?: number;
  enrolments?: number;
  flags?: number;
}

/**
 * Apply a student edit as ONE transaction.
 *
 * The dialog offers name, cohort and ID on one form, so the save has to behave
 * like one action. Three separate calls cannot: the rename succeeds, the ID
 * change is refused, and the record is left in a state nobody asked for with
 * the dialog already closed. Migration 024 makes it one function, so a refusal
 * anywhere rolls the whole edit back.
 *
 * Key presence carries the intent — `{name: null}` clears a name, omitting the
 * key leaves it alone — because null cannot mean both.
 */
export const editStudent = async (
  studentId: string,
  changes: StudentEdit,
): Promise<StudentEditResult> => {
  const { data, error } = await supabase.rpc("edit_student", {
    p_student_id: studentId,
    p_changes: changes,
  });
  if (error) fail("Could not save the changes", error);
  return data as StudentEditResult;
};
