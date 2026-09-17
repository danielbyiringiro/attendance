// What staff report from inside the app, and what an admin does with it.
//
// The other direction from announcements (049): those go admin to staff, this
// goes staff to admin. Stored rather than pointed at a form elsewhere — a link
// rots quietly when its owner moves on, and nothing in the app would know.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

/** One report, as an admin reads it. */
export interface FeedbackItem {
  id: string;
  body: string;
  /** Which screen they were on, when the form knew. */
  page: string | null;
  handled: boolean;
  handled_at: string | null;
  created_at: string;
  /** Null once the account has been removed (050). The report stays. */
  from_email: string | null;
  from_name: string | null;
}

/**
 * Send a report. Approved staff only, always as yourself.
 *
 * Not anonymous, deliberately: an admin reading "this is broken" almost always
 * needs to ask which class, and the form says so before it is sent.
 */
export const sendFeedback = async (
  body: string,
  page?: string,
): Promise<{ id: string }> => {
  const { data, error } = await supabase.rpc("send_feedback", {
    p_body: body,
    p_page: page ?? null,
  });
  if (error) fail("Could not send that", error);
  return data as { id: string };
};

/** Every report, unhandled first. Admin only. */
export const adminListFeedback = async (
  handled?: boolean,
): Promise<FeedbackItem[]> => {
  const { data, error } = await supabase.rpc("admin_list_feedback", {
    p_handled: handled ?? null,
  });
  if (error) fail("Could not load the feedback", error);
  return (data ?? []) as FeedbackItem[];
};

/**
 * Mark a report dealt with, or reopen it.
 *
 * Handled is the normal end state rather than deletion: a list that has been
 * worked through should not vanish, or the same report arrives again next term
 * and nobody recognises it.
 */
export const adminSetFeedbackHandled = async (
  id: string,
  handled = true,
): Promise<FeedbackItem> => {
  const { data, error } = await supabase.rpc("admin_set_feedback_handled", {
    p_id: id,
    p_handled: handled,
  });
  if (error) fail("Could not change that", error);
  return data as FeedbackItem;
};

/** For genuine rubbish. Handled is what you want for anything real. */
export const adminDeleteFeedback = async (id: string): Promise<boolean> => {
  const { data, error } = await supabase.rpc("admin_delete_feedback", {
    p_id: id,
  });
  if (error) fail("Could not remove that", error);
  return Boolean(data);
};
