import { useEffect, useState } from "react";

/**
 * A clock that ticks, so a countdown counts down.
 *
 * Everything on the TA dashboard was rendered once, when the data loaded. That
 * is fine for a roster and useless for "closes in 4m 20s" — the figure was
 * right at the moment of the fetch and progressively more wrong afterwards. One
 * second is the right interval because the value is shown to the second.
 *
 * `enabled` turns it off when nothing on screen is counting, so a dashboard
 * left open overnight on another tab is not re-rendering every second until
 * morning.
 */
export const useNow = (enabled: boolean, everyMs = 1000): Date => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [enabled, everyMs]);

  return now;
};
