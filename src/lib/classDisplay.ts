/**
 * The class display: a link and a code that put a class's check-in on a screen
 * nobody is signed in to. See migration 041.
 *
 * Pure helpers, kept out of the page so `npm run test:attendance` can pin them.
 * The code normalisation in particular has a twin in get_class_display, and the
 * two have to agree or a correctly typed code is refused.
 */

import { sessionWindow, type SessionWindowInput } from "@/lib/sessionWindow";

/** What get_class_display returns for each session. */
export interface DisplaySession extends SessionWindowInput {
  id: string;
  cohort_label: string;
  /** Only ever set while the session is open. */
  pin: string | null;
}

export const DISPLAY_CODE_LENGTH = 6;

/** The page a second screen opens. */
export const displayUrl = (origin: string, token: string): string =>
  `${origin.replace(/\/+$/, "")}/display/${encodeURIComponent(token)}`;

/**
 * A code as typed, reduced to what is compared.
 *
 * Strips everything but letters and digits, THEN uppercases — the same order
 * as get_class_display's upper(regexp_replace(...)). The other order is not
 * equivalent: JavaScript uppercases "ß" to "SS", which would then survive.
 */
export const normalizeDisplayCode = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export type DisplayPick =
  /** Open, or opened and about to accept marks. Everything in this state. */
  | { kind: "active"; sessions: DisplaySession[] }
  /** Nothing running; the soonest session still to open today. */
  | { kind: "upcoming"; session: DisplaySession }
  /** Nothing running and nothing left today. */
  | { kind: "idle" };

/**
 * What a screen left up all day should be showing right now.
 *
 * Running sessions win, all of them: two cohorts checking in at once is two
 * codes, and hiding one strands that room. Otherwise the next session today
 * that could still open, so the screen counts down to it. A session whose
 * status still says open but whose window has passed is not running — the
 * sweep has simply not closed it yet — and neither is one the sweep will no
 * longer open.
 */
export const pickDisplay = (
  sessions: DisplaySession[],
  now: Date = new Date(),
): DisplayPick => {
  const byStart = [...sessions].sort(
    (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
  );

  const active = byStart.filter((s) => {
    const phase = sessionWindow(s, now).phase;
    return phase === "opens_soon" || phase === "live" || phase === "live_late";
  });
  if (active.length > 0) return { kind: "active", sessions: active };

  const upcoming = byStart.find((s) => {
    const w = sessionWindow(s, now);
    return w.phase === "not_opened" && !w.autoOpenMissed;
  });
  if (upcoming) return { kind: "upcoming", session: upcoming };

  return { kind: "idle" };
};
