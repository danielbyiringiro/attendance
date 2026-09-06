import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import StudentPicker from "@/components/StudentPicker";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import type { CanvasMatch } from "@/lib/canvasGradebook";
import type { CohortChange } from "@/lib/rosterUpdates";
import type { SummaryRow } from "@/lib/attendanceExport";

interface CanvasMatchPanelProps {
  matches: CanvasMatch[];
  summary: SummaryRow[];
  /** Pair one Canvas row with an attendance student, or null to unpair. */
  onAssign: (rowIndex: number, studentId: string | null) => void;
  /** Write the given cohort corrections back to the roster. */
  onApplyCohorts: (changes: CohortChange[]) => void;
  isApplyingCohorts: boolean;
}

const CanvasMatchPanel = ({
  matches,
  summary,
  onAssign,
  onApplyCohorts,
  isApplyingCohorts,
}: CanvasMatchPanelProps) => {
  const byStudent = useMemo(
    () => new Map(summary.map((s) => [s.student_id, s])),
    [summary],
  );

  const matched = matches.filter((m) => m.studentId);
  const unmatched = matches.filter((m) => !m.studentId);

  // Only offer students who are not already spoken for, so the same person
  // cannot be assigned to two Canvas rows.
  const available = useMemo(() => {
    const taken = new Set(
      matches.map((m) => m.studentId).filter((id): id is string => Boolean(id)),
    );
    return summary.filter((s) => !taken.has(s.student_id));
  }, [matches, summary]);

  const autoCount = matches.filter(
    (m) => m.how === "sis-id" || m.how === "name",
  ).length;
  const manualCount = matches.filter((m) => m.how === "manual").length;

  // A matched student whose Canvas section disagrees with their cohort here.
  // Their attendance is being counted against the wrong cohort's sessions, so
  // this is a wrong number, not just untidy data.
  const cohortConflicts = useMemo(
    () =>
      matches
        .filter((m) => m.studentId && m.canvasCohort)
        .map((m) => {
          const student = byStudent.get(m.studentId!);
          if (!student || student.cohort === m.canvasCohort) return null;
          return {
            match: m,
            student,
            change: {
              studentId: student.student_id,
              from: student.cohort,
              to: m.canvasCohort!,
            } as CohortChange,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [matches, byStudent],
  );

  const unplaced = useMemo(() => {
    const placed = new Set(
      matches.map((m) => m.studentId).filter((id): id is string => Boolean(id)),
    );
    return summary.filter((s) => !placed.has(s.student_id));
  }, [matches, summary]);

  return (
    <div className="space-y-4 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-sm">
        {unmatched.length === 0 ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-amber-600" />
        )}
        <span className="font-medium">
          {matched.length} of {matches.length} Canvas rows matched
        </span>
        <span className="text-muted-foreground">
          ({autoCount} automatically
          {manualCount > 0 ? `, ${manualCount} by hand` : ""})
        </span>
      </div>

      {/* Cohort corrections */}
      {cohortConflicts.length > 0 && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm font-medium">
              {cohortConflicts.length} student
              {cohortConflicts.length === 1 ? " is" : "s are"} in a different
              section on Canvas
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={isApplyingCohorts}
              onClick={() => onApplyCohorts(cohortConflicts.map((c) => c.change))}
            >
              {isApplyingCohorts ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : null}
              Move all to Canvas section
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Their attendance is currently counted against the wrong cohort's
            sessions, so these numbers are wrong until this is fixed. Updating
            changes the roster and retags that student's past check-ins, then
            you should re-match to get corrected figures.
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {cohortConflicts.map(({ match, student, change }) => (
              <div
                key={match.rowIndex}
                className="flex items-center justify-between gap-2 rounded bg-background/60 p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {student.name || student.student_id}
                    <span className="text-muted-foreground">
                      {" · "}
                      {student.student_id}
                    </span>
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Badge variant="outline" className="text-xs">
                      {student.cohort}
                    </Badge>
                    <ArrowRight className="h-3 w-3" />
                    <Badge className="text-xs">{change.to}</Badge>
                    <span className="truncate">({match.canvasSection})</span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isApplyingCohorts}
                  onClick={() => onApplyCohorts([change])}
                >
                  Move to {change.to}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unmatched Canvas rows */}
      {unmatched.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            These Canvas students had no matching attendance record. Search for
            the right person, or leave them — a blank cell tells Canvas to leave
            that student's existing grade alone.
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {unmatched.map((m) => (
              <div
                key={m.rowIndex}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/50 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.canvasName || "(no name)"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.canvasSisId ? `SIS ID ${m.canvasSisId}` : "no SIS ID"}
                    {m.canvasSection ? ` · ${m.canvasSection}` : ""}
                  </p>
                </div>
                <StudentPicker
                  students={available}
                  value={m.studentId}
                  onChange={(id) => onAssign(m.rowIndex, id)}
                  className="w-60 shrink-0"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {unplaced.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {unplaced.length} attendance student
            {unplaced.length === 1 ? "" : "s"} not on the Canvas export
          </summary>
          <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto text-muted-foreground">
            {unplaced.map((s) => (
              <li key={s.student_id}>
                {s.name || "(no name)"} · {s.student_id} · cohort {s.cohort}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

export default CanvasMatchPanel;
