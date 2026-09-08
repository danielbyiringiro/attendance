// Who you are, and who else is on a class with you.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

/** Everything the app needs to know about who is signed in. */
export interface StaffIdentity {
  /** Null when the address is outside the allowed domains — no row was made. */
  staff_id: string | null;
  email: string | null;
  display_name: string | null;
  /**
   * `pending` until an admin decides; `domain_not_allowed` when the address
   * could sign up with Supabase but is not one this installation accepts.
   */
  status: "pending" | "approved" | "rejected" | "domain_not_allowed";
  is_admin: boolean;
  /** Why they were turned down, when an admin left a reason. */
  decision_note?: string | null;
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
 * Make sure the signed-in account has a staff row, and return its state.
 *
 * Called on every load, and idempotent by design. Since migration 020 it also
 * decides what the account is allowed to be: an address outside the allowed
 * domains gets no row at all, and a new one starts `pending` and can do
 * nothing until an admin approves it.
 *
 * It returns the refusal rather than raising, so a person who has done nothing
 * wrong sees "waiting for approval" instead of an error.
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
 * Remove someone from a class.
 *
 * The server refuses two things. The last member, because with no admin bypass
 * a class nobody is on is reachable only from the SQL editor. And the caller
 * themselves, unless `confirmSelf` says so — the members list reorders as it
 * loads, so aiming at a collaborator and hitting your own row is a mis-click
 * away, and only another member could give the access back.
 */
export const removeClassMember = async (
  classId: string,
  staffId: string,
  opts: { confirmSelf?: boolean } = {},
): Promise<{ removed: boolean; remaining: number; was_self: boolean }> => {
  const { data, error } = await supabase.rpc("remove_class_member", {
    p_class_id: classId,
    p_staff_id: staffId,
    p_confirm_self: opts.confirmSelf ?? false,
  });
  if (error) fail("Could not remove them", error);
  return data as { removed: boolean; remaining: number; was_self: boolean };
};

export interface AddableStaff {
  staff_id: string;
  email: string | null;
  display_name: string | null;
}

/**
 * Search people you could add to a class.
 *
 * Scoped to those you already share a class with, and never the whole staff
 * table: search over every account would be the institution directory that
 * migration 008 deliberately refused to build. Anyone outside that circle is
 * still reachable by typing their full email, which reveals nothing the caller
 * did not already know.
 *
 * Already-added members are excluded — they belong in the list, not the picker.
 */
export const searchAddableStaff = async (
  classId: string,
  query: string,
): Promise<AddableStaff[]> => {
  const { data, error } = await supabase.rpc("search_addable_staff", {
    p_class_id: classId,
    p_query: query,
  });
  if (error) fail("Could not search", error);
  return (data ?? []) as AddableStaff[];
};

/** Add someone picked from the search. Held to the same circle rule. */
export const addClassMemberById = async (
  classId: string,
  staffId: string,
): Promise<{ staff_id: string; email: string; added: boolean }> => {
  const { data, error } = await supabase.rpc("add_class_member_by_id", {
    p_class_id: classId,
    p_staff_id: staffId,
  });
  if (error) fail("Could not add them", error);
  return data as { staff_id: string; email: string; added: boolean };
};

// ---------------------------------------------------------------------------
// Admin
//
// These all go through admin_ RPCs rather than reading `staff` directly,
// because RLS on that table is shares_a_class_with() — an admin shares no class
// with somebody who has never been approved, so a plain select returns nothing.
// The admin_ functions are SECURITY DEFINER for exactly that reason.
//
// None of them reads a roster, a session or an attendance record. Admin is for
// approving accounts and repairing class membership; it is deliberately not a
// way into a class's data.
// ---------------------------------------------------------------------------

export interface StaffAccount {
  staff_id: string;
  email: string | null;
  display_name: string | null;
  status: "pending" | "approved" | "rejected";
  is_admin: boolean;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  /** How many classes they are on — not which. */
  classes: number;
}

export const adminListStaff = async (
  status?: "pending" | "approved" | "rejected",
): Promise<StaffAccount[]> => {
  const { data, error } = await supabase.rpc("admin_list_staff", {
    p_status: status ?? null,
  });
  if (error) fail("Could not load accounts", error);
  return (data ?? []) as StaffAccount[];
};

export const adminDecideStaff = async (
  staffId: string,
  approve: boolean,
  note?: string,
): Promise<{ staff_id: string; email: string; status: string }> => {
  const { data, error } = await supabase.rpc("admin_decide_staff", {
    p_staff_id: staffId,
    p_approve: approve,
    p_note: note ?? null,
  });
  if (error) fail(approve ? "Could not approve" : "Could not reject", error);
  return data as { staff_id: string; email: string; status: string };
};

/** The server refuses to demote the last admin — nobody could approve anyone. */
export const adminSetAdmin = async (
  staffId: string,
  isAdmin: boolean,
): Promise<{ staff_id: string; email: string; is_admin: boolean }> => {
  const { data, error } = await supabase.rpc("admin_set_admin", {
    p_staff_id: staffId,
    p_is_admin: isAdmin,
  });
  if (error) fail("Could not change that", error);
  return data as { staff_id: string; email: string; is_admin: boolean };
};

export interface AllowedDomain {
  domain: string;
  created_at: string;
}

/** Readable by anyone signed in, so the signup screen can say what is accepted. */
export const listAllowedDomains = async (): Promise<AllowedDomain[]> => {
  const { data, error } = await supabase
    .from("allowed_email_domains")
    .select("domain, created_at")
    .order("domain");
  if (error) fail("Could not load the allowed domains", error);
  return (data ?? []) as AllowedDomain[];
};

export const adminSetDomain = async (
  domain: string,
  allow: boolean,
): Promise<{ domain: string; allowed: boolean }> => {
  const { data, error } = await supabase.rpc("admin_set_domain", {
    p_domain: domain,
    p_allow: allow,
  });
  if (error) fail("Could not change the domain list", error);
  return data as { domain: string; allowed: boolean };
};

export interface AdminClassRow {
  class_id: string;
  code: string;
  name: string;
  archived: boolean;
  /** Zero means nobody can reach it — the reason this screen exists. */
  members: number;
  enrolments: number;
}

export const adminListClasses = async (): Promise<AdminClassRow[]> => {
  const { data, error } = await supabase.rpc("admin_list_classes");
  if (error) fail("Could not load classes", error);
  return (data ?? []) as AdminClassRow[];
};

export const adminListClassMembers = async (
  classId: string,
): Promise<ClassMember[]> => {
  const { data, error } = await supabase.rpc("admin_list_class_members", {
    p_class_id: classId,
  });
  if (error) fail("Could not load who is on that class", error);
  return (data ?? []) as ClassMember[];
};

/** Put somebody back on a class they lost, or take them off. */
export const adminSetClassMember = async (
  classId: string,
  email: string,
  member: boolean,
): Promise<{ email: string; member: boolean }> => {
  const { data, error } = await supabase.rpc("admin_set_class_member", {
    p_class_id: classId,
    p_email: email,
    p_member: member,
  });
  if (error) fail("Could not change that", error);
  return data as { email: string; member: boolean };
};

/** Requires the class code typed exactly, the same as the owner's own delete. */
export const adminDeleteClass = async (
  classId: string,
  confirmCode: string,
): Promise<{ deleted: boolean; code: string }> => {
  const { data, error } = await supabase.rpc("admin_delete_class", {
    p_class_id: classId,
    p_confirm_code: confirmCode,
  });
  if (error) fail("Could not delete the class", error);
  return data as { deleted: boolean; code: string };
};
