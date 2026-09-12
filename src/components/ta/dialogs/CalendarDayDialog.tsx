import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Ban, CalendarOff, Loader2, PencilLine, Plus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import SessionActions from "@/components/ta/SessionActions";
import {
  clearNoClassDay,
  createAdHocSession,
  setNoClassDay,
  type NoClassMode,
} from "@/lib/api/sessions";
import type { CohortRow, SessionRow } from "@/lib/api/types";

export interface DayOff {
  on_date: string;
  mode: NoClassMode;
  reason: string;
  cohort_id: string | null;
}

/**
 * One day of the calendar, and everything you can do to it.
 *
 * This is what makes the month view editable without answering the dragging
 * question. Dragging is ambiguous — move this session, or change the pattern
 * from here on — while clicking a day is not: you get that day, and the actions
 * that apply to it.
 *
 * Nothing here is new behaviour. Open and close come from SessionActions, edit
 * and cancel from the dialogs the list uses, and adding a date or declaring a
 * day off from the same two RPCs the list and the days-off panel call. The
 * calendar is another way in, not a second implementation.
 */
const CalendarDayDialog = ({
  date,
  classId,
  cohorts,
  sessions,
  dayOff,
  timezone,
  onClose,
  onChanged,
  onEdit,
  onCancelSession,
}: {
  /** YYYY-MM-DD, or null when the dialog is shut. */
  date: string | null;
  classId: string;
  cohorts: CohortRow[];
  /** The sessions already on this day. */
  sessions: SessionRow[];
  dayOff: DayOff | null;
  timezone: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  /** Handed up, because the edit dialog cannot sit inside this one. */
  onEdit: (s: SessionRow) => void;
  onCancelSession: (s: SessionRow) => void;
}) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addCohort, setAddCohort] = useState("");
  const [addTime, setAddTime] = useState("09:00");
  const [declaring, setDeclaring] = useState(false);
  const [mode, setMode] = useState<NoClassMode>("exempt");
  const [reason, setReason] = useState("");

  const label = (id: string) => cohorts.find((c) => c.id === id)?.label ?? "?";

  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });

  const pretty = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

  const handleAdd = async () => {
    if (!date) return;
    if (!addCohort) {
      toast({
        title: "Pick a cohort",
        description: "A session belongs to one cohort, not the whole class.",
        variant: "destructive",
      });
      return;
    }
    setBusy("add");
    try {
      const r = await createAdHocSession(addCohort, date, addTime);
      toast({
        title: "Session added",
        description: r.outside_term
          ? `Cohort ${r.cohort}. Outside the term, so it will not appear in term-wide figures.`
          : `Cohort ${r.cohort}. A schedule change will not move or remove it.`,
      });
      setAdding(false);
      await onChanged();
    } catch (e) {
      toast({
        title: "Could not add the session",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDeclare = async () => {
    if (!date) return;
    if (!reason.trim()) {
      toast({
        title: "Say why",
        description:
          "A day that stops counting needs a reason, or a student's record cannot explain itself later.",
        variant: "destructive",
      });
      return;
    }
    setBusy("declare");
    try {
      const r = await setNoClassDay(classId, date, mode, reason.trim());
      const parts: string[] = [];
      if (r.removed > 0) parts.push(`${r.removed} empty session removed`);
      if (r.sessions > 0) parts.push(`${r.sessions} marked`);
      toast({
        title: mode === "exempt" ? "Day off recorded" : "Day credited",
        description:
          parts.length === 0
            ? "Nothing was scheduled, and nothing will be created here now."
            : `${parts.join(", ")}. Regenerating will not put it back.`,
      });
      setDeclaring(false);
      setReason("");
      await onChanged();
    } catch (e) {
      toast({
        title: "Could not set the day",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleClearDay = async () => {
    if (!date || !dayOff) return;
    setBusy("clear");
    try {
      await clearNoClassDay(classId, date, dayOff.cohort_id ?? undefined);
      toast({
        title: "Day cleared",
        description:
          "Sessions here are scheduled again. Check-ins that were replaced do not come back.",
      });
      await onChanged();
    } catch (e) {
      toast({
        title: "Could not clear it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={date !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{pretty}</DialogTitle>
          <DialogDescription>
            {sessions.length === 0
              ? "Nothing scheduled."
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"}.`}
          </DialogDescription>
        </DialogHeader>

        {dayOff && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {dayOff.mode === "exempt"
                  ? "Declared off — does not count"
                  : "Declared — counts as attended"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {dayOff.reason}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === "clear"}
              onClick={() => void handleClearDay()}
            >
              {busy === "clear" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="mr-1 h-4 w-4" />
              )}
              Remove
            </Button>
          </div>
        )}

        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium tabular-nums">
                  {timeOf(s.starts_at)}
                </span>
                <Badge variant="outline" className="text-xs">
                  {label(s.cohort_id)}
                </Badge>
                <Badge variant="secondary" className="text-xs">
                  {s.status}
                </Badge>
                {s.status === "open" && s.pin && (
                  <span className="rounded bg-gradient-primary px-2 py-0.5 font-mono text-xs tracking-widest text-primary-foreground">
                    {s.pin}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <SessionActions session={s} onChanged={onChanged} />
                {s.status === "scheduled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Change the day or time"
                    onClick={() => onEdit(s)}
                  >
                    <PencilLine className="h-4 w-4" />
                  </Button>
                )}
                {s.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Cancel this class"
                    onClick={() => onCancelSession(s)}
                  >
                    <Ban className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Add a session here */}
        {adding ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="day-cohort">Cohort</Label>
                <Select value={addCohort} onValueChange={setAddCohort}>
                  <SelectTrigger id="day-cohort">
                    <SelectValue placeholder="Which cohort?" />
                  </SelectTrigger>
                  <SelectContent>
                    {cohorts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        Cohort {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="day-time">Starts</Label>
                <Input
                  id="day-time"
                  type="time"
                  value={addTime}
                  onChange={(e) => setAddTime(e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleAdd()} disabled={busy === "add"}>
                {busy === "add" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Add it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : declaring ? (
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid gap-2">
              {(
                [
                  ["exempt", "Does not count", "The day leaves the calculation."],
                  ["present", "Counts as attended", "Everybody is credited."],
                ] as Array<[NoClassMode, string, string]>
              ).map(([m, title, note]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-md border p-2 text-left text-sm transition-colors ${
                    mode === m ? "border-primary bg-primary/5" : "hover:border-primary/40"
                  }`}
                >
                  <span className="font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">{note}</span>
                </button>
              ))}
            </div>
            <Input
              value={reason}
              placeholder="Reason, e.g. public holiday"
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Applies to every cohort. Check-ins already here are replaced.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void handleDeclare()}
                disabled={busy === "declare"}
              >
                {busy === "declare" && (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                )}
                Set it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeclaring(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(dayOff)}
              title={
                dayOff
                  ? "This day is declared off. Remove that first."
                  : undefined
              }
              onClick={() => {
                setAdding(true);
                setAddCohort(cohorts[0]?.id ?? "");
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add a session
            </Button>
            {!dayOff && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDeclaring(true)}
              >
                <CalendarOff className="mr-1 h-4 w-4" />
                Set as a day off
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default CalendarDayDialog;
