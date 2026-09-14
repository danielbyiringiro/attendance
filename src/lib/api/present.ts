// One session, with the names a screen needs to label it.
//
// Separate from sessions.ts because it serves one page — the presenter tab at
// /present/:sessionId — which starts with nothing but an id in the address bar
// and has no dashboard state to borrow the class and cohort names from.

import { supabase } from "@/lib/supabase";
import type { SessionRow } from "@/lib/api/types";

export interface PresentableSession {
  session: SessionRow;
  className: string;
  cohortLabel: string;
}

/**
 * Null when the session does not exist OR the signed-in account is not on its
 * class.
 *
 * Those two are deliberately indistinguishable. Row-level security scopes
 * class_sessions to members since migration 008, so a non-member's select
 * returns nothing rather than an error, and telling them "that exists but is
 * not yours" would confirm a session id to somebody with no business knowing
 * it.
 */
export const getSessionForPresenting = async (
  sessionId: string,
): Promise<PresentableSession | null> => {
  const { data, error } = await supabase
    .from("class_sessions")
    .select("*, classes(name), cohorts(label)")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the session: ${error.message}`);
  if (!data) return null;

  const row = data as SessionRow & {
    classes: { name: string } | null;
    cohorts: { label: string } | null;
  };
  const { classes, cohorts, ...session } = row;

  return {
    session: session as SessionRow,
    className: classes?.name ?? "",
    cohortLabel: cohorts?.label ?? "?",
  };
};
