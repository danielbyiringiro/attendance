// Is the app paused right now? (055)
//
// Polled rather than read once. A student can sit on the check-in page for an
// hour, and a pause set while they sit there has to reach them — otherwise the
// first they know is a refusal they cannot explain. A minute is often enough:
// the server refuses regardless, so this only decides how quickly the screen
// agrees with it.

import { useEffect, useState } from "react";
import { getServiceState, type ServiceState } from "@/lib/api/service";

const EVERY_MS = 60_000;

const RUNNING: ServiceState = { paused: false, message: null, since: null };

export const useServiceState = (): ServiceState => {
  const [state, setState] = useState<ServiceState>(RUNNING);

  useEffect(() => {
    let live = true;

    const check = () =>
      getServiceState()
        .then((s) => {
          if (live) setState(s);
        })
        .catch(() => {
          // Unreachable is not the same as paused. A network blip must not put
          // a "we are paused" notice in front of a student who could have
          // checked in — the server is the one that decides, and it will say
          // so if they try.
        });

    void check();
    const timer = setInterval(() => void check(), EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return state;
};
