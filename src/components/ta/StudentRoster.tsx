import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { attendanceLog, type AttendanceLog } from "@/lib/api/attendance";
import type { CohortRow } from "@/lib/api/types";
import StudentDetailDialog from "@/components/ta/StudentDetailDialog";

export interface RosterEntry {
  student_id: string;
  cohort: string;
  name?: string;
}

/** One student's standing in the class, counted off stored rows. */
export interface StudentStanding extends RosterEntry {
  sessions: number;
  present: number;
  late: number;
  excused: number;
  absent: number;
  /** (present + late) / (present + late + absent), as a percentage. */
  rate: number;
}

interface StudentRosterProps {
  classId: string;
  cohorts: CohortRow[];
  roster: RosterEntry[];
  /** Shown as a "Mark Present" action when given. */
  onMarkPresent?: (studentId: string, cohort: string) => void;
  presentIds?: Set<string>;
  /** Below this, a rate is shown in red. */
  minAttendancePercentage?: number;
}

const rateColour = (rate: number, threshold: number) =>
  rate >= threshold
    ? "text-success"
    : rate >= threshold - 15
      ? "text-amber-600 dark:text-amber-500"
      : "text-destructive";

/**
 * Every student in the class, with their attendance, filtered as you type.
 *
 * This replaces two dialogs — "Search Absences" and "Search Attendance
 * Records" — that each made you open a modal, type a name, and press a button
 * before showing anything, and neither of which could show you the roster. The
 * list is the screen; the modal is for one student's detail.
 */
const StudentRoster = ({
  classId,
  cohorts,
  roster,
  onMarkPresent,
  presentIds,
  minAttendancePercentage = 75,
}: StudentRosterProps) => {
  const { toast } = useToast();
  const [log, setLog] = useState<AttendanceLog | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [cohortFilter, setCohortFilter] = useState<string>("all");
  const [openStudent, setOpenStudent] = useState<StudentStanding | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setLog(await attendanceLog(classId));
    } catch (e) {
      toast({
        title: "Could not load attendance",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setLog(null);
    } finally {
      setIsLoading(false);
    }
  }, [classId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const standings = useMemo<StudentStanding[]>(() => {
    return roster.map((student) => {
      const marks = log?.byStudent.get(student.student_id) ?? [];
      const present = marks.filter((m) => m.state === "present").length;
      const late = marks.filter((m) => m.state === "late").length;
      const excused = marks.filter((m) => m.state === "excused").length;
      const absent = marks.filter((m) => m.state === "unexcused").length;
      // Excused and exempted leave the denominator: they neither help nor hurt.
      const graded = present + late + absent;
      return {
        ...student,
        sessions: marks.length,
        present,
        late,
        excused,
        absent,
        rate: graded > 0 ? Math.round(((present + late) / graded) * 1000) / 10 : 0,
      };
    });
  }, [roster, log]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return standings
      .filter((s) => cohortFilter === "all" || s.cohort === cohortFilter)
      .filter(
        (s) =>
          needle === "" ||
          s.student_id.toLowerCase().includes(needle) ||
          (s.name ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.rate - b.rate || a.student_id.localeCompare(b.student_id));
  }, [standings, query, cohortFilter]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            placeholder="Filter by name or ID"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={cohortFilter === "all" ? "secondary" : "ghost"}
            onClick={() => setCohortFilter("all")}
          >
            All
          </Button>
          {cohorts.map((c) => (
            <Button
              key={c.id}
              size="sm"
              variant={cohortFilter === c.label ? "secondary" : "ghost"}
              onClick={() => setCohortFilter(c.label)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        {isLoading && <Loader2 className="h-4 w-4 animate-spin opacity-60" />}
      </div>

      <p className="text-xs text-muted-foreground">
        Sorted by attendance, lowest first. Click anyone for their full record.
        Excused and exempt sessions are left out of the rate rather than counted
        against them.
      </p>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {roster.length === 0
            ? "Nobody is enrolled in this class yet."
            : "No student matches that filter."}
        </p>
      ) : (
        <div className="max-h-[32rem] space-y-1 overflow-y-auto">
          {shown.map((s) => {
            const isPresent = presentIds?.has(s.student_id) ?? false;
            return (
              <div
                key={s.student_id}
                role="button"
                tabIndex={0}
                onClick={() => setOpenStudent(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpenStudent(s);
                  }
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-left hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {s.name || s.student_id}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {s.cohort}
                    </Badge>
                    {isPresent && (
                      <Badge variant="secondary" className="text-xs">
                        here today
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.name ? `${s.student_id} · ` : ""}
                    {s.sessions === 0
                      ? "no sessions yet"
                      : `${s.present + s.late}/${s.present + s.late + s.absent} attended${
                          s.excused > 0 ? `, ${s.excused} excused` : ""
                        }`}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={`text-sm font-semibold tabular-nums ${
                      s.sessions === 0
                        ? "text-muted-foreground"
                        : rateColour(s.rate, minAttendancePercentage)
                    }`}
                  >
                    {s.sessions === 0 ? "—" : `${s.rate}%`}
                  </span>
                  {onMarkPresent && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPresent}
                      onClick={(e) => {
                        // The row itself opens the detail dialog.
                        e.stopPropagation();
                        onMarkPresent(s.student_id, s.cohort);
                      }}
                    >
                      <UserCheck className="mr-1 h-4 w-4" />
                      Mark
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <StudentDetailDialog
        student={openStudent}
        log={log}
        threshold={minAttendancePercentage}
        onOpenChange={(open) => !open && setOpenStudent(null)}
        onChanged={load}
      />
    </div>
  );
};

export default StudentRoster;
