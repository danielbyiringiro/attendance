// Row and RPC shapes for the class data model introduced by sql/migrations.
//
// Hand-written rather than generated, because the generated Supabase types
// would also describe the legacy tables this work is retiring, and the two sets
// disagree about what a cohort is.

export type SessionStatus = "scheduled" | "open" | "closed" | "cancelled";

export type AttendanceState =
  | "present"
  | "late"
  | "excused"
  | "unexcused"
  | "pending"
  | "exempted";

export type DeliveryMode = "in_person" | "online" | "hybrid";

export type AttendanceMethod =
  | "fixed_code"
  | "rotating_code"
  | "qr"
  | "manual_only";

export type ClassStaffRole = "owner" | "supervisor" | "ta";

export interface ClassRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  term_starts_on: string; // YYYY-MM-DD
  term_ends_on: string;
  timezone: string;
  min_attendance_percentage: number;
  default_method: AttendanceMethod;
  default_delivery_mode: DeliveryMode;
  default_duration_minutes: number;
  default_late_window_minutes: number;
  default_auto_close_minutes: number;
  default_early_open_minutes: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CohortRow {
  id: string;
  class_id: string;
  label: string;
  name: string | null;
  created_at: string;
}

export interface CohortScheduleRow {
  id: string;
  class_id: string;
  cohort_id: string;
  /** 0 = Sunday .. 6 = Saturday, matching Postgres EXTRACT(DOW). */
  weekday: number;
  start_time: string; // HH:MM:SS
  duration_minutes: number | null;
  delivery_mode: DeliveryMode | null;
  effective_from: string | null;
  effective_until: string | null;
}

export interface SessionRow {
  id: string;
  class_id: string;
  cohort_id: string;
  schedule_id: string | null;
  starts_at: string;
  /** Resolved in the class's timezone by a trigger, never derived client-side. */
  session_date: string;
  duration_minutes: number;
  delivery_mode: DeliveryMode;
  status: SessionStatus;
  method: AttendanceMethod;
  pin: string | null;
  late_window_minutes: number;
  auto_close_minutes: number;
  early_open_minutes: number;
  opened_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  /**
   * Moved by hand rather than by the weekly pattern.
   * apply_schedule_to_future leaves these where they are.
   */
  moved_manually: boolean;
}

export interface EnrolmentRow {
  id: string;
  class_id: string;
  cohort_id: string;
  student_id: string;
  enrolled_on: string;
  dropped_on: string | null;
}

export interface AttendanceRecordRow {
  id: string;
  session_id: string;
  class_id: string;
  student_id: string;
  state: AttendanceState;
  marked_at: string;
  marked_by: string | null;
  marked_by_role: "student" | "staff" | "system";
  method_used: AttendanceMethod | null;
}

/** A student with their enrolment in one class, as the roster screens want it. */
export interface EnrolledStudent {
  student_id: string;
  name: string | null;
  cohort_id: string;
  cohort_label: string;
  enrolled_on: string;
  dropped_on: string | null;
}

// ---------------------------------------------------------------------------
// RPC returns
// ---------------------------------------------------------------------------

export interface CreateClassResult {
  class_id: string;
  cohorts: Array<{ id: string; label: string }>;
}

export interface OpenSessionResult {
  session_id: string;
  pin: string;
  opened_at: string;
  closes_at: string;
}

export interface ClassDeletionPreview {
  class_id: string;
  code: string;
  name: string;
  cohorts: number;
  enrolments: number;
  sessions: number;
  attendance_records: number;
  /** Students whose only enrolment is this class. They are never deleted. */
  students_left_orphaned: number;
}

export interface UpsertEnrolmentsResult {
  created_students: number;
  reused_students: number;
  enrolled: number;
  already_enrolled: number;
  moved: number;
  /** Already in a different cohort of this class; not moved unless asked. */
  in_other_cohort: Array<{ student_id: string; current_cohort: string }>;
  invalid: Array<{ row: number; reason: string }>;
}

/** What a class the signed-in user can reach looks like, with its cohorts. */
export interface ClassWithCohorts extends ClassRow {
  cohorts: CohortRow[];
}
