import { useMemo, useState } from "react";
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
import {
  changeStudentId,
  moveToCohort,
  updateStudent,
} from "@/lib/api/enrolment";
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
  // Editing the name in place. `draft` is null when not editing, so an empty
  // string stays a legitimate value — clearing a name is allowed.
  const [draft, setDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Correcting the ID is separate from the name: it moves every attendance
  // record the person has, so it is deliberately not one keystroke away.
  const [idDraft, setIdDraft] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const marks = useMemo(() => {
    if (!student || !log) return [];
    return [...(log.byStudent.get(student.student_id) ?? [])].sort((a, b) =>
      b.session_date.localeCompare(a.session_date),
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

  const saveName = async () => {
    if (!student || draft === null) return;

    setIsSaving(true);
    try {
      const saved = await updateStudent(student.student_id, draft.trim() || null);
      setDraft(null);
      toast({
        title: saved.name ? "Name updated" : "Name cleared",
        description: `${student.student_id} now shows as ${saved.name ?? "their ID"} in every class they take.`,
      });
      onChanged();
    } catch (e) {
      toast({
        title: "Could not update the name",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveId = async () => {
    if (!student || idDraft === null) return;

    const next = idDraft.trim();
    if (!next || next === student.student_id) {
      setIdDraft(null);
      return;
    }

    setIsSaving(true);
    try {
      const moved = await changeStudentId(student.student_id, next);
      setIdDraft(null);
      toast({
        title: `Now ${moved.student_id}`,
        description: `${moved.attendance_records ?? 0} attendance record${
          moved.attendance_records === 1 ? "" : "s"
        } and ${moved.enrolments ?? 0} enrolment${
          moved.enrolments === 1 ? "" : "s"
        } moved with them.`,
      });
      onChanged();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not change the ID",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const changeCohort = async (cohortId: string) => {
    if (!student) return;

    setIsMoving(true);
    try {
      await moveToCohort(classId, student.student_id, cohortId);
      const label = cohorts.find((c) => c.id === cohortId)?.label ?? "";
      toast({
        title: `Moved to Cohort ${label}`,
        description:
          "Their attendance is now counted against that cohort's sessions, which changes what they count as absent from.",
      });
      onChanged();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not move them",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <Dialog open={student !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {student && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {draft === null ? (
                  <>
                    {student.name || student.student_id}
                    <Badge variant="outline">Cohort {student.cohort}</Badge>
                    {/*
                      A name comes from whatever roster was uploaded, and
                      rosters are wrong: misspelt, surname-first, or absent
                      because the export had no name column. The person looking
                      at the record is the one who knows.
                    */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground"
                      onClick={() => setDraft(student.name ?? "")}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      {student.name ? "Edit name" : "Add a name"}
                    </Button>
                  </>
                ) : (
                  <div className="flex w-full items-center gap-2">
                    <Input
                      autoFocus
                      value={draft}
                      placeholder="Their name"
                      className="h-9"
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveName();
                        if (e.key === "Escape") setDraft(null);
                      }}
                    />
                    <Button size="sm" disabled={isSaving} onClick={() => void saveName()}>
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isSaving}
                      onClick={() => setDraft(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </DialogTitle>
              <DialogDescription>
                {draft !== null ? (
                  <>
                    {student.student_id} · one person is one record here, so
                    this name is what every class they take will show. Their ID
                    cannot be changed — it is what every attendance record hangs
                    on.
                  </>
                ) : (
                  <>
                    {student.name ? `${student.student_id} · ` : ""}
                    {student.sessions} session
                    {student.sessions === 1 ? "" : "s"} on record in this class.
                  </>
                )}
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

            {/*
              The two edits that are not the name.

              Both move attendance rather than just relabelling something, so
              both close the dialog and re-read behind it — leaving a stale
              record on screen after moving its owner is how somebody makes the
              next change against numbers that no longer apply.
            */}
            <div className="grid gap-3 rounded-md border px-3 py-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Cohort
                </label>
                <Select
                  value={cohorts.find((c) => c.label === student.cohort)?.id ?? ""}
                  onValueChange={(v) => void changeCohort(v)}
                  disabled={isMoving || cohorts.length === 0}
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

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Student ID
                </label>

                {idDraft === null ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">
                      {student.student_id}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground"
                      onClick={() => setIdDraft(student.student_id)}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Correct
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      value={idDraft}
                      className="h-9 font-mono"
                      onChange={(e) => setIdDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveId();
                        if (e.key === "Escape") setIdDraft(null);
                      }}
                    />
                    <Button size="sm" disabled={isSaving} onClick={() => void saveId()}>
                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isSaving}
                      onClick={() => setIdDraft(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  {idDraft === null
                    ? "What they type at check-in. If it is wrong, nothing they type matches and they are marked absent."
                    : `Their ${student.sessions} session${student.sessions === 1 ? "" : "s"} and every flag move with them. An ID another student already has will be refused.`}
                </p>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Session by session</p>
              {marks.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No sessions have been closed for this student's cohort yet.
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
