// Roster corrections.
//
// NOTE: this is the only part of the export feature that WRITES. Everything
// else reads. It exists because a student filed under the wrong cohort has
// their attendance counted against the wrong cohort's sessions, so the numbers
// cannot be fixed without fixing the record.

import { supabase } from "@/lib/supabase";

export interface CohortChange {
  studentId: string;
  from: string;
  to: string;
}

export interface CohortChangeResult extends CohortChange {
  /** Past check-ins retagged along with the roster row. */
  checkInsRetagged: number;
  error?: string;
}

/**
 * Move a student to a different cohort.
 *
 * Two tables, because present_students.cohort is a copy taken at check-in time
 * rather than an independent fact. Leaving those rows behind would keep the
 * student's history attributed to the old cohort, and session detection reads
 * that column to decide which cohort met on a given day — so a stale row can
 * invent a session for a cohort that never met, and mark everyone else in it
 * absent.
 *
 * Not a transaction: PostgREST has no client-side transaction, so a failure
 * between the two writes leaves the roster moved and the history not. The
 * result says what actually happened rather than pretending it was atomic.
 */
export const applyCohortChange = async (
  change: CohortChange,
): Promise<CohortChangeResult> => {
  const { studentId, from, to } = change;

  const { error: rosterError } = await supabase
    .from("students")
    .update({ cohort: to })
    .eq("student_id", studentId);

  if (rosterError) {
    return {
      ...change,
      checkInsRetagged: 0,
      error: `Roster not updated: ${rosterError.message}`,
    };
  }

  const { data: retagged, error: historyError } = await supabase
    .from("present_students")
    .update({ cohort: to })
    .eq("student_id", studentId)
    .eq("cohort", from)
    // student_id, not id — this table's schema is not in the repo and an id
    // column cannot be assumed.
    .select("student_id");

  if (historyError) {
    return {
      ...change,
      checkInsRetagged: 0,
      error: `Cohort changed, but past check-ins still say ${from}: ${historyError.message}`,
    };
  }

  return { ...change, checkInsRetagged: (retagged || []).length };
};

/** Apply several cohort changes, reporting each one's outcome separately. */
export const applyCohortChanges = async (
  changes: CohortChange[],
): Promise<CohortChangeResult[]> => {
  const results: CohortChangeResult[] = [];
  for (const change of changes) {
    results.push(await applyCohortChange(change));
  }
  return results;
};
