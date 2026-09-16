import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Loader2, Search, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  attendanceLog,
  studentTotals,
  type AttendanceLog,
} from "@/lib/api/attendance";
import type { CohortRow } from "@/lib/api/types";
import StudentDetailDialog from "@/components/ta/StudentDetailDialog";
import { toCsv } from "@/lib/csv";
import { downloadCsv } from "@/lib/attendanceExport";
import { todayStr } from "@/lib/dates";
import {
  DEFAULT_REQUIREMENT,
  shortFilterLabel,
  shortFilterSlug,
  standingOf,
  standingValue,
  STANDING_COLOUR,
  type ClassRequirement,
} from "@/lib/attendanceRule";

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
  /** What this class requires, and how (046). */
  requirement?: ClassRequirement;
  /**
   * Re-read the roster itself.
   *
   * `load` below only re-reads attendance. Names, cohorts and IDs come from
   * the `roster` prop, which this component does not own — so an edit to a
   * student would leave the list showing what it said before, and the change
   * would look as though it had not happened.
   */
  onRosterChanged?: () => void;
  /**
   * How many students the filters currently leave visible.
   *
   * Reported upwards because the heading that states the number sits outside
   * this component, while the cohort, search and risk filters that decide it
   * all live inside. Without this the heading counts the whole class and
   * silently contradicts the list under it.
   *
   * Must be a stable function — a setState setter, not a fresh closure.
   */
  onVisibleChange?: (visible: number) => void;
}

/** A roster row's three numbers, as the class's requirement reads them. */
const toStanding = (s: StudentStanding) => ({
  counted: s.sessions,
  rate: s.rate,
  absent: s.absent,
});

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
  requirement = DEFAULT_REQUIREMENT,
  onRosterChanged,
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

  // Driven from the sessions their cohort held, not the records they have:
  // a session still open shows as null and is excluded, rather than being
  // invisible here and an absence in the exported CSV. studentTotals is
  // shared with the attendance tab, which opens the same student dialog, so
  // the two cannot count one student differently.
  const standings = useMemo<StudentStanding[]>(
    () =>
      roster.map((student) => ({
        ...student,
        ...studentTotals(log, student.student_id, cohortIdOf.get(student.cohort)),
      })),
    [roster, log, cohortIdOf],
  );

  const absenceFloor = Math.max(1, Number(minAbsences) || 1);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return standings
      .filter((s) => cohortFilter === "all" || s.cohort === cohortFilter)
      .filter((s) => {
        if (risk === "all") return true;
        // Somebody with nothing counted yet has no standing to be short of,
        // which keeps a new class from listing everybody as at risk.
        if (risk === "below") {
          return standingOf(requirement, toStanding(s)) === "short";
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
    requirement,
  ]);

  // Switching class clears the filters.
  //
  // The cohort filter is held by LABEL, so "C" survives into a class that has
  // no cohort C and the roster comes up empty with only "No student matches
  // that filter" to explain it. A search term and a risk filter survive the
  // same way and are just as puzzling — they were about the class you were
  // looking at, not this one.
  useEffect(() => {
    setCohortFilter("all");
    setQuery("");
    setRisk("all");
  }, [classId]);

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
        ? shortFilterSlug(requirement)
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
        <div className="relative w-full flex-1 sm:w-auto sm:min-w-[16rem]">
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
          {shortFilterLabel(requirement)}
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
                      STANDING_COLOUR[standingOf(requirement, toStanding(s))]
                    }`}
                  >
                    {standingValue(requirement, toStanding(s))}
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
        classId={classId}
        cohorts={cohorts}
        log={log}
        requirement={requirement}
        onOpenChange={(open) => !open && setOpenStudent(null)}
        onChanged={() => {
          // Both: an attendance correction changes the log, an edit to the
          // student changes the roster, and the dialog offers both.
          void load();
          onRosterChanged?.();
        }}
      />
    </div>
  );
};

export default StudentRoster;
