import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Loader2, Search, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  attendanceLog,
  sessionStatesFor,
  tallyStates,
  type AttendanceLog,
} from "@/lib/api/attendance";
import type { CohortRow } from "@/lib/api/types";
import StudentDetailDialog from "@/components/ta/StudentDetailDialog";
import { toCsv } from "@/lib/csv";
import { downloadCsv } from "@/lib/attendanceExport";
import { todayStr } from "@/lib/dates";

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
    // A band below the threshold rather than straight to red: somebody at 72
    // against a 75 requirement is in a different position from somebody at 40,
    // and the colour should say so.
    : rate >= threshold - 15
      ? "text-warning"
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
  onVisibleChange,
}: StudentRosterProps) => {
  const { toast } = useToast();
  const [log, setLog] = useState<AttendanceLog | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [cohortFilter, setCohortFilter] = useState<string>("all");
  // Narrowing to the students who need attention. "Everyone, sorted worst
  // first" answers a different question from "who is actually below the line".
  const [risk, setRisk] = useState<"all" | "below" | "absences">("all");
  const [minAbsences, setMinAbsences] = useState("3");
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

  const cohortIdOf = useMemo(
    () => new Map(cohorts.map((c) => [c.label, c.id])),
    [cohorts],
  );

  const standings = useMemo<StudentStanding[]>(() => {
    if (!log) {
      return roster.map((student) => ({
        ...student,
        sessions: 0,
        present: 0,
        late: 0,
        excused: 0,
        absent: 0,
        rate: 0,
      }));
    }

    return roster.map((student) => {
      // Driven from the sessions their cohort held, not the records they have:
      // a session still open shows as null and is excluded, rather than being
      // invisible here and an absence in the exported CSV.
      const cohortId = cohortIdOf.get(student.cohort);
      const t = tallyStates(
        cohortId ? sessionStatesFor(log, student.student_id, cohortId) : [],
      );

      return {
        ...student,
        sessions: t.sessions,
        present: t.present,
        late: t.late,
        excused: t.excused,
        absent: t.absent,
        rate: t.rate,
      };
    });
  }, [roster, log, cohortIdOf]);

  const absenceFloor = Math.max(1, Number(minAbsences) || 1);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return standings
      .filter((s) => cohortFilter === "all" || s.cohort === cohortFilter)
      .filter((s) => {
        if (risk === "all") return true;
        // Somebody with no graded sessions has no rate to be below; excluding
        // them keeps a new class from listing everybody as at risk.
        if (risk === "below") {
          return s.sessions > 0 && s.rate < minAttendancePercentage;
        }
        return s.absent >= absenceFloor;
      })
      .filter(
        (s) =>
          needle === "" ||
          s.student_id.toLowerCase().includes(needle) ||
          (s.name ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.rate - b.rate || a.student_id.localeCompare(b.student_id));
  }, [
    standings,
    query,
    cohortFilter,
    risk,
    absenceFloor,
    minAttendancePercentage,
  ]);

  // Tell the heading what is actually on screen. Depends on the count rather
  // than on `shown` itself, so re-sorting the same students does not fire it.
  useEffect(() => {
    onVisibleChange?.(shown.length);
  }, [shown.length, onVisibleChange]);

  // Whatever is on screen, as a file. The point of narrowing to "below 75%" is
  // usually to do something about those students, which happens outside this
  // app.
  const downloadShown = () => {
    if (shown.length === 0) return;
    const csv = toCsv(
      ["Student ID", "Name", "Cohort", "Sessions", "Present", "Late", "Excused", "Absent", "Rate %"],
      shown.map((s) => [
        s.student_id,
        s.name ?? "",
        s.cohort,
        String(s.sessions),
        String(s.present),
        String(s.late),
        String(s.excused),
        String(s.absent),
        String(s.rate),
      ]),
    );
    const scope =
      risk === "below"
        ? `below-${minAttendancePercentage}`
        : risk === "absences"
          ? `min-${absenceFloor}-absences`
          : "all";
    downloadCsv(csv, `students-${scope}-${todayStr()}.csv`);
    toast({
      title: "Downloaded",
      description: `${shown.length} student${shown.length === 1 ? "" : "s"}.`,
    });
  };

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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={risk === "all" ? "secondary" : "ghost"}
          onClick={() => setRisk("all")}
        >
          Everyone
        </Button>
        <Button
          size="sm"
          variant={risk === "below" ? "secondary" : "ghost"}
          onClick={() => setRisk("below")}
        >
          Below {minAttendancePercentage}%
        </Button>
        <Button
          size="sm"
          variant={risk === "absences" ? "secondary" : "ghost"}
          onClick={() => setRisk("absences")}
        >
          Absences
        </Button>

        {risk === "absences" && (
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">at least</span>
            <Input
              type="number"
              min={1}
              className="h-8 w-16"
              value={minAbsences}
              onChange={(e) => setMinAbsences(e.target.value)}
            />
          </div>
        )}

        {risk !== "all" && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={shown.length === 0}
            onClick={downloadShown}
          >
            <Download className="mr-1 h-4 w-4" />
            Download {shown.length}
          </Button>
        )}
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
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-left shadow-soft transition-colors hover:border-primary/40 hover:bg-accent/5 focus:outline-none focus:ring-2 focus:ring-ring"
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
