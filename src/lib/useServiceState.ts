// Is the app paused right now? (055, 056, 058)
//
// Three ways of finding out, because each covers what the others miss:
//
//   streamed   signed-in staff get the change pushed the moment it is made
//              (058 puts the switch in the same realtime publication the
//              dashboard already uses). This is what greys a screen at once
//              instead of at the next poll.
//   on return  every tab asks again when it is looked at, focused, or comes
//              back online. A laptop asleep through the pause has a stale
//              screen the instant it wakes, and no stream reaches a socket
//              that was not connected.
//   on a timer a quiet backstop, and the only route for the student page,
//              which is anonymous and therefore never streamed: 027 holds that
//              no table in public is readable by a visitor, and a stream is a
//              read.
//
// An unreachable server is never treated as paused. A network blip must not
// put a notice in front of somebody who could have checked in; the server
// refuses anyway, and it is the one that decides.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getServiceState, type ServiceState } from "@/lib/api/service";

/** The backstop. Short enough that a student at the door is not stale. */
const EVERY_MS = 20_000;

const RUNNING: ServiceState = {
  state: "running",
  paused: false,
  message: null,
  starts_at: null,
  ends_at: null,
  since: null,
};

export const useServiceState = (enabled = true): ServiceState => {
  const [state, setState] = useState<ServiceState>(RUNNING);

  const check = useCallback(() => {
    if (!enabled) return;
    void getServiceState()
      .then(setState)
      .catch(() => {
        // See the header: unreachable is not paused.
      });
  }, [enabled]);

  useEffect(() => {
    // A component handed the state by its parent passes false, so one screen
    // asks once rather than every component asking for the same answer.
    if (!enabled) return;

    check();
    const timer = setInterval(check, EVERY_MS);

    // Looked at again: a tab that sat in the background through the whole
    // pause is the one most likely to be showing a lie.
    const onWake = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);

    // 058. Pushed, for anyone signed in. A student's page is anonymous and
    // cannot read the table, so its subscription simply never delivers and the
    // timer above is what carries it.
    const channel = supabase
      .channel("service-state")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "service_state" },
        // The changed row arrives with the event, but it is not the answer:
        // `paused` in the table means "set", while the app means "set AND
        // started" (056). Ask the function, which knows the difference.
        () => check(),
      )
      .subscribe();

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      void supabase.removeChannel(channel);
    };
  }, [enabled, check]);

  return state;
};
