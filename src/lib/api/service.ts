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
  paused: boolean;
  /** What an admin typed when pausing. Null falls back to the app's wording. */
  message: string | null;
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
  return (data ?? { paused: false, message: null, since: null }) as ServiceState;
};

/** Admin only. The server refuses anyone else. */
export const adminSetServicePaused = async (
  paused: boolean,
  message?: string,
): Promise<ServiceState> => {
  const { data, error } = await supabase.rpc("admin_set_service_paused", {
    p_paused: paused,
    p_message: message ?? null,
  });
  if (error) fail(paused ? "Could not pause the app" : "Could not resume", error);
  return data as ServiceState;
};
