/**
 * Where the TA dashboard is, and where a remembered place lands.
 *
 * Classes, Schedule and Class Sessions used to be three sidebar tabs, with
 * setting up one class spread across all three. They became one Class page,
 * and the Weekly pattern tab has now folded into Sessions as well: the pattern
 * and the month it produces are one screen, because the button was on one tab
 * and everything it did was on the other.
 *
 * The last tab is remembered in sessionStorage, so a browser tab left open
 * across either change still holds "sessions", "schedule" or "pattern". All of
 * them have to land somewhere real, not on a blank screen or back at the start.
 */

export type TATab =
  | "attendance"
  | "analytics"
  | "students"
  | "class"
  | "classes"
  | "help"
  | "admin";

export type ClassTab = "sessions" | "settings";

const TABS: readonly string[] = [
  "attendance",
  "analytics",
  "students",
  "class",
  "classes",
  // 049. Listed here as well as in the union, or a browser tab left open on
  // Help would come back to Attendance without saying why.
  "help",
  "admin",
];

const CLASS_TABS: readonly string[] = ["sessions", "settings"];

/**
 * The sidebar tabs that became Class tabs. "classes" kept its name.
 *
 * "schedule" used to land on the Weekly pattern tab. That tab is now part of
 * Sessions, so it lands there — and a stored class tab of "pattern" is simply
 * not in CLASS_TABS any more, which sends it to the same place by the ordinary
 * fallback below.
 */
const MOVED: Record<string, ClassTab> = {
  sessions: "sessions",
  schedule: "sessions",
};

export const restoreNavigation = (
  storedTab: string | null,
  storedClassTab: string | null,
): { tab: TATab; classTab: ClassTab } => {
  const classTab =
    storedClassTab !== null && CLASS_TABS.includes(storedClassTab)
      ? (storedClassTab as ClassTab)
      : "sessions";

  if (storedTab !== null && storedTab in MOVED) {
    return { tab: "class", classTab: MOVED[storedTab] };
  }
  if (storedTab !== null && TABS.includes(storedTab)) {
    return { tab: storedTab as TATab, classTab };
  }
  return { tab: "attendance", classTab };
};
