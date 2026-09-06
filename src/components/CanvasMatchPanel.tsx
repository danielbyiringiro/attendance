import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { CanvasMatch } from "@/lib/canvasGradebook";
import type { SummaryRow } from "@/lib/attendanceExport";

interface CanvasMatchPanelProps {
  matches: CanvasMatch[];
  summary: SummaryRow[];
  /** Pair one Canvas row with an attendance student, or null to unpair. */
  onAssign: (rowIndex: number, studentId: string | null) => void;
}

const UNASSIGNED = "__none__";

const CanvasMatchPanel = ({
  matches,
  summary,
  onAssign,
}: CanvasMatchPanelProps) => {
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

  // Attendance students who never made it onto a Canvas row — the other half of
  // the reconciliation, and usually the more interesting one.
  const unplaced = useMemo(() => {
    const placed = new Set(
      matches.map((m) => m.studentId).filter((id): id is string => Boolean(id)),
    );
    return summary.filter((s) => !placed.has(s.student_id));
  }, [matches, summary]);

  return (
    <div className="space-y-3 rounded-lg border p-3">
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

      {unmatched.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            These Canvas students had no matching attendance record. Pair them
            up, or leave them — a blank cell tells Canvas to leave that
            student's existing grade alone.
          </p>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {unmatched.map((m) => (
              <div
                key={m.rowIndex}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/50 p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.canvasName || "(no name)"}
                  </p>
                  {m.canvasSisId && (
                    <p className="truncate text-xs text-muted-foreground">
                      SIS ID {m.canvasSisId}
                    </p>
                  )}
                </div>
                <Select
                  value={m.studentId ?? UNASSIGNED}
                  onValueChange={(value) =>
                    onAssign(m.rowIndex, value === UNASSIGNED ? null : value)
                  }
                >
                  <SelectTrigger className="w-56 shrink-0">
                    <SelectValue placeholder="Leave blank" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Leave blank</SelectItem>
                    {available.map((s) => (
                      <SelectItem key={s.student_id} value={s.student_id}>
                        {s.name || s.student_id} · {s.student_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
