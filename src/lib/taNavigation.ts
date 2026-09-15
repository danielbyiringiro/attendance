/**
 * Where the TA dashboard is, and where a remembered place lands.
 *
 * Classes, Schedule and Class Sessions used to be three sidebar tabs, with
 * setting up one class spread across all three. They are now one Class page
 * with Sessions, Weekly pattern and Settings tabs, and the list of every class
 * opens from "All classes…" in the class switcher.
 *
 * The last tab is remembered in sessionStorage, so a browser tab left open
 * across the change still holds "sessions" or "schedule". Those have to land on
 * the matching Class tab, not on a blank screen or back at the start.
 */

export type TATab =
  | "attendance"
  | "analytics"
  | "students"
  | "class"
  | "classes"
  | "admin";

export type ClassTab = "sessions" | "pattern" | "settings";

const TABS: readonly string[] = [
  "attendance",
  "analytics",
  "students",
  "class",
  "classes",
  "admin",
];

const CLASS_TABS: readonly string[] = ["sessions", "pattern", "settings"];

/** The sidebar tabs that became Class tabs. "classes" kept its name. */
const MOVED: Record<string, ClassTab> = {
  sessions: "sessions",
  schedule: "pattern",
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
