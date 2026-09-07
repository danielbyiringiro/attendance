// Calendar dates, in one place.
//
// There were four definitions of "turn a Date into YYYY-MM-DD" across the app
// and they did not agree: two used toISOString(), which is UTC, under a comment
// claiming they were local. West of Greenwich that names yesterday for anything
// before midnight UTC, so the same click produced a different date depending on
// which screen handled it.
//
// A session's own date is never computed here — it is resolved once, in the
// class's timezone, by a database trigger, and read off the row. These helpers
// are for the browser's side of things: what the user picked in a date picker,
// and which week to group by.

/** YYYY-MM-DD as the viewer's own calendar sees it. */
export const toDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;

/** Today, as YYYY-MM-DD. */
export const todayStr = (): string => toDateStr(new Date());

/**
 * Parse YYYY-MM-DD as local midnight.
 *
 * `new Date("2026-05-19")` is parsed as UTC midnight by the spec, so formatting
 * it back can name the 18th. Appending the time forces local.
 */
export const fromDateStr = (s: string): Date => new Date(`${s}T00:00:00`);

export const addDays = (d: Date, days: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
};

/** YYYY-MM-DD `days` from today. Negative goes back. */
export const shiftDaysStr = (days: number): string =>
  toDateStr(addDays(new Date(), days));

/** Monday of the week containing `d`, at local midnight. */
export const mondayOf = (d: Date): Date => {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = start.getDay(); // 0 = Sunday
  return addDays(start, day === 0 ? -6 : 1 - day);
};

/** Monday of the week containing a YYYY-MM-DD, as YYYY-MM-DD. */
export const weekKeyOf = (dateStr: string): string =>
  toDateStr(mondayOf(fromDateStr(dateStr)));
