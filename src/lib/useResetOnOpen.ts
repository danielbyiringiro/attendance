import { useLayoutEffect, useRef } from "react";

/**
 * Run `reset` each time a dialog opens, or opens on something different.
 *
 * WHY THIS EXISTS
 *
 * Most dialogs here are always mounted and only hidden when closed, so their
 * state outlives the close. Open a day on the calendar, go to "Set as a day
 * off", close without saving, open another day — and it was still on the day-off
 * form, for the wrong date. The student record was worse: an edit started and
 * abandoned on one student was still sitting there, holding their name and ID,
 * when the next student opened, one Save away from being written onto them.
 *
 * HOW TO USE IT
 *
 * `target` is what the dialog is about while open — a date, a session id, a
 * student id, or `true` for a plain open flag — and null, undefined or false
 * while it is shut. `reset` puts the dialog back on its first page and clears
 * drafts; it should not touch settings a person expects to keep between uses.
 *
 * Pass an id, not an object: a realtime refresh hands the dialog a new object
 * for the same session or student, and that must not wipe what somebody is in
 * the middle of doing.
 *
 * A layout effect, so the reset lands before the browser paints and the old
 * page never flashes on the way to the new one.
 */
export const useResetOnOpen = (
  target: string | number | boolean | null | undefined,
  reset: () => void,
) => {
  // The latest reset, without making it a dependency: an inline function is a
  // new value every render, and resetting on every render would lose all input.
  const resetRef = useRef(reset);
  resetRef.current = reset;

  useLayoutEffect(() => {
    if (target === null || target === undefined || target === false) return;
    resetRef.current();
  }, [target]);
};
