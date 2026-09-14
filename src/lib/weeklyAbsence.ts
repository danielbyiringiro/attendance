/**
 * Who goes in a week's block of the Weekly Absences report.
 *
 * The report is pasted into the faculty spreadsheet, and only students absent
 * at least some number of times in the week belong in it. That number was a
 * literal 2 in the dashboard, in three places that had to agree: the rows, the
 * count on each week, and the message when nobody qualifies. It is a class
 * setting now (migration 043), and this is the one place the rule is applied.
 */

/** What every class starts at, and what the report used before 043. */
export const DEFAULT_WEEKLY_ABSENCE_THRESHOLD = 2;

/** Must match the CHECK constraint and set_weekly_absence_threshold in 043. */
export const MIN_WEEKLY_ABSENCE_THRESHOLD = 1;
export const MAX_WEEKLY_ABSENCE_THRESHOLD = 10;

/** Only what the rule reads, so the dashboard's own row type can be passed. */
export interface CountedAbsence {
  cohort: string;
  /** Absences in the week. */
  frequency: number;
}

/** The students a week reports, for one cohort or "all". */
export const reportableAbsences = <T extends CountedAbsence>(
  absences: T[],
  threshold: number,
  cohortFilter: string,
): T[] =>
  absences.filter(
    (a) =>
      a.frequency >= threshold &&
      (cohortFilter === "all" || a.cohort === cohortFilter),
  );

/** "once or more", "twice or more", "3 times or more". */
export const thresholdPhrase = (threshold: number): string =>
  threshold === 1
    ? "once or more"
    : threshold === 2
      ? "twice or more"
      : `${threshold} times or more`;
