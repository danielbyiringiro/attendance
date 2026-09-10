import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  setAttendanceState,
  stateLabel,
  type AttendanceLog,
} from "@/lib/api/attendance";
import type { AttendanceState, CohortRow } from "@/lib/api/types";
import type { StudentStanding } from "@/components/ta/StudentRoster";
import { editStudent, type StudentEdit } from "@/lib/api/enrolment";
import { fromDateStr } from "@/lib/dates";
import { format } from "date-fns";

interface StudentDetailDialogProps {
  student: StudentStanding | null;
  /** The class this record belongs to, for a cohort move. */
  classId: string;
  /** Cohorts of that class, so the student can be moved between them. */
  cohorts: CohortRow[];
  log: AttendanceLog | null;
  threshold: number;
  onOpenChange: (open: boolean) => void;
  /** Called after a correction, so the list behind can re-read. */
  onChanged: () => void;
}

const EDITABLE: AttendanceState[] = [
  "present",
  "late",
  "excused",
  "unexcused",
  "exempted",
];

const STATE_STYLE: Record<string, string> = {
  present: "bg-success/15 text-success",
  // Late is attendance, but not the same thing as on time.
  late: "bg-warning/15 text-warning",
  excused: "bg-primary/10 text-primary",
  exempted: "bg-primary/10 text-primary",
  unexcused: "bg-destructive/10 text-destructive",
  pending: "bg-muted text-muted-foreground",
};

/** One student's whole record in this class, session by session. */
const StudentDetailDialog = ({
  student,
  classId,
  cohorts,
  log,
  threshold,
  onOpenChange,
  onChanged,
}: StudentDetailDialogProps) => {
  const { toast } = useToast();
  // One edit form for the whole student, not three controls scattered about.
  // `form` is null when not editing; entering it snapshots what is on record,
  // and saving sends only the fields that actually differ.
  const [form, setForm] = useState<{
    name: string;
    studentId: string;
    cohortId: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  /*
   * One date out of a term.
   *
   * A student's record runs to every session their cohort has held, which by
   * the end of a term is forty-odd rows. Somebody opens this because a student
   * is disputing one particular day, and scrolling to find it is the whole
   * task before the actual task.
   */
  const [onDate, setOnDate] = useState("");

  useEffect(() => {
    setOnDate("");
  }, [student?.student_id]);

  const marks = useMemo(() => {
    if (!student || !log) return [];
    return [...(log.byStudent.get(student.student_id) ?? [])]
      .filter((m) => !onDate || m.session_date === onDate)
      .sort((a, b) => b.session_date.localeCompare(a.session_date));
  }, [student, log, onDate]);

  /** Every session date this student has, for the bounds on the picker. */
  const allDates = useMemo(() => {
    if (!student || !log) return [];
    return (log.byStudent.get(student.student_id) ?? []).map(
      (m) => m.session_date,
    );
  }, [student, log]);

  const handleCorrect = async (sessionId: string, state: AttendanceState) => {
    if (!student) return;
    setSavingId(sessionId);
    try {
      await setAttendanceState(sessionId, student.student_id, state);
      toast({
        title: "Corrected",
        description: `Recorded as ${stateLabel(state).toLowerCase()}. The change is logged.`,
      });
      onChanged();
    } catch (e) {
      toast({
        title: "Could not save the correction",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setSavingId(null);
    }
  };

  const startEditing = () => {
    if (!student) return;
    setForm({
      name: student.name ?? "",
      studentId: student.student_id,
      cohortId: cohorts.find((c) => c.label === student.cohort)?.id ?? "",
    });
  };

  const save = async () => {
    if (!student || !form) return;

    // Only what actually differs. Key presence is what the server reads as
    // "change this", so sending an unchanged field would be a needless write —
    // and for the ID, a needless rewrite of every attendance record.
    const changes: StudentEdit = {};

    const name = form.name.trim() || null;
    if (name !== (student.name ?? null)) changes.name = name;

    const id = form.studentId.trim();
    if (id && id !== student.student_id) changes.student_id = id;

    const currentCohortId = cohorts.find((c) => c.label === student.cohort)?.id;
    if (form.cohortId && form.cohortId !== currentCohortId) {
      changes.cohort_id = form.cohortId;
    }

    if (Object.keys(changes).length === 0) {
      setForm(null);
      return;
    }

    setIsSaving(true);
    try {
      const saved = await editStudent(student.student_id, changes);

      // Say what moved rather than just "saved". An ID change carries every
      // attendance record with it, and that is worth seeing confirmed.
      const parts: string[] = [];
      if (changes.name !== undefined) {
        parts.push(saved.name ? `now ${saved.name}` : "name cleared");
      }
      if (saved.cohort_label) parts.push(`moved to Cohort ${saved.cohort_label}`);
      if (saved.previous_id) {
        parts.push(
          `${saved.previous_id} → ${saved.student_id}, taking ${
            saved.attendance_records ?? 0
          } attendance record${saved.attendance_records === 1 ? "" : "s"}`,
        );
      }

      setForm(null);
      toast({ title: "Student updated", description: parts.join(" · ") });
      onChanged();

      // The record on screen is now describing somebody who has moved or been
      // renamed. Close rather than leave stale numbers to act on.
      onOpenChange(false);
    } catch (e) {
      // Nothing was written: the whole edit is one transaction.
      toast({
        title: "Nothing was changed",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={student !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {student && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {student.name || student.student_id}
                <Badge variant="outline">Cohort {student.cohort}</Badge>
                {/*
                  One door into editing, not three. A name comes from whatever
                  roster was uploaded and rosters are wrong — misspelt,
                  surname-first, absent because the export had no name column,
                  or carrying the wrong ID entirely. The person looking at the
                  record is the one who knows, and they should be able to fix
                  all of it in one go.
                */}
                {form === null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground"
                    onClick={startEditing}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    Edit student
                  </Button>
                )}
              </DialogTitle>
              <DialogDescription>
                {student.name ? `${student.student_id} · ` : ""}
                {student.sessions} session
                {student.sessions === 1 ? "" : "s"} on record in this class.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                { label: "Rate", value: student.sessions === 0 ? "—" : `${student.rate}%` },
                { label: "Present", value: student.present },
                { label: "Late", value: student.late },
                { label: "Excused", value: student.excused },
                { label: "Absent", value: student.absent },
              ].map((stat) => (
                <div key={stat.label} className="rounded-md border px-3 py-2">
                  <p
                    className={`text-xl font-bold tabular-nums ${
                      stat.label === "Rate" && student.sessions > 0
                        ? student.rate >= threshold
                          ? "text-success"
                          : "text-destructive"
                        : stat.label === "Absent" && student.absent > 0
                          ? "text-destructive"
                          : ""
                    }`}
                  >
                    {stat.value}
                  </p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>

            {student.sessions > 0 && student.rate < threshold && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Below the {threshold}% this class requires.
              </p>
            )}

            {form !== null && (
              /*
                One form for the whole student. Three separate controls invited
                three separate saves, and an ID change is not the kind of thing
                that should happen the moment somebody stops typing.

                It is one call, so it is one transaction: if the ID is refused,
                the name and cohort do not quietly change anyway.
              */
              <div className="space-y-3 rounded-md border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Name
                    </label>
                    <Input
                      autoFocus
                      value={form.name}
                      placeholder="Their name"
                      className="h-9"
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      One person is one record, so this is the name every class
                      they take will show.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      Cohort
                    </label>
                    <Select
                      value={form.cohortId}
                      onValueChange={(v) => setForm({ ...form, cohortId: v })}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Choose a cohort" />
                      </SelectTrigger>
                      <SelectContent>
                        {cohorts.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            Cohort {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Changes which sessions they count as absent from.
                    </p>
                  </div>

                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Student ID
                    </label>
                    <Input
                      value={form.studentId}
                      className="h-9 font-mono"
                      onChange={(e) =>
                        setForm({ ...form, studentId: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      What they type at check-in — if it is wrong, nothing they
                      type matches and they are marked absent. Changing it
                      carries their {student.sessions} session
                      {student.sessions === 1 ? "" : "s"} and every flag with
                      them. An ID another student already has is refused.
                    </p>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isSaving}
                    onClick={() => setForm(null)}
                  >
                    <X className="mr-1 h-4 w-4" />
                    Cancel
                  </Button>
                  <Button size="sm" disabled={isSaving} onClick={() => void save()}>
                    {isSaving ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-1 h-4 w-4" />
                    )}
                    Save changes
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  Session by session
                  {onDate && allDates.length > 0 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      · {marks.length} of {allDates.length}
                    </span>
                  )}
                </p>

                <div className="flex items-center gap-1">
                  <Input
                    type="date"
                    className="h-8 w-[9.5rem]"
                    value={onDate}
                    min={allDates[allDates.length - 1]}
                    max={allDates[0]}
                    onChange={(e) => setOnDate(e.target.value)}
                    title="Show one date"
                  />
                  {onDate && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setOnDate("")}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              {marks.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {onDate
                    ? "This student's cohort held no session on that date."
                    : "No sessions have been closed for this student's cohort yet."}
                </p>
              ) : (
                marks.map((m) => (
                  <div
                    key={m.session_id}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm">
                        {format(fromDateStr(m.session_date), "EEE d MMM yyyy")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.marked_at
                          ? `Marked ${format(new Date(m.marked_at), "h:mm a")}`
                          : "No check-in"}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          STATE_STYLE[m.state] ?? "bg-muted text-muted-foreground"
                        }`}
                      >
                        {stateLabel(m.state)}
                      </span>
                      {savingId === m.session_id ? (
                        <Loader2 className="h-4 w-4 animate-spin opacity-60" />
                      ) : (
                        <Select
                          value={m.state}
                          onValueChange={(v) =>
                            handleCorrect(m.session_id, v as AttendanceState)
                          }
                        >
                          <SelectTrigger className="h-8 w-[7.5rem]">
                            <SelectValue placeholder="Change" />
                          </SelectTrigger>
                          <SelectContent>
                            {EDITABLE.map((state) => (
                              <SelectItem key={state} value={state}>
                                {stateLabel(state)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Changing a state here is a correction: the database records what it
              was, what it became and who changed it, so a mark cannot be
              altered without leaving a trail.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default StudentDetailDialog;
