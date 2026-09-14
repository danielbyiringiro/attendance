// The class display link: a URL and a code that put a class's live check-in on
// a screen nobody is signed in to. See migration 041.

import { supabase } from "@/lib/supabase";
import type { DisplaySession } from "@/lib/classDisplay";

export interface DisplayLink {
  class_id: string;
  token: string;
  access_code: string;
  failed_attempts: number;
  created_at: string;
  code_set_at: string;
}

/** Wrong codes before the link refuses everything. Must match 041. */
export const DISPLAY_MAX_ATTEMPTS = 10;

/** The class's link, or null when none has been issued. Staff on the class only. */
export const getDisplayLink = async (
  classId: string,
): Promise<DisplayLink | null> => {
  const { data, error } = await supabase
    .from("class_display_links")
    .select("*")
    .eq("class_id", classId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the display link: ${error.message}`);
  return (data as DisplayLink | null) ?? null;
};

/**
 * Create the link, or replace the code on the existing one.
 *
 * Replacing keeps the URL, clears a lock, and signs out every screen using the
 * old code.
 */
export const issueDisplayCode = async (classId: string): Promise<void> => {
  const { error } = await supabase.rpc("issue_display_code", {
    p_class_id: classId,
  });
  if (error) throw new Error(`Could not issue a code: ${error.message}`);
};

/** Turn the link off for good. A later code comes with a new URL. */
export const revokeDisplayLink = async (classId: string): Promise<void> => {
  const { error } = await supabase.rpc("revoke_display_link", {
    p_class_id: classId,
  });
  if (error) throw new Error(`Could not turn off the link: ${error.message}`);
};

export type ClassDisplayResult =
  | {
      ok: true;
      class_name: string;
      class_code: string;
      timezone: string;
      sessions: DisplaySession[];
      next: { starts_at: string; cohort_label: string } | null;
    }
  | {
      ok: false;
      /**
       * "refused" covers a wrong code, a link that does not exist and one that
       * was turned off, deliberately without saying which.
       */
      reason: "refused" | "locked";
    };

/** For the signed-out screen. Throws only when the request itself fails. */
export const getClassDisplay = async (
  token: string,
  code: string,
): Promise<ClassDisplayResult> => {
  const { data, error } = await supabase.rpc("get_class_display", {
    p_token: token,
    p_code: code,
  });
  if (error) throw new Error(`Could not load the display: ${error.message}`);
  return data as ClassDisplayResult;
};
