import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Calendar as CalendarIcon,
  Download,
  Loader2,
  Users,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Checkbox } from "@/components/ui/checkbox";
import CanvasMatchPanel from "@/components/CanvasMatchPanel";
import {
  buildAttendanceExport,
  downloadCsv,
  FORMATS,
  SEMESTER_START,
  type ExportFormat,
  type ExportResult,
  type ExportShape,
} from "@/lib/attendanceExport";
import {
  fillCanvasSheet,
  matchCanvasRows,
  parseCanvasCsv,
  type CanvasMatch,
  type ParsedCanvasSheet,
} from "@/lib/canvasGradebook";

interface RosterStudent {
  student_id: string;
  cohort: string;
  name?: string;
}

interface AttendanceExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: RosterStudent[];
}

// The semester start is a UTC-constructed date, so read it back in UTC.
const semesterStartLocal = new Date(
  SEMESTER_START.getUTCFullYear(),
  SEMESTER_START.getUTCMonth(),
  SEMESTER_START.getUTCDate(),
);

const AttendanceExportDialog = ({
  open,
  onOpenChange,
  roster,
}: AttendanceExportDialogProps) => {
  const { toast } = useToast();

  const [cohort, setCohort] = useState<string>("all");
  const [shape, setShape] = useState<ExportShape>("summary");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("default");
  const [mergeExcused, setMergeExcused] = useState(false);
  const [startDate, setStartDate] = useState<Date>(semesterStartLocal);
  const [endDate, setEndDate] = useState<Date>(new Date());
  const [studentQuery, setStudentQuery] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<RosterStudent | null>(
    null,
  );
  const [isExporting, setIsExporting] = useState(false);
  const [lastResult, setLastResult] = useState<ExportResult | null>(null);

  // Canvas round-trip: the uploaded gradebook and how its rows pair up with the
  // attendance roster.
  const [canvasSheet, setCanvasSheet] = useState<ParsedCanvasSheet | null>(null);
  const [canvasFileName, setCanvasFileName] = useState("");
  const [matches, setMatches] = useState<CanvasMatch[] | null>(null);

  const resetCanvasMatching = () => {
    setMatches(null);
    setLastResult(null);
  };

  // Any change to what gets tallied invalidates an existing pairing - a match
  // built for one date range must not be downloaded against another.
  useEffect(() => {
    setMatches(null);
  }, [exportFormat, cohort, mergeExcused, startDate, endDate, selectedStudent]);

  const handleCanvasFile = async (file: File | undefined) => {
    if (!file) return;
    resetCanvasMatching();
    try {
      const parsed = parseCanvasCsv(await file.text());
      setCanvasSheet(parsed);
      setCanvasFileName(file.name);
      toast({
        title: "Canvas export loaded",
        description: `${file.name} — ${parsed.rows.length} student row${
          parsed.rows.length === 1 ? "" : "s"
        }.`,
      });
    } catch (error) {
      setCanvasSheet(null);
      setCanvasFileName("");
      toast({
        title: "Could not read that file",
        description:
          error instanceof Error ? error.message : "Unrecognised CSV.",
        variant: "destructive",
      });
    }
  };

  const handleAssign = (rowIndex: number, studentId: string | null) => {
    setMatches((prev) =>
      prev
        ? prev.map((m) =>
            m.rowIndex === rowIndex
              ? { ...m, studentId, how: studentId ? "manual" : "unmatched" }
              : m,
          )
        : prev,
    );
  };

  const handleDownloadFilled = () => {
    if (!canvasSheet || !matches || !lastResult) return;
    try {
      const filled = fillCanvasSheet({
        sheet: canvasSheet,
        matches,
        summary: lastResult.summary,
        sessionDays: lastResult.sessionDays,
        startStr: lastResult.effectiveStart,
        endStr: lastResult.effectiveEnd,
      });
      downloadCsv(filled.csv, filled.filename);
      toast({
        title: "Canvas file ready",
        description: `${filled.filename} — ${filled.filled} scored${
          filled.blank ? `, ${filled.blank} left blank` : ""
        }. Upload it on the Grades page.`,
      });
    } catch (error) {
      toast({
        title: "Could not build the file",
        description:
          error instanceof Error ? error.message : "Unexpected error.",
        variant: "destructive",
      });
    }
  };

  // Cohort options come from the roster, so an extra cohort added later shows
  // up here without a code change.
  const cohortOptions = useMemo(
    () =>
      Array.from(
        new Set(
          roster.map((r) => String(r.cohort || "").toUpperCase()).filter(Boolean),
        ),
      ).sort(),
    [roster],
  );

  // The student picker only offers students inside the chosen cohort, so the
  // two filters can never contradict each other.
  const studentMatches = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return [];
    return roster
      .filter(
        (r) =>
          cohort === "all" || String(r.cohort).toUpperCase() === cohort,
      )
      .filter(
        (r) =>
          r.student_id.toLowerCase().includes(q) ||
          (r.name || "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [studentQuery, roster, cohort]);

  const studentsInScope = useMemo(() => {
    if (selectedStudent) return 1;
    return roster.filter(
      (r) => cohort === "all" || String(r.cohort).toUpperCase() === cohort,
    ).length;
  }, [roster, cohort, selectedStudent]);

  const setRangeToTerm = () => {
    setStartDate(semesterStartLocal);
    setEndDate(new Date());
  };

  const setRangeToLastDays = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setStartDate(start < semesterStartLocal ? semesterStartLocal : start);
    setEndDate(end);
  };

  const clearStudent = () => {
    setSelectedStudent(null);
    setStudentQuery("");
  };

  const handleExport = async () => {
    if (endDate < startDate) {
      toast({
        title: "Invalid range",
        description: "The end date is before the start date.",
        variant: "destructive",
      });
      return;
    }

    setIsExporting(true);
    setLastResult(null);
    try {
      const result = await buildAttendanceExport({
        start: startDate,
        end: endDate,
        cohort,
        studentId: selectedStudent?.student_id ?? null,
        shape: FORMATS[exportFormat].usesShape ? shape : "summary",
        format: exportFormat,
        mergeExcusedIntoPresent: mergeExcused,
      });

      if (result.rowCount === 0) {
        setLastResult(result);
        toast({
          title: "Nothing to export",
          description: result.notice || "No records matched those filters.",
          variant: "destructive",
        });
        return;
      }

      setLastResult(result);

      // Filling a Canvas export is a two-step: match first, so unmatched rows
      // can be paired by hand before anything is downloaded.
      if (FORMATS[exportFormat].requiresCanvasExport) {
        if (!canvasSheet) {
          toast({
            title: "No Canvas export uploaded",
            description:
              "Upload the CSV from your Canvas Grades page, or switch to a format that builds a file from scratch.",
            variant: "destructive",
          });
          return;
        }
        const found = matchCanvasRows(canvasSheet, result.summary);
        setMatches(found);
        const unmatched = found.filter((m) => !m.studentId).length;
        toast({
          title: "Matched against your Canvas export",
          description: unmatched
            ? `${found.length - unmatched} of ${found.length} rows matched. Pair the rest below, then download.`
            : `All ${found.length} rows matched. Ready to download.`,
        });
        return;
      }

      downloadCsv(result.csv, result.filename);
      toast({
        title: "Export ready",
        description: `${result.filename} — ${result.rowCount} row${
          result.rowCount === 1 ? "" : "s"
        }, ${result.effectiveStart} to ${result.effectiveEnd}.`,
      });
    } catch (error) {
      console.error("Attendance export failed:", error);
      toast({
        title: "Export failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not build the attendance export.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Aggregate figures for the confirmation panel, so the TA can sanity-check
  // the numbers before opening the file.
  const totals = useMemo(() => {
    if (!lastResult || lastResult.summary.length === 0) return null;
    const rows = lastResult.summary;
    const present = rows.reduce((n, r) => n + r.present, 0);
    const absent = rows.reduce((n, r) => n + r.absent, 0);
    const excused = rows.reduce((n, r) => n + r.excused, 0);
    const graded = present + absent;
    return {
      students: rows.length,
      // Distinct dates that counted for at least one cohort in scope — not the
      // per-cohort max, which hides a cohort that met on fewer days.
      classDays: lastResult.sessionDays,
      candidateDays: lastResult.candidateDays,
      present,
      absent,
      excused,
      rate: graded > 0 ? Math.round((present / graded) * 1000) / 10 : 0,
    };
  }, [lastResult]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Export Attendance</DialogTitle>
          <DialogDescription>
            Download attendance counts as a CSV for any date range — every
            cohort or just one, the whole roster or a single student.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Cohort + report shape */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Cohort</label>
              <Select
                value={cohort}
                onValueChange={(value) => {
                  setCohort(value);
                  // A student from another cohort would silently produce an
                  // empty file, so drop the selection when the cohort changes.
                  if (
                    selectedStudent &&
                    value !== "all" &&
                    String(selectedStudent.cohort).toUpperCase() !== value
                  ) {
                    clearStudent();
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All cohorts</SelectItem>
                  {cohortOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      Cohort {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Format</label>
              <Select
                value={exportFormat}
                onValueChange={(value) => setExportFormat(value as ExportFormat)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.entries(FORMATS) as [
                      ExportFormat,
                      (typeof FORMATS)[ExportFormat],
                    ][]
                  ).map(([id, def]) => (
                    <SelectItem key={id} value={id}>
                      {def.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground -mt-3">
            {FORMATS[exportFormat].description}
          </p>

          {/* Canvas round-trip: the export to fill */}
          {FORMATS[exportFormat].requiresCanvasExport && (
            <div className="space-y-2 rounded-lg border p-3">
              <label className="text-sm font-medium">
                Canvas gradebook export
              </label>
              <Input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleCanvasFile(e.target.files?.[0])}
              />
              {canvasSheet ? (
                <p className="text-xs text-muted-foreground">
                  {canvasFileName} · {canvasSheet.rows.length} students ·{" "}
                  {canvasSheet.header.length} existing columns
                  {canvasSheet.pointsPossibleRow
                    ? " · Points Possible row will be filled in"
                    : ""}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  In Canvas: Grades → Export → Export Entire Gradebook. Your
                  existing assignment columns are carried through untouched.
                </p>
              )}
            </div>
          )}

          {/* The summary/detail choice only means something for the app's own
              layout; a gradebook import wants one row per student. */}
          {FORMATS[exportFormat].usesShape && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Report</label>
              <Select
                value={shape}
                onValueChange={(value) => setShape(value as ExportShape)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="summary">
                    Summary — one row per student
                  </SelectItem>
                  <SelectItem value="detail">
                    Daily detail — one row per class day
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Merge excused into present */}
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <Checkbox
              id="merge-excused"
              checked={mergeExcused}
              onCheckedChange={(checked) => setMergeExcused(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <label
                htmlFor="merge-excused"
                className="text-sm font-medium cursor-pointer"
              >
                Count excused days as present
              </label>
              <p className="text-xs text-muted-foreground">
                {mergeExcused
                  ? "Excused days are added to the present count, and the rate is over every class day."
                  : "Excused days are reported separately and left out of the rate entirely."}
              </p>
            </div>
          </div>

          {/* Student scope */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Students</label>
            {selectedStudent ? (
              <div className="flex items-center justify-between p-2 rounded-lg border bg-primary/5">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {selectedStudent.student_id}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      Cohort {selectedStudent.cohort}
                    </Badge>
                  </div>
                  {selectedStudent.name && (
                    <span className="text-sm text-muted-foreground">
                      {selectedStudent.name}
                    </span>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={clearStudent}>
                  <X className="h-4 w-4 mr-1" />
                  All students
                </Button>
              </div>
            ) : (
              <>
                <Input
                  placeholder="All students — type an ID or name to export just one"
                  value={studentQuery}
                  onChange={(e) => setStudentQuery(e.target.value)}
                />
                {studentMatches.length > 0 && (
                  <div className="space-y-1 max-h-40 overflow-y-auto rounded-lg border p-1">
                    {studentMatches.map((student) => (
                      <div
                        key={student.student_id}
                        className="flex items-center justify-between p-2 rounded-md cursor-pointer hover:bg-muted"
                        onClick={() => {
                          setSelectedStudent(student);
                          setStudentQuery("");
                        }}
                      >
                        <span className="font-medium">
                          {student.student_id}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {student.name || "—"} · {student.cohort}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Date range */}
          <div className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <label className="text-sm font-medium">Date range</label>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={setRangeToTerm}>
                  Whole term
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRangeToLastDays(30)}
                >
                  Last 30 days
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRangeToLastDays(7)}
                >
                  Last 7 days
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(startDate, "PP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={(date) => {
                      if (!date) return;
                      setStartDate(date);
                      if (endDate < date) setEndDate(date);
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(endDate, "PP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={(date) => date && setEndDate(date)}
                    disabled={(date) => date < startDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <p className="text-xs text-muted-foreground">
              Only sessions that actually ran are counted — a Tue/Wed/Thu with
              check-ins or a scheduled class date, minus anything cancelled. A
              day the cohort never met is left out entirely rather than marking
              everyone absent.
            </p>
          </div>

          {/* Scope readout */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            {selectedStudent ? (
              <span>Exporting 1 student.</span>
            ) : (
              <span>
                Exporting {studentsInScope} student
                {studentsInScope === 1 ? "" : "s"}
                {cohort === "all" ? " across all cohorts" : ` in cohort ${cohort}`}
                .
              </span>
            )}
          </div>

          {/* Canvas reconciliation */}
          {matches && lastResult && (
            <CanvasMatchPanel
              matches={matches}
              summary={lastResult.summary}
              onAssign={handleAssign}
            />
          )}

          {/* Result of the last export */}
          {lastResult && totals && (
            <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
              <p className="text-sm font-medium">
                {lastResult.effectiveStart} to {lastResult.effectiveEnd} ·{" "}
                {totals.classDays} session
                {totals.classDays === 1 ? "" : "s"} held
                {totals.candidateDays > totals.classDays
                  ? ` of ${totals.candidateDays} possible`
                  : ""}
              </p>
              {/* Canvas asks for this when it meets the new column. */}
              {exportFormat === "canvas" && (
                <p className="text-xs text-muted-foreground">
                  Set Points Possible to {totals.classDays} when Canvas asks.
                </p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{totals.students} students</span>
                <span>
                  {totals.present} present
                  {mergeExcused ? " (incl. excused)" : ""}
                </span>
                <span>{totals.absent} absent</span>
                <span>
                  {totals.excused} excused
                  {mergeExcused ? " (counted above)" : ""}
                </span>
                <span className="font-medium text-foreground">
                  {totals.rate}% attendance
                </span>
              </div>
              {lastResult.notice && (
                <p className="text-xs text-muted-foreground">
                  {lastResult.notice}
                </p>
              )}
            </div>
          )}
          {lastResult && !totals && lastResult.notice && (
            <p className="text-sm text-muted-foreground">{lastResult.notice}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={handleExport}
            disabled={
              isExporting ||
              (FORMATS[exportFormat].requiresCanvasExport && !canvasSheet)
            }
            variant={matches ? "outline" : "default"}
          >
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Building…
              </>
            ) : FORMATS[exportFormat].requiresCanvasExport ? (
              <>
                <Users className="h-4 w-4 mr-2" />
                {matches ? "Re-match" : "Match students"}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </>
            )}
          </Button>
          {matches && (
            <Button onClick={handleDownloadFilled}>
              <Download className="h-4 w-4 mr-2" />
              Download filled CSV
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AttendanceExportDialog;
