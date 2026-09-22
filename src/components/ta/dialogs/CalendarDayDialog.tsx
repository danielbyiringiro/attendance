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
import { useResetOnOpen } from "@/lib/useResetOnOpen";
import SessionActions from "@/components/ta/SessionActions";
import {
  clearNoClassDay,
  NO_CLASS_HUES,
  createAdHocSessions,
  describeAdd,
  setNoClassDay,
  untilFor,
  updateSession,
  type AddScope,
  type NoClassDay,
  type NoClassHue,
  type NoClassMode,
} from "@/lib/api/sessions";
import type { CohortRow, SessionRow } from "@/lib/api/types";
import ConfirmDelete from "@/components/ta/ConfirmDelete";
import HuePicker from "@/components/ta/HuePicker";
import { HUE_BG } from "@/components/ta/dayOffHues";

/**
 * The declared day this dialog is looking at. The same row listNoClassDays
 * returns, without its id — the dialog addresses a day off by its date, which
 * is what set_no_class_day and clear_no_class_day both take.
 */
export type DayOff = Omit<NoClassDay, "id">;

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
  termEndsOn,
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
  /** Caps "for the rest of term" at the class's own end date. */
  termEndsOn: string;
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
  const [addScope, setAddScope] = useState<AddScope>("day");
  const [addUntil, setAddUntil] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const [mode, setMode] = useState<NoClassMode>("exempt");
  const [hue, setHue] = useState<NoClassHue>("amber");
  const [reason, setReason] = useState("");

  // Each day opens on the day itself, not on whichever form — adding a
  // session, setting a day off — was left open for the last one.
  useResetOnOpen(date, () => {
    setAdding(false);
    setDeclaring(false);
    setMode("exempt");
    setReason("");
    setAddTime("09:00");
    setAddScope("day");
    setAddUntil("");
  });

  const label = (id: string) => cohorts.find((c) => c.id === id)?.label ?? "?";

  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });

  const weekday = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
      })
    : "";

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
      const r = await createAdHocSessions(addCohort, date, addTime, {
        to: untilFor(addScope, date, addUntil, termEndsOn),
      });
      toast({
        title: r.created === 1 ? "Session added" : "Sessions added",
        description: describeAdd(r),
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
      const r = await setNoClassDay(classId, date, mode, reason.trim(), undefined, hue);
      const parts: string[] = [];
      if (r.removed > 0) parts.push(`${r.removed} empty session removed`);
      if (r.sessions > 0) parts.push(`${r.sessions} marked`);
      toast({
        title: r.edited
          ? "Day off updated"
          : mode === "exempt"
            ? "Day off recorded"
            : "Day credited",
        description:
          parts.length === 0
            ? // 052 returns zeroes for a words-only correction, which is a
              // different fact from "nothing was scheduled here". Saying the
              // wrong one would have people checking whether they lost a
              // session they never had.
              r.edited
              ? "Only the wording and the colour changed. No attendance was touched."
              : "Nothing was scheduled, and nothing will be created here now."
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

  /*
   * 048, applied to this date.
   *
   * Session by session rather than through one RPC: update_session already
   * knows what may be changed — it refuses anything that has run — and a
   * day-shaped variant of it would be a second place for that rule to live.
   * A day holds a handful of sessions, so the loop costs nothing.
   */
  const scheduledToday = sessions.filter((s) => s.status === "scheduled");

  const setDayRule = async (closesAtStart: boolean) => {
    if (scheduledToday.length === 0) return;
    setBusy("rule");
    try {
      for (const s of scheduledToday) {
        await updateSession(s.id, { closesAtStart });
      }
      toast({
        title: closesAtStart
          ? "Check-in shuts at the start here"
          : "Check-in uses the sign-up window here",
        description: `${scheduledToday.length} session${
          scheduledToday.length === 1 ? "" : "s"
        } on this date changed. The weekly pattern is untouched.`,
      });
      await onChanged();
    } catch (e) {
      toast({
        title: "Could not change this day",
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

        {dayOff && !declaring && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className={`h-8 w-1.5 shrink-0 rounded-full ${HUE_BG[dayOff.hue]}`}
              />
              <div className="min-w-0">
                {/* The reason first: it is what the day IS. The mode second,
                    because it is what the day DOES, and one does not imply the
                    other — "field trip" says nothing about who got credit. */}
                <p className="truncate text-sm font-medium">{dayOff.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {dayOff.mode === "exempt"
                    ? "Does not count — nobody is helped or harmed by it"
                    : "Counts as attended — everybody is credited"}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setReason(dayOff.reason);
                setMode(dayOff.mode);
                setHue(dayOff.hue);
                setDeclaring(true);
              }}
            >
              <PencilLine className="mr-1 h-4 w-4" />
              Edit
            </Button>
            <ConfirmDelete
              label="Remove"
              confirmLabel="Yes, remove it"
              warning="Sessions are scheduled on this date again. Check-ins that were replaced when the day was declared off do not come back."
              size="sm"
              icon={<X className="mr-1 h-4 w-4" />}
              isWorking={busy === "clear"}
              resetKey={date}
              onConfirm={() => void handleClearDay()}
            />
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
                    variant="outline"
                    title="Change the time, length or check-in rules — for this session or its run"
                    onClick={() => onEdit(s)}
                  >
                    <PencilLine className="mr-1 h-4 w-4" />
                    Edit
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

        {/*
          048, for this date. The class setting lives on Class → Settings and
          the weekly one on the pattern; this is the day somebody wants the
          register shut at the door, or the day the usual rule should not apply.

          Only sessions that have not run yet: update_session refuses the rest,
          because their attendance is already recorded against the old rule.
        */}
        {scheduledToday.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">Check-in on this day</p>
              <p className="text-xs text-muted-foreground">
                {scheduledToday.length} session
                {scheduledToday.length === 1 ? "" : "s"} not yet run
                {sessions.length > scheduledToday.length &&
                  `, of ${sessions.length} here`}
                .
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === "rule"}
                onClick={() => void setDayRule(true)}
              >
                {busy === "rule" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : null}
                Shut at the start
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === "rule"}
                onClick={() => void setDayRule(false)}
              >
                Use the sign-up window
              </Button>
            </div>
          </div>
        )}

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
            {/* Same three choices as the list, same wording. */}
            <div className="grid gap-1">
              {(
                [
                  // Worded the way a calendar app words it, with the day
                  // named: "every Tuesday" is unambiguous where "weekly" left
                  // people checking whether it meant every day of the week.
                  ["day", "Does not repeat"],
                  ["range", `Every ${weekday}, until a date I choose`],
                  ["term", `Every ${weekday}, to the end of term`],
                ] as Array<[AddScope, string]>
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAddScope(value)}
                  className={`rounded-md border px-3 py-1.5 text-left text-sm transition-colors ${
                    addScope === value
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/40"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
            {addScope === "range" && (
              <Input
                type="date"
                value={addUntil}
                min={date ?? undefined}
                onChange={(e) => setAddUntil(e.target.value)}
              />
            )}
            {addScope !== "day" && (
              <p className="text-xs text-muted-foreground">
                Weekly on this weekday, not every day. Dates already taken, or
                declared off, are skipped and reported.
              </p>
            )}

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

            <HuePicker value={hue} onChange={setHue} />

            <p className="text-xs text-muted-foreground">
              Applies to every cohort. The reason is what the calendar shows, so
              write it for somebody reading the month at a glance. Check-ins
              already here are replaced, and students see the reason in their
              history.
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
                setAddScope("day");
                setAddUntil("");
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add a session
            </Button>
            {!dayOff && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setReason("");
                  setMode("exempt");
                  setHue("amber");
                  setDeclaring(true);
                }}
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
