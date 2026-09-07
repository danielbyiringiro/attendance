// Reading and correcting attendance.
//
// Every state is read off a stored row. Nothing here recomputes absence from
// the absence of a presence record, which is what the two browser-side
// derivations do today.

import { supabase } from "@/lib/supabase";
import type { AttendanceRecordRow, AttendanceState } from "@/lib/api/types";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

export interface SessionAttendee {
  student_id: string;
  name: string | null;
  state: AttendanceState | null;
  marked_at: string | null;
}

/**
 * Everyone enrolled in a session's cohort, with their state.
 *
 * Driven from enrolments rather than from records, so a student with no record
 * yet appears with state null — a live roster has to show who has NOT marked,
 * which a query over attendance_records alone cannot do.
 */
export const rosterForSession = async (
  sessionId: string,
): Promise<SessionAttendee[]> => {
  const { data: session, error: sessionError } = await supabase
    .from("class_sessions")
    .select("id, cohort_id, session_date")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) fail("Could not load the session", sessionError);
  if (!session) return [];

  const { data: enrolled, error: enrolError } = await supabase
    .from("enrolments")
    .select("student_id, students(name)")
    .eq("cohort_id", (session as { cohort_id: string }).cohort_id)
    .is("dropped_on", null)
    .lte("enrolled_on", (session as { session_date: string }).session_date)
    .order("student_id");
  if (enrolError) fail("Could not load the roster", enrolError);

  const { data: records, error: recordError } = await supabase
    .from("attendance_records")
    .select("student_id, state, marked_at")
    .eq("session_id", sessionId);
  if (recordError) fail("Could not load attendance", recordError);

  const byStudent = new Map(
    ((records ?? []) as Array<{
      student_id: string;
      state: AttendanceState;
      marked_at: string;
    }>).map((r) => [r.student_id, r]),
  );

  return ((enrolled ?? []) as unknown as Array<{
    student_id: string;
    students: { name: string | null } | null;
  }>).map((e) => {
    const record = byStudent.get(e.student_id);
    return {
      student_id: e.student_id,
      name: e.students?.name ?? null,
      state: record?.state ?? null,
      marked_at: record?.marked_at ?? null,
    };
  });
};

/**
 * Set one student's state by hand.
 *
 * Any change to an existing state is logged to attendance_corrections by a
 * database trigger, so a correction cannot be made without leaving a record —
 * including one made straight from the SQL editor.
 */
export const setAttendanceState = async (
  sessionId: string,
  studentId: string,
  state: AttendanceState,
): Promise<AttendanceRecordRow> => {
  const { data: session, error: sessionError } = await supabase
    .from("class_sessions")
    .select("class_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) fail("Could not load the session", sessionError);
  if (!session) throw new Error("That session no longer exists.");

  const { data, error } = await supabase
    .from("attendance_records")
    .upsert(
      {
        session_id: sessionId,
        class_id: (session as { class_id: string }).class_id,
        student_id: studentId,
        state,
        marked_at: new Date().toISOString(),
        marked_by_role: "staff",
      },
      { onConflict: "session_id,student_id" },
    )
    .select()
    .single();
  if (error) fail("Could not save the mark", error);
  return data as AttendanceRecordRow;
};

export interface StudentClassSummary {
  student_id: string;
  name: string | null;
  cohort_label: string;
  sessions: number;
  present: number;
  late: number;
  excused: number;
  unexcused: number;
  /** (present + late) / (sessions - excused - exempted), as a percentage. */
  rate: number;
}

/**
 * Per-student totals for a class over a date range.
 *
 * Counts states rather than deriving them: `unexcused` is a row that exists,
 * written by close_session, not the gap left by a missing check-in.
 */
export const classSummary = async (
  classId: string,
  opts: { from?: string; to?: string; cohortId?: string } = {},
): Promise<StudentClassSummary[]> => {
  let sessionQuery = supabase
    .from("class_sessions")
    .select("id, cohort_id")
    .eq("class_id", classId)
    .neq("status", "cancelled")
    .neq("status", "scheduled");

  if (opts.cohortId) sessionQuery = sessionQuery.eq("cohort_id", opts.cohortId);
  if (opts.from) sessionQuery = sessionQuery.gte("session_date", opts.from);
  if (opts.to) sessionQuery = sessionQuery.lte("session_date", opts.to);

  const { data: sessions, error: sessionError } = await sessionQuery;
  if (sessionError) fail("Could not load sessions", sessionError);

  const sessionIds = ((sessions ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (sessionIds.length === 0) return [];

  const { data: records, error: recordError } = await supabase
    .from("attendance_records")
    .select("student_id, state, session_id")
    .in("session_id", sessionIds);
  if (recordError) fail("Could not load attendance", recordError);

  const { data: enrolled, error: enrolError } = await supabase
    .from("enrolments")
    .select("student_id, cohorts(label), students(name)")
    .eq("class_id", classId)
    .is("dropped_on", null);
  if (enrolError) fail("Could not load the roster", enrolError);

  const summaries = new Map<string, StudentClassSummary>();
  ((enrolled ?? []) as unknown as Array<{
    student_id: string;
    cohorts: { label: string } | null;
    students: { name: string | null } | null;
  }>).forEach((e) => {
    summaries.set(e.student_id, {
      student_id: e.student_id,
      name: e.students?.name ?? null,
      cohort_label: e.cohorts?.label ?? "",
      sessions: 0,
      present: 0,
      late: 0,
      excused: 0,
      unexcused: 0,
      rate: 0,
    });
  });

  ((records ?? []) as Array<{ student_id: string; state: AttendanceState }>).forEach(
    (r) => {
      const s = summaries.get(r.student_id);
      if (!s) return;
      s.sessions += 1;
      if (r.state === "present") s.present += 1;
      else if (r.state === "late") s.late += 1;
      else if (r.state === "excused") s.excused += 1;
      else if (r.state === "unexcused") s.unexcused += 1;
    },
  );

  summaries.forEach((s) => {
    // Excused days leave the denominator rather than counting against anyone.
    const graded = s.present + s.late + s.unexcused;
    s.rate = graded > 0
      ? Math.round(((s.present + s.late) / graded) * 1000) / 10
      : 0;
  });

  return [...summaries.values()].sort((a, b) =>
    a.student_id.localeCompare(b.student_id),
  );
};
