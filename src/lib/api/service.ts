// Whether the app is paused, and the switch that pauses it (055).
//
// A pause stops the term's record changing: no check-ins, no marks, no session
// or roster edits. It is enforced in the database, on the tables themselves, so
// this file is only about saying so — a browser left open on the check-in page
// cannot get round it by not asking.

import { supabase } from "@/lib/supabase";

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? "unknown error"}`);
};

export interface ServiceState {
  /**
   * running   nothing set
   * scheduled set for a time that has not arrived — a warning, not an outage
   * paused    in force now
   */
  state: "running" | "scheduled" | "paused";
  /** The effective answer: set AND started. False while merely scheduled. */
  paused: boolean;
  /** What an admin typed. Null falls back to the app's own wording. */
  message: string | null;
  /** When it takes (or took) effect. Null means it started immediately. */
  starts_at: string | null;
  /** When people are told to expect it back. Advisory: nothing auto-resumes. */
  ends_at: string | null;
  /** When it was last switched, either way. */
  since: string | null;
}

/**
 * Answered for anyone, signed in or not.
 *
 * A student who cannot check in is exactly the person who needs to be told
 * why, and they have no account.
 */
export const getServiceState = async (): Promise<ServiceState> => {
  const { data, error } = await supabase.rpc("get_service_state");
  if (error) fail("Could not check whether the app is paused", error);
  return (data ?? {
    state: "running",
    paused: false,
    message: null,
    starts_at: null,
    ends_at: null,
    since: null,
  }) as ServiceState;
};

/**
 * Pause now, schedule one, or resume. Admin only — the server refuses anyone
 * else.
 *
 * With `startsAt` in the future nothing is stopped until it arrives; the app
 * only warns. `endsAt` is what people are told to expect and resumes nothing:
 * work overruns, and an app that un-paused itself mid-copy would take check-ins
 * into a database about to be replaced.
 */
export const adminSetServicePaused = async (
  paused: boolean,
  message?: string,
  startsAt?: string,
  endsAt?: string,
): Promise<ServiceState> => {
  const { data, error } = await supabase.rpc("admin_set_service_paused", {
    p_paused: paused,
    p_message: message ?? null,
    p_starts_at: startsAt ?? null,
    p_ends_at: endsAt ?? null,
  });
  if (error) fail(paused ? "Could not pause the app" : "Could not resume", error);
  return data as ServiceState;
};
