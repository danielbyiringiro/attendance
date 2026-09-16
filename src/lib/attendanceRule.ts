/**
 * What a class requires, and whether a student has met it.
 *
 * A class is run one of two ways (migration 046): it requires a percentage, or
 * it allows a number of absences. The same question — is this student short? —
 * is asked on the roster, in the student record a TA opens, and on the
 * student's own history page, and all three used to compare a rate against a
 * percentage inline. One rule lives here so they cannot drift apart, and so
 * the words a student reads are the words their TA reads.
 *
 * Only unexcused absences count against an allowance. An excused absence and
 * an exemption already sit outside the rate everywhere else, so counting them
 * here would have the app saying two different things.
 *
 * Pure, so `npm run test:attendance` can pin every band and every phrase.
 */

export type AttendanceRule = "percentage" | "absences";

/** What one class requires. Both numbers are always set; the rule picks one. */
export interface ClassRequirement {
  rule: AttendanceRule;
  /** Under "percentage": the rate a student must reach. */
  minPercentage: number;
  /** Under "absences": how many unexcused absences are allowed. */
  maxAbsences: number;
}

/** A student's totals, as far as the requirement is concerned. */
export interface StudentStandingInput {
  /** Sessions with something to judge: the rate's denominator. */
  counted: number;
  /** Their attendance rate, already rounded. */
  rate: number;
  /** Unexcused absences. */
  absent: number;
}

/**
 * How a student stands.
 *
 * "none" is nothing counted yet, which is not the same as failing — a class in
 * its first week would otherwise show every student in red. "warning" is the
 * band before the line: somebody at 72 against 75, or on their last allowed
 * absence. They are not short yet, and the colour should say so.
 */
export type Standing = "none" | "met" | "warning" | "short";

export const DEFAULT_REQUIREMENT: ClassRequirement = {
  rule: "percentage",
  minPercentage: 75,
  maxAbsences: 4,
};

/** How far below the line still reads as "nearly", under the percentage rule. */
const WARNING_BAND = 15;

export const standingOf = (
  req: ClassRequirement,
  totals: StudentStandingInput,
): Standing => {
  if (req.rule === "absences") {
    // An allowance is spent by absences alone, so it can be judged before any
    // session has closed: three absences is three absences in week two.
    if (totals.absent > req.maxAbsences) return "short";
    if (totals.counted === 0 && totals.absent === 0) return "none";
    return totals.absent === req.maxAbsences ? "warning" : "met";
  }

  if (totals.counted === 0) return "none";
  if (totals.rate >= req.minPercentage) return "met";
  return totals.rate >= req.minPercentage - WARNING_BAND ? "warning" : "short";
};

export const STANDING_COLOUR: Record<Standing, string> = {
  none: "text-muted-foreground",
  met: "text-success",
  warning: "text-warning",
  short: "text-destructive",
};

/**
 * The number a student is judged on: their rate, or absences against the
 * allowance. "—" while there is nothing to show.
 */
export const standingValue = (
  req: ClassRequirement,
  totals: StudentStandingInput,
): string => {
  if (req.rule === "absences") return `${totals.absent}/${req.maxAbsences}`;
  return totals.counted === 0 ? "—" : `${totals.rate}%`;
};

/** What the class requires, said in a few words. Follows a value on screen. */
export const requirementLabel = (req: ClassRequirement): string =>
  req.rule === "absences"
    ? `of ${req.maxAbsences} absence${req.maxAbsences === 1 ? "" : "s"} allowed`
    : `of ${req.minPercentage}% needed`;

/** What the class requires, standing on its own — a settings row, a summary. */
export const requirementSummary = (req: ClassRequirement): string =>
  req.rule === "absences"
    ? `Up to ${req.maxAbsences} absence${req.maxAbsences === 1 ? "" : "s"}`
    : `${req.minPercentage}%`;

/** The name of the narrowing filter on the roster. */
export const shortFilterLabel = (req: ClassRequirement): string =>
  req.rule === "absences"
    ? `Over ${req.maxAbsences} absence${req.maxAbsences === 1 ? "" : "s"}`
    : `Below ${req.minPercentage}%`;

/** Part of a downloaded file's name, so a saved list says what it was. */
export const shortFilterSlug = (req: ClassRequirement): string =>
  req.rule === "absences"
    ? `over-${req.maxAbsences}-absences`
    : `below-${req.minPercentage}`;

/**
 * The line shown to a student who is short, or null when they are not.
 *
 * Addressed to the student on their own page and read by the TA on the record
 * dialog, so it states the fact and the rule, and nothing else.
 */
export const shortfallLine = (
  req: ClassRequirement,
  totals: StudentStandingInput,
): string | null => {
  if (standingOf(req, totals) !== "short") return null;
  if (req.rule === "absences") {
    return `${totals.absent} absences, more than the ${req.maxAbsences} this class allows.`;
  }
  return `Below the ${req.minPercentage}% this class requires.`;
};

/** The requirement of a class row, however the row reached the screen. */
export const requirementOf = (klass: {
  attendance_rule?: string | null;
  min_attendance_percentage?: number | null;
  max_absences?: number | null;
}): ClassRequirement => ({
  rule: klass.attendance_rule === "absences" ? "absences" : "percentage",
  minPercentage:
    klass.min_attendance_percentage ?? DEFAULT_REQUIREMENT.minPercentage,
  maxAbsences: klass.max_absences ?? DEFAULT_REQUIREMENT.maxAbsences,
});
