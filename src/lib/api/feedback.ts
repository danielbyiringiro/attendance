// What staff report from inside the app, and what an admin does with it.
//
// The other direction from announcements (049): those go admin to staff, this
// goes staff to admin. Stored rather than pointed at a form elsewhere — a link
// rots quietly when its owner moves on, and nothing in the app would know.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

/**
 * What a report is about (059).
 *
 * Two, not a longer list: a third bucket is where everything lands the moment
 * somebody is unsure, and a queue that is mostly "other" sorts no better than
 * one with no kinds at all.
 */
export type FeedbackKind = "bug" | "idea";

/** One report, as an admin reads it. */
export interface FeedbackItem {
  id: string;
  body: string;
  kind: FeedbackKind;
  /**
   * Sent without a name (059). The row genuinely has no staff_id — so this is
   * NOT the same as `from_name` being null, which also happens when the
   * account was removed afterwards (050).
   */
  anonymous: boolean;
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
 * Send a report. Approved staff only.
 *
 * Signed by default, because an admin reading "this is broken" almost always
 * needs to ask which class. `anonymous` drops the name for the cases where
 * being named is what stops somebody sending at all — and it drops it for
 * real: the server never writes a staff_id, so this cannot be undone or looked
 * up later, not even by us. The form says so in those words.
 */
export const sendFeedback = async (
  body: string,
  opts: { page?: string; kind?: FeedbackKind; anonymous?: boolean } = {},
): Promise<{ id: string }> => {
  const { data, error } = await supabase.rpc("send_feedback", {
    p_body: body,
    p_page: opts.page ?? null,
    p_kind: opts.kind ?? "bug",
    p_anonymous: opts.anonymous ?? false,
  });
  if (error) fail("Could not send that", error);
  return data as { id: string };
};

/**
 * Every report, unhandled first and faults before wishes. Admin only.
 *
 * The kind filter is here for a caller that wants one bucket without the rest;
 * the queue screen loads everything and splits it in the browser, because it
 * shows a count beside each tab and a count needs the other bucket anyway.
 */
export const adminListFeedback = async (
  handled?: boolean,
  kind?: FeedbackKind,
): Promise<FeedbackItem[]> => {
  const { data, error } = await supabase.rpc("admin_list_feedback", {
    p_handled: handled ?? null,
    p_kind: kind ?? null,
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
