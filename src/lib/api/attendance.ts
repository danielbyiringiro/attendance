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
  /**
   * Who decided this, when anybody did.
   *
   * 'system' is close_session filling in an absence for everybody who never
   * marked — a default, not a judgement. Distinguishing it from a 'staff' or
   * 'student' mark is what lets a register know the difference between
   * somebody who was called absent and somebody nobody has looked at yet.
   */
  marked_by_role: "student" | "staff" | "system" | null;
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
    .select("student_id, state, marked_at, marked_by_role")
    .eq("session_id", sessionId);
  if (recordError) fail("Could not load attendance", recordError);

  const byStudent = new Map(
    ((records ?? []) as Array<{
      student_id: string;
      state: AttendanceState;
      marked_at: string;
      marked_by_role: "student" | "staff" | "system";
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
      marked_by_role: record?.marked_by_role ?? null,
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
      // No status filter here, deliberately. A record exists because somebody
      // recorded it, and the session it belongs to is therefore relevant
      // whatever its status says. Filtering scheduled sessions out here meant a
      // register taken by hand before a session was opened — which the
      // dashboard offers, on exactly those sessions — was written to the
      // database and then invisible on every screen that reads it.
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

  /*
   * A scheduled session that somebody has marked has happened.
   *
   * The session query above excludes 'scheduled' on purpose: a class next
   * Tuesday is not a session anyone missed, and counting it would make every
   * future date an absence. But "not opened yet" and "never happened" are not
   * the same thing, and taking the register before opening check-in is an
   * ordinary thing to do.
   *
   * These are recovered from the marks rather than by a second query: the join
   * above already selects every field a session entry needs, so the row is
   * there for the taking.
   */
  const known = new Set(sessions.map((s) => s.session_id));
  markRows.forEach((r) => {
    if (r.class_sessions === null || known.has(r.session_id)) return;
    known.add(r.session_id);
    sessions.push({
      session_id: r.session_id,
      session_date: r.class_sessions.session_date,
      starts_at: r.class_sessions.starts_at,
      cohort_id: r.class_sessions.cohort_id,
      cohort_label: r.class_sessions.cohorts?.label ?? "",
      status: r.class_sessions.status,
      cancellation_reason: r.class_sessions.cancellation_reason,
    });
  });
  sessions.sort((a, b) => b.session_date.localeCompare(a.session_date));

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

// ---------------------------------------------------------------------------
// The attendance rate — one definition
// ---------------------------------------------------------------------------
//
// StudentRoster and attendanceExport each worked this out from the same stored
// states, and they disagreed. The roster counted MARKS, so a session with no
// record simply did not exist for it. The exporter counted SESSIONS and looked
// the state up, so a session with no record landed in its denominator
// contributing nothing.
//
// A session has no record while it is still open. Exporting during a live class
// therefore charged everybody who had not scanned yet with an absence for a
// class that had not finished, while the dashboard beside it said otherwise.
//
// Neither was wrong about arithmetic; they were answering different questions
// because nobody had written the question down. This is the question.

export interface AttendanceTally {
  /** Sessions that applied to the student at all, before any exclusion. */
  sessions: number;
  present: number;
  late: number;
  excused: number;
  absent: number;
  exempted: number;
  /** No record yet — the session is still open. Never counted either way. */
  pending: number;
  /** The denominator. */
  graded: number;
  /** The numerator. */
  attended: number;
  /** attended / graded as a percentage, one decimal place. 0 when graded is 0. */
  rate: number;
}

/**
 * Turn the states of a student's sessions into a rate.
 *
 * One entry per session that applies to them, `null` where no record exists.
 *
 *   present, late      attended, and in the denominator
 *   unexcused          in the denominator only
 *   excused            out of both — a TA decided it should not count
 *   exempted           out of both — the session did not apply to them
 *   null               out of both — the session has not closed yet
 *
 * `mergeExcused` is the one legitimate variation: it reports an excused day as
 * attendance and puts it back in the denominator, which is what a gradebook
 * expecting a raw percentage wants.
 */
export const tallyStates = (
  states: ReadonlyArray<AttendanceState | null>,
  opts: { mergeExcused?: boolean } = {},
): AttendanceTally => {
  const merge = opts.mergeExcused ?? false;

  let present = 0;
  let late = 0;
  let excused = 0;
  let absent = 0;
  let exempted = 0;
  let pending = 0;

  states.forEach((state) => {
    switch (state) {
      case "present":
        present += 1;
        break;
      case "late":
        late += 1;
        break;
      case "excused":
        excused += 1;
        break;
      case "unexcused":
        absent += 1;
        break;
      case "exempted":
        exempted += 1;
        break;
      default:
        // null, or `pending` — no decision has been recorded yet.
        pending += 1;
    }
  });

  const attended = present + late + (merge ? excused : 0);
  const graded = present + late + absent + (merge ? excused : 0);

  return {
    sessions: states.length,
    present,
    late,
    excused,
    absent,
    exempted,
    pending,
    graded,
    attended,
    rate: graded > 0 ? Math.round((attended / graded) * 1000) / 10 : 0,
  };
};

/**
 * The state of every session that applied to one student, oldest first.
 *
 * Driven from the sessions their cohort held, not from the records they have,
 * so a session they never marked is present as `null` rather than absent from
 * the list. Cancelled sessions are dropped: nobody attended a class that did
 * not run, and it should not count against them.
 */
/**
 * Did this session actually happen?
 *
 * Not the same question as "is it cancelled". Migration 036 records a holiday
 * by closing the session and marking every enrolled student `exempted`, which
 * keeps the day visible as a scheduled date that formally did not count. That
 * is the right record, and it leaves a session whose status is 'closed' and at
 * which nobody was present.
 *
 * Counting those as held is wrong in a specific and misleading way: the day is
 * correctly excluded from every student's rate, because exempted sits in
 * neither half of a tally, while the class-wide figure shows a session where
 * nobody turned up. The same screen then says the day did not count and that
 * attendance was zero.
 *
 * So a session is held unless every record against it is exempted. One student
 * exempted among a normal register is an individual exemption and changes
 * nothing; a whole register of them is a day that did not happen.
 *
 * A session with no records at all is held — it may simply not be closed yet.
 */
export const sessionWasHeld = (
  log: AttendanceLog,
  sessionId: string,
): boolean => {
  const session = log.sessionById.get(sessionId);
  if (!session || session.status === "cancelled") return false;

  const marks = log.marks.filter((m) => m.session_id === sessionId);
  if (marks.length === 0) return true;
  return !marks.every((m) => m.state === "exempted");
};

export const sessionStatesFor = (
  log: AttendanceLog,
  studentId: string,
  cohortId: string,
): Array<AttendanceState | null> => {
  const byId = new Map(
    (log.byStudent.get(studentId) ?? []).map((m) => [m.session_id, m.state]),
  );

  return log.sessions
    .filter((s) => s.cohort_id === cohortId && s.status !== "cancelled")
    .sort((a, b) => a.session_date.localeCompare(b.session_date))
    .map((s) => byId.get(s.session_id) ?? null);
};
