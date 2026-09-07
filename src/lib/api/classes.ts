// Classes, cohorts and schedules.
//
// Writes go through the SECURITY DEFINER RPCs from migrations 003 and 007
// rather than direct table access. That is not ceremony: a non-admin doing
// `insert(...).select()` on classes fails, because Postgres applies the SELECT
// policy to the returned row and the class_staff row it looks for does not
// exist until an AFTER trigger has run.

import { supabase } from "@/lib/supabase";
import type {
  ClassDeletionPreview,
  ClassRow,
  ClassWithCohorts,
  CohortRow,
  CohortScheduleRow,
  CreateClassResult,
} from "@/lib/api/types";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

/**
 * Classes the signed-in user is on. RLS does the filtering, so this is a plain
 * select: since migration 008 there is no admin bypass, and membership in
 * class_staff is the only thing that makes a class visible.
 */
export const listClasses = async (
  includeArchived = false,
): Promise<ClassWithCohorts[]> => {
  let query = supabase
    .from("classes")
    .select("*, cohorts(*)")
    .order("created_at", { ascending: false });

  if (!includeArchived) query = query.is("archived_at", null);

  const { data, error } = await query;
  if (error) fail("Could not load classes", error);

  return ((data ?? []) as ClassWithCohorts[]).map((c) => ({
    ...c,
    // Postgres returns the embedded rows unordered; the UI shows them as a list.
    cohorts: [...(c.cohorts ?? [])].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    ),
  }));
};

export const getClass = async (classId: string): Promise<ClassWithCohorts | null> => {
  const { data, error } = await supabase
    .from("classes")
    .select("*, cohorts(*)")
    .eq("id", classId)
    .maybeSingle();
  if (error) fail("Could not load the class", error);
  if (!data) return null;

  const row = data as ClassWithCohorts;
  return {
    ...row,
    cohorts: [...(row.cohorts ?? [])].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    ),
  };
};

export interface CreateClassInput {
  code: string;
  name: string;
  termStartsOn: string;
  termEndsOn: string;
  timezone?: string;
  /** Ignored when cohortLabels is given. 1–26. */
  cohortCount?: number;
  cohortLabels?: string[];
}

export const createClass = async (
  input: CreateClassInput,
): Promise<CreateClassResult> => {
  const { data, error } = await supabase.rpc("create_class", {
    p_code: input.code,
    p_name: input.name,
    p_term_starts_on: input.termStartsOn,
    p_term_ends_on: input.termEndsOn,
    p_timezone: input.timezone ?? "Africa/Accra",
    p_cohort_count: input.cohortCount ?? 1,
    p_cohort_labels: input.cohortLabels ?? null,
  });
  if (error) fail("Could not create the class", error);
  return data as CreateClassResult;
};

/** Only the fields you pass are changed; everything else is left alone. */
export interface UpdateClassInput {
  name?: string;
  description?: string;
  termStartsOn?: string;
  termEndsOn?: string;
  timezone?: string;
  minAttendancePercentage?: number;
  defaultDurationMinutes?: number;
  defaultLateWindowMinutes?: number;
  defaultAutoCloseMinutes?: number;
}

export const updateClass = async (
  classId: string,
  input: UpdateClassInput,
): Promise<ClassRow> => {
  const { data, error } = await supabase.rpc("update_class", {
    p_class_id: classId,
    p_name: input.name ?? null,
    p_description: input.description ?? null,
    p_term_starts_on: input.termStartsOn ?? null,
    p_term_ends_on: input.termEndsOn ?? null,
    p_timezone: input.timezone ?? null,
    p_min_attendance_percentage: input.minAttendancePercentage ?? null,
    p_default_duration_minutes: input.defaultDurationMinutes ?? null,
    p_default_late_window_minutes: input.defaultLateWindowMinutes ?? null,
    p_default_auto_close_minutes: input.defaultAutoCloseMinutes ?? null,
  });
  if (error) fail("Could not update the class", error);
  return data as ClassRow;
};

export const addCohort = async (
  classId: string,
  label: string,
): Promise<{ cohort_id: string; label: string }> => {
  const { data, error } = await supabase.rpc("add_cohort", {
    p_class_id: classId,
    p_label: label,
  });
  if (error) fail("Could not add the cohort", error);
  return data as { cohort_id: string; label: string };
};

export const listCohorts = async (classId: string): Promise<CohortRow[]> => {
  const { data, error } = await supabase
    .from("cohorts")
    .select("*")
    .eq("class_id", classId)
    .order("label");
  if (error) fail("Could not load cohorts", error);
  return (data ?? []) as CohortRow[];
};

export const listSchedules = async (
  classId: string,
): Promise<CohortScheduleRow[]> => {
  const { data, error } = await supabase
    .from("cohort_schedules")
    .select("*")
    .eq("class_id", classId)
    .order("weekday")
    .order("start_time");
  if (error) fail("Could not load the schedule", error);
  return (data ?? []) as CohortScheduleRow[];
};

/** One weekday a cohort meets, with its own time. */
export interface ScheduleSlot {
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number;
  /** "HH:MM". */
  startTime: string;
  /** Omit to inherit the class default at generation time. */
  durationMinutes?: number;
}

/**
 * Replace the meeting pattern for one or more cohorts of a single class.
 *
 * Each slot carries its own time, so a cohort can meet Tuesday at 09:00 and
 * Thursday at 14:00 — the previous shape applied one time to every weekday and
 * could not say that.
 *
 * Server-side and atomic, and it validates every slot BEFORE deleting anything,
 * so a typo cannot wipe a schedule and then fail. Returns how many slots were
 * written across all the cohorts given.
 */
export const setCohortSchedules = async (
  cohortIds: string[],
  slots: ScheduleSlot[],
): Promise<number> => {
  const { data, error } = await supabase.rpc("set_cohort_schedules", {
    p_cohort_ids: cohortIds,
    p_slots: slots.map((s) => ({
      weekday: s.weekday,
      start_time: s.startTime,
      duration_minutes: s.durationMinutes ?? null,
    })),
  });
  if (error) fail("Could not save the schedule", error);
  return (data as number) ?? 0;
};

export const archiveClass = async (
  classId: string,
  archived = true,
): Promise<ClassRow> => {
  const { data, error } = await supabase.rpc("archive_class", {
    p_class_id: classId,
    p_archived: archived,
  });
  if (error) fail("Could not archive the class", error);
  return data as ClassRow;
};

/** What a deletion would destroy. Always show this before offering to do it. */
export const previewClassDeletion = async (
  classId: string,
): Promise<ClassDeletionPreview> => {
  const { data, error } = await supabase.rpc("preview_class_deletion", {
    p_class_id: classId,
  });
  if (error) fail("Could not preview the deletion", error);
  return data as ClassDeletionPreview;
};

/**
 * Irreversible. `confirmCode` must equal the class's own code — the server
 * checks, so a UI bug cannot delete a class by passing a stray `true`.
 * Students are never deleted.
 */
export const deleteClass = async (
  classId: string,
  confirmCode: string,
): Promise<{ deleted: boolean; summary: ClassDeletionPreview }> => {
  const { data, error } = await supabase.rpc("delete_class", {
    p_class_id: classId,
    p_confirm_code: confirmCode,
  });
  if (error) fail("Could not delete the class", error);
  return data as { deleted: boolean; summary: ClassDeletionPreview };
};
