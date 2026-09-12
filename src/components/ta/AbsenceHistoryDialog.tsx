import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, Download, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { attendanceLog, isAbsentState } from "@/lib/api/attendance";
import { toCsv } from "@/lib/csv";
import { downloadCsv } from "@/lib/attendanceExport";
import { fromDateStr, toDateStr, todayStr } from "@/lib/dates";

interface RosterEntry {
  student_id: string;
  cohort: string;
  name?: string;
}

interface AbsenceHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string | null;
  classCode?: string;
  roster: RosterEntry[];
}

interface AbsenceRow {
  date: string;
  student_id: string;
  cohort: string;
}

/**
 * Who missed a session, and who is missing too many.
 *
 * Two different questions over the same rows. The dialog only answered the
 * first, and it opened on the whole term — so the question a TA almost always
 * has, "who missed the class that just finished", arrived behind every absence
 * since the term started. It now opens on today.
 *
 * The second question had no answer at all: finding students past a threshold
 * meant reading a term of rows and counting by eye.
 */
const AbsenceHistoryDialog = ({
  open,
  onOpenChange,
  classId,
  classCode,
  roster,
}: AbsenceHistoryDialogProps) => {
  const { toast } = useToast();
  const [rows, setRows] = useState<AbsenceRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<"day" | "student">("day");
  const [day, setDay] = useState<Date | undefined>(new Date());
  const [minAbsences, setMinAbsences] = useState("1");

  const load = useCallback(async () => {
    if (!classId) {
      setRows([]);
      return;
    }
    setIsLoading(true);
    try {
      // By student always spans the term; by day is whatever date is chosen,
      // and an unset date means the term too.
      const on = mode === "student" || !day ? undefined : toDateStr(day);
      const log = await attendanceLog(classId, { from: on, to: on });
      setRows(
        log.marks
          .filter((m) => isAbsentState(m.state))
          .map((m) => ({
            date: m.session_date,
            student_id: m.student_id,
            cohort: m.cohort_label,
          }))
          .sort((a, b) => b.date.localeCompare(a.date)),
      );
    } catch (e) {
      toast({
        title: "Could not load the absence history",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, [classId, mode, day, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const nameOf = useCallback(
    (studentId: string) =>
      roster.find((r) => r.student_id === studentId)?.name ?? "",
    [roster],
  );

  const floor = Math.max(1, Number(minAbsences) || 1);

  /** One line per student, worst first. */
  const totals = useMemo(() => {
    const byStudent = new Map<
      string,
      { student_id: string; name: string; cohort: string; days: string[] }
    >();
    rows.forEach((a) => {
      const entry = byStudent.get(a.student_id);
      if (entry) {
        if (!entry.days.includes(a.date)) entry.days.push(a.date);
        return;
      }
      byStudent.set(a.student_id, {
        student_id: a.student_id,
        name: nameOf(a.student_id),
        cohort: a.cohort,
        days: [a.date],
      });
    });

    return [...byStudent.values()]
      .filter((e) => e.days.length >= floor)
      .sort(
        (a, b) =>
          b.days.length - a.days.length ||
          a.student_id.localeCompare(b.student_id),
      );
  }, [rows, nameOf, floor]);

  const downloadReport = () => {
    if (totals.length === 0) return;
    const csv = toCsv(
      ["Student ID", "Name", "Cohort", "Absences", "Dates"],
      totals.map((e) => [
        e.student_id,
        e.name,
        e.cohort,
        String(e.days.length),
        [...e.days].sort().join(" "),
      ]),
    );
    downloadCsv(
      csv,
      `absences-${classCode ?? "class"}-min${floor}-${todayStr()}.csv`,
    );
    toast({
      title: "Report downloaded",
      description: `${totals.length} student${totals.length === 1 ? "" : "s"} with ${floor} or more absences.`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Absence History</DialogTitle>
          <DialogDescription>
            Who missed a particular session, or who is missing too many.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={mode === "day" ? "secondary" : "ghost"}
              onClick={() => setMode("day")}
            >
              By day
            </Button>
            <Button
              size="sm"
              variant={mode === "student" ? "secondary" : "ghost"}
              onClick={() => setMode("student")}
            >
              By student
            </Button>

            {mode === "day" ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-[220px] justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {day ? format(day, "PPP") : "Whole term"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={day}
                    onSelect={setDay}
                    initialFocus
                  />
                  <div className="flex gap-2 border-t p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => setDay(new Date())}
                    >
                      Today
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1"
                      onClick={() => setDay(undefined)}
                    >
                      Whole term
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Label htmlFor="min-absences" className="text-sm">
                    At least
                  </Label>
                  <Input
                    id="min-absences"
                    type="number"
                    min={1}
                    className="w-20"
                    value={minAbsences}
                    onChange={(e) => setMinAbsences(e.target.value)}
                  />
                  <span className="text-sm text-muted-foreground">
                    absences
                  </span>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={totals.length === 0}
                  onClick={downloadReport}
                >
                  <Download className="mr-1 h-4 w-4" />
                  Download report
                </Button>
              </>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading history…
            </div>
          ) : mode === "student" ? (
            totals.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Nobody in this class has {floor} or more absences.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {totals.length} student{totals.length === 1 ? "" : "s"} with{" "}
                  {floor} or more, worst first.
                </p>
                <div className="grid grid-cols-[1fr_5rem_6rem] gap-2 border-b pb-2 text-sm font-semibold">
                  <div>Student</div>
                  <div>Cohort</div>
                  <div className="text-right">Absences</div>
                </div>
                {totals.map((e) => (
                  <div
                    key={e.student_id}
                    className="grid grid-cols-[1fr_5rem_6rem] items-center gap-2 rounded-lg bg-muted/50 p-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {e.name || e.student_id}
                      </p>
                      {e.name && (
                        <p className="text-xs text-muted-foreground">
                          {e.student_id}
                        </p>
                      )}
                    </div>
                    <div>
                      <Badge variant="outline">{e.cohort}</Badge>
                    </div>
                    <div className="text-right font-semibold tabular-nums text-destructive">
                      {e.days.length}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {day
                ? `Nobody was absent on ${format(day, "PPP")}.`
                : "No absences recorded for this class."}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {rows.length} absence{rows.length === 1 ? "" : "s"}
                {day ? ` on ${format(day, "PPP")}` : " this term"}.
              </p>
              <div className="hidden grid-cols-4 gap-2 border-b pb-2 text-sm font-semibold sm:grid">
                <div>Date</div>
                <div>Student</div>
                <div>Cohort</div>
                <div>Status</div>
              </div>
              {rows.map((a, i) => (
                <div
                  key={`${a.date}-${a.student_id}-${i}`}
                  className="grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg bg-muted/50 p-2 text-sm sm:grid-cols-4"
                >
                  <div>{format(fromDateStr(a.date), "MMM dd, yyyy")}</div>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {nameOf(a.student_id) || a.student_id}
                    </p>
                    {nameOf(a.student_id) && (
                      <p className="text-xs text-muted-foreground">
                        {a.student_id}
                      </p>
                    )}
                  </div>
                  <div>
                    <Badge variant="outline">Cohort {a.cohort}</Badge>
                  </div>
                  <div>
                    <Badge variant="destructive">Absent</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AbsenceHistoryDialog;
