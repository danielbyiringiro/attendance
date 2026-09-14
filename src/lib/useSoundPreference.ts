import { useCallback, useEffect, useState } from "react";
import { primeSound } from "@/lib/checkInSound";

/**
 * Whether this screen beeps for check-ins, remembered on this device.
 *
 * Per screen and per browser, in localStorage, like the theme: a preference
 * about this machine's speakers, not a class setting, and nothing sensitive.
 * On by default — the beep is what was asked for — and muted with one tap.
 *
 * A saved "on" cannot by itself make a browser play sound after a reload; only
 * a tap on the page can (see checkInSound). So while it is on, the first tap or
 * key press anywhere unlocks it, and switching it on is itself such a tap.
 */
const read = (key: string, fallback: boolean): boolean => {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "on") return true;
    if (stored === "off") return false;
  } catch {
    // Private browsing, or storage disabled. Fall through to the default.
  }
  return fallback;
};

export const useSoundPreference = (key: string, fallback = true) => {
  const [enabled, setEnabledState] = useState(() => read(key, fallback));

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      if (next) primeSound();
      try {
        localStorage.setItem(key, next ? "on" : "off");
      } catch {
        // Not being able to remember it is not a reason to refuse the change.
      }
    },
    [key],
  );

  useEffect(() => {
    if (!enabled) return;
    const unlock = () => primeSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enabled]);

  return [enabled, setEnabled] as const;
};
