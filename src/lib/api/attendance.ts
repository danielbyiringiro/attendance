// Reading and correcting attendance.
//
// Every state is read off a stored row. Nothing here recomputes absence from
// the absence of a presence record, which is what the two browser-side
// derivations do today.

import { supabase } from "@/lib/supabase";
import type {
  AttendanceRecordRow,
  AttendanceState,
  SessionStatus,
} from "@/lib/api/types";

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

// ---------------------------------------------------------------------------
// The attendance log — one read, replacing six derivations
// ---------------------------------------------------------------------------
//
// Every screen that shows attendance used to walk a date range day by day,
// deciding for itself what a class day was, what timezone the date was in, and
// what cancelled and excused meant. There were six of those loops, no two of
// them agreeing, and two were copy-paste of each other.
//
// They existed because absence was not stored: with only check-ins to go on, a
// screen had to reconstruct the days nobody marked. close_session now writes an
// `unexcused` row, so the whole question is a SELECT. This is that SELECT, in
// the one shape all six screens can be built from.

export interface LoggedSession {
  session_id: string;
  /** Resolved in the class's timezone by a trigger, never by the browser. */
  session_date: string;
  starts_at: string;
  cohort_id: string;
  cohort_label: string;
  status: SessionStatus;
  cancellation_reason: string | null;
}

export interface LoggedMark {
  session_id: string;
  session_date: string;
  cohort_id: string;
  cohort_label: string;
  student_id: string;
  state: AttendanceState;
  marked_at: string | null;
}

export interface AttendanceLog {
  /** Sessions that happened or are happening. Cancelled ones are included and
   *  labelled, so a screen can say "no class" rather than silently skip a day. */
  sessions: LoggedSession[];
  marks: LoggedMark[];
  sessionById: Map<string, LoggedSession>;
  /** Marks per student, newest session first. */
  byStudent: Map<string, LoggedMark[]>;
  /** Marks per session_date, across cohorts. */
  byDate: Map<string, LoggedMark[]>;
}

/** Present in the sense that counts: late is still attendance. */
export const isPresentState = (s: AttendanceState | null): boolean =>
  s === "present" || s === "late";

/** An absence that counts against the student. Excused and exempted do not. */
export const isAbsentState = (s: AttendanceState | null): boolean =>
  s === "unexcused";

/** In the denominator of an attendance rate. */
export const isGradedState = (s: AttendanceState | null): boolean =>
  s === "present" || s === "late" || s === "unexcused";

/** The one place a state becomes a word shown to a person. */
export const stateLabel = (s: AttendanceState | null): string => {
  switch (s) {
    case "present":
      return "Present";
    case "late":
      return "Late";
    case "excused":
      return "Excused";
    case "unexcused":
      return "Absent";
    case "exempted":
      return "Exempt";
    case "pending":
      return "Pending";
    default:
      return "No record";
  }
};

interface RawMark {
  student_id: string;
  state: AttendanceState;
  marked_at: string | null;
  session_id: string;
  class_sessions: {
    session_date: string;
    starts_at: string;
    status: SessionStatus;
    cohort_id: string;
    cancellation_reason: string | null;
    cohorts: { label: string } | null;
  } | null;
}

/**
 * Attendance for a class over a date range, as stored.
 *
 * `scheduled` sessions are excluded: a day that has not happened yet is not a
 * day anyone was absent from. Cancelled sessions are kept, because a screen
 * showing a term needs to account for the gap.
 *
 * Both queries paginate. PostgREST caps a response at 1000 rows and a term of
 * three cohorts passes that within a few weeks, so an unpaginated read is how a
 * dashboard ends up quietly reporting a fraction of the truth.
 */
export const attendanceLog = async (
  classId: string,
  opts: { from?: string; to?: string; cohortId?: string } = {},
): Promise<AttendanceLog> => {
  const PAGE = 1000;

  const sessionRows: Array<{
    id: string;
    session_date: string;
    starts_at: string;
    status: SessionStatus;
    cohort_id: string;
    cancellation_reason: string | null;
    cohorts: { label: string } | null;
  }> = [];

  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("class_sessions")
      .select(
        "id, session_date, starts_at, status, cohort_id, cancellation_reason, cohorts(label)",
      )
      .eq("class_id", classId)
      .neq("status", "scheduled")
      .order("session_date", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (opts.cohortId) q = q.eq("cohort_id", opts.cohortId);
    if (opts.from) q = q.gte("session_date", opts.from);
    if (opts.to) q = q.lte("session_date", opts.to);

    const { data, error } = await q;
    if (error) fail("Could not load sessions", error);
    const page = (data ?? []) as unknown as typeof sessionRows;
    sessionRows.push(...page);
    if (page.length < PAGE) break;
  }

  const sessions: LoggedSession[] = sessionRows.map((s) => ({
    session_id: s.id,
    session_date: s.session_date,
    starts_at: s.starts_at,
    cohort_id: s.cohort_id,
    cohort_label: s.cohorts?.label ?? "",
    status: s.status,
    cancellation_reason: s.cancellation_reason,
  }));

  const markRows: RawMark[] = [];

  // Filtered through an inner join on the session rather than by listing every
  // session id: a term's worth of uuids in an `in.(...)` makes a URL several
  // kilobytes long, which fails somewhere different on every host.
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("attendance_records")
      .select(
        "student_id, state, marked_at, session_id, class_sessions!inner(session_date, starts_at, status, cohort_id, cancellation_reason, cohorts(label))",
      )
      .eq("class_id", classId)
      .neq("class_sessions.status", "scheduled")
      .range(offset, offset + PAGE - 1);

    if (opts.cohortId) q = q.eq("class_sessions.cohort_id", opts.cohortId);
    if (opts.from) q = q.gte("class_sessions.session_date", opts.from);
    if (opts.to) q = q.lte("class_sessions.session_date", opts.to);

    const { data, error } = await q;
    if (error) fail("Could not load attendance", error);
    const page = (data ?? []) as unknown as RawMark[];
    markRows.push(...page);
    if (page.length < PAGE) break;
  }

  const marks: LoggedMark[] = markRows
    .filter((r) => r.class_sessions !== null)
    .map((r) => ({
      session_id: r.session_id,
      session_date: r.class_sessions!.session_date,
      cohort_id: r.class_sessions!.cohort_id,
      cohort_label: r.class_sessions!.cohorts?.label ?? "",
      student_id: r.student_id,
      state: r.state,
      marked_at: r.marked_at,
    }))
    .sort((a, b) => b.session_date.localeCompare(a.session_date));

  const byStudent = new Map<string, LoggedMark[]>();
  const byDate = new Map<string, LoggedMark[]>();
  marks.forEach((m) => {
    const forStudent = byStudent.get(m.student_id);
    if (forStudent) forStudent.push(m);
    else byStudent.set(m.student_id, [m]);

    const forDate = byDate.get(m.session_date);
    if (forDate) forDate.push(m);
    else byDate.set(m.session_date, [m]);
  });

  return {
    sessions,
    marks,
    sessionById: new Map(sessions.map((s) => [s.session_id, s])),
    byStudent,
    byDate,
  };
};

export interface MarkAllResult {
  session_id: string;
  state: AttendanceState;
  /** Everyone enrolled in the cohort on that day. */
  roll: number;
  /** Had no record at all. */
  filled: number;
  /** Had a state this replaced. Each one is logged as a correction. */
  changed: number;
  /** Already at this state, or deliberately protected. */
  left_alone: number;
}

/**
 * Record one state for everyone enrolled in a session.
 *
 * For the day the projector died and the register went round on paper. One
 * call rather than one correction per student.
 *
 * By default it only fills in students with no record and those marked
 * unexcused or pending. An excused absence, an exemption, and a late arrival
 * are left as they are: someone chose those, and `late` is a more specific
 * truth than `present`. `overwrite` takes everything except exempted, which
 * means the session does not apply to that student at all.
 *
 * A session that has not been closed is closed by this, because a `scheduled`
 * session is excluded from every count — marking everyone present and leaving
 * it open would look like nothing happened.
 */
export const markAllPresent = async (
  sessionId: string,
  opts: { state?: AttendanceState; overwrite?: boolean } = {},
): Promise<MarkAllResult> => {
  const { data, error } = await supabase.rpc("mark_all_present", {
    p_session_id: sessionId,
    p_state: opts.state ?? "present",
    p_overwrite: opts.overwrite ?? false,
  });
  if (error) fail("Could not mark the session", error);
  return data as MarkAllResult;
};
