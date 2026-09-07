// Who you are, and who else is on a class with you.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

export interface StaffIdentity {
  staff_id: string;
  email: string | null;
  display_name: string | null;
}

export interface ClassMember {
  staff_id: string;
  email: string | null;
  display_name: string | null;
  /** True for the signed-in user, so the UI can refuse to remove them silently. */
  is_you: boolean;
  since: string;
}

/**
 * Make sure the signed-in account has a staff row, and return it.
 *
 * Called once after login. Without it a newly provisioned Supabase account
 * cannot create a class: the bootstrap in migration 003 only ever ran over the
 * accounts that existed when it was applied, so anyone added since has no staff
 * row and current_staff_id() resolves to nothing.
 *
 * Idempotent by design — safe to call on every load.
 */
export const ensureStaff = async (
  displayName?: string,
): Promise<StaffIdentity> => {
  const { data, error } = await supabase.rpc("ensure_staff", {
    p_display_name: displayName ?? null,
  });
  if (error) fail("Could not set up your account", error);
  return data as StaffIdentity;
};

export const listClassMembers = async (
  classId: string,
): Promise<ClassMember[]> => {
  const { data, error } = await supabase.rpc("list_class_members", {
    p_class_id: classId,
  });
  if (error) fail("Could not load who is on this class", error);
  return (data ?? []) as ClassMember[];
};

/**
 * Add a colleague by their exact email.
 *
 * Deliberately not "search the staff list": a member can add someone they can
 * name but cannot enumerate every account, which would turn the staff table
 * into a directory of the whole institution.
 *
 * They must have signed in at least once — there is no public signup, so a
 * staff row only exists after a first login.
 */
export const addClassMember = async (
  classId: string,
  email: string,
): Promise<{ staff_id: string; email: string; added: boolean }> => {
  const { data, error } = await supabase.rpc("add_class_member", {
    p_class_id: classId,
    p_email: email,
  });
  if (error) fail("Could not add them", error);
  return data as { staff_id: string; email: string; added: boolean };
};

/**
 * Remove someone from a class. The server refuses to remove the last member —
 * with no admin bypass, a class with nobody on it is reachable only from the
 * SQL editor.
 */
export const removeClassMember = async (
  classId: string,
  staffId: string,
): Promise<{ removed: boolean; remaining: number }> => {
  const { data, error } = await supabase.rpc("remove_class_member", {
    p_class_id: classId,
    p_staff_id: staffId,
  });
  if (error) fail("Could not remove them", error);
  return data as { removed: boolean; remaining: number };
};
