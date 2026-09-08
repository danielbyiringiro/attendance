import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Ban, Loader2, Lock, PencilLine, PlayCircle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cancelSession,
  closeSession,
  listSessions,
  openSession,
  updateSession,
} from "@/lib/api/sessions";
import type { CohortRow, SessionRow, SessionStatus } from "@/lib/api/types";

interface SessionListProps {
  classId: string;
  cohorts: CohortRow[];
  /** The class's own timezone, so times read as the room saw them. */
  timezone: string;
  /** Defaults to the last fortnight and the next fortnight. */
  from?: string;
  to?: string;
  /** Bump to force a reload — generating sessions elsewhere on the page. */
  refreshToken?: number;
}

const STATUS_STYLE: Record<SessionStatus, string> = {
  scheduled: "bg-muted text-muted-foreground",
  open: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  closed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
};

const shiftDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

/** An instant as the class's own wall clock, not the viewer's. */
const timeIn = (iso: string, timezone: string, hour12 = true) =>
  new Date(iso).toLocaleTimeString(hour12 ? undefined : "en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  });

const dateOf = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/**
 * The sessions of a class, and the three things a TA does to one.
 *
 * Cancelling lives here rather than in a dialog keyed by date and cohort. That
 * was the old shape, and it is what let cancelling one cohort's Wednesday
 * silently cancel every other cohort's: sessions are not shared, so acting on
 * the row cannot reach past it.
 */
const SessionList = ({
  classId,
  cohorts,
  timezone,
  from,
  to,
  refreshToken = 0,
}: SessionListProps) => {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rangeFrom, setRangeFrom] = useState(from ?? shiftDays(-14));
  const [rangeTo, setRangeTo] = useState(to ?? shiftDays(14));
  const [cancelling, setCancelling] = useState<SessionRow | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editDuration, setEditDuration] = useState("");

  const cohortLabel = useMemo(
    () => new Map(cohorts.map((c) => [c.id, c.label])),
    [cohorts],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setSessions(
        await listSessions({ classId, from: rangeFrom, to: rangeTo }),
      );
    } catch (e) {
      toast({
        title: "Could not load sessions",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
    // refreshToken is not read in the body; it is here so the parent can say
    // "sessions changed under you" without owning this component's state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, rangeFrom, rangeTo, toast, refreshToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleOpen = async (s: SessionRow) => {
    setBusyId(s.id);
    try {
      const result = await openSession(s.id);
      toast({
        title: `Open — PIN ${result.pin}`,
        description: "Read this out. It closes on its own when the window ends.",
      });
      await load();
    } catch (e) {
      toast({
        title: "Could not open the session",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleClose = async (s: SessionRow) => {
    setBusyId(s.id);
    try {
      const absences = await closeSession(s.id);
      toast({
        title: "Session closed",
        description:
          absences === 0
            ? "Everyone enrolled was accounted for."
            : `${absences} student${absences === 1 ? " was" : "s were"} recorded absent.`,
      });
      await load();
    } catch (e) {
      toast({
        title: "Could not close the session",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const startEditing = (s: SessionRow) => {
    setEditing(s);
    setEditDate(s.session_date);
    // Read back in the class's timezone, because that is the clock the server
    // will resolve the value against when it is sent back. Formatting in the
    // viewer's zone would show a TA abroad a time the room never met at, and
    // saving it unchanged would then move the session.
    setEditTime(timeIn(s.starts_at, timezone, false));
    setEditDuration(String(s.duration_minutes));
  };

  const handleEdit = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await updateSession(editing.id, {
        date: editDate || undefined,
        startTime: editTime || undefined,
        durationMinutes: editDuration ? Number(editDuration) : undefined,
      });
      toast({
        title: "Session moved",
        description: "Only this one session changed.",
      });
      setEditing(null);
      await load();
    } catch (e) {
      toast({
        title: "Could not change the session",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async () => {
    if (!cancelling) return;
    setBusyId(cancelling.id);
    try {
      const removed = await cancelSession(cancelling.id, reason.trim() || undefined);
      toast({
        title: "Class cancelled",
        description:
          removed === 0
            ? "Only this cohort's session was affected."
            : `${removed} absence${removed === 1 ? "" : "s"} removed, so it cannot count against anyone. Only this cohort's session was affected.`,
      });
      setCancelling(null);
      setReason("");
      await load();
    } catch (e) {
      toast({
        title: "Could not cancel",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="space-y-1">
          <Label htmlFor="sess-from" className="text-xs">
            From
          </Label>
          <Input
            id="sess-from"
            type="date"
            className="w-40"
            value={rangeFrom}
            onChange={(e) => setRangeFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sess-to" className="text-xs">
            To
          </Label>
          <Input
            id="sess-to"
            type="date"
            className="w-40"
            value={rangeTo}
            onChange={(e) => setRangeTo(e.target.value)}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions…
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sessions in that range. Set a pattern above and generate them.
        </p>
      ) : (
        <div className="space-y-1 max-h-[28rem] overflow-y-auto">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">
                    {dateOf(s.session_date)}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {cohortLabel.get(s.cohort_id) ?? "?"}
                  </Badge>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}
                  >
                    {s.status}
                  </span>
                  {s.moved_manually && (
                    <Badge variant="secondary" className="text-xs">
                      moved
                    </Badge>
                  )}
                  {s.status === "open" && s.pin && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-xs tracking-widest text-emerald-700 dark:text-emerald-400">
                      {s.pin}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {timeIn(s.starts_at, timezone)} · {s.duration_minutes} min
                  {s.cancellation_reason && ` · ${s.cancellation_reason}`}
                </p>
              </div>

              <div className="flex shrink-0 gap-1">
                {s.status === "scheduled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Change the date or time"
                    disabled={busyId === s.id}
                    onClick={() => startEditing(s)}
                  >
                    <PencilLine className="h-4 w-4" />
                  </Button>
                )}
                {s.status !== "cancelled" && s.status !== "open" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === s.id}
                    onClick={() => handleOpen(s)}
                  >
                    <PlayCircle className="h-4 w-4 mr-1" />
                    Open
                  </Button>
                )}
                {s.status === "open" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === s.id}
                    onClick={() => handleClose(s)}
                  >
                    <Lock className="h-4 w-4 mr-1" />
                    Close
                  </Button>
                )}
                {s.status !== "cancelled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Cancel this class"
                    disabled={busyId === s.id}
                    onClick={() => {
                      setCancelling(s);
                      setReason("");
                    }}
                  >
                    <Ban className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move this session</DialogTitle>
            <DialogDescription>
              {editing && (
                <>
                  {dateOf(editing.session_date)}, cohort{" "}
                  {cohortLabel.get(editing.cohort_id)}. This changes one session
                  only — the pattern it came from is left alone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="edit-date">Date</Label>
              <Input
                id="edit-date"
                type="date"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-time">Start</Label>
              <Input
                id="edit-time"
                type="time"
                value={editTime}
                onChange={(e) => setEditTime(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-duration">Length (minutes)</Label>
              <Input
                id="edit-duration"
                type="number"
                min={1}
                value={editDuration}
                onChange={(e) => setEditDuration(e.target.value)}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Only a session that has not run yet can be moved. A closed one has
            attendance recorded against it, so moving it would put those marks
            on a different day.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={busyId !== null}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this class</DialogTitle>
            <DialogDescription>
              {cancelling && (
                <>
                  {dateOf(cancelling.session_date)}, cohort{" "}
                  {cohortLabel.get(cancelling.cohort_id)}. Only this cohort is
                  affected — every other cohort keeps its session that day.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Input
              id="cancel-reason"
              value={reason}
              placeholder="Public holiday"
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Absences already recorded for this session are removed, so a class
              that did not run cannot count against anyone. Anyone who marked
              before it was called off keeps their record.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={busyId !== null}
            >
              <Ban className="h-4 w-4 mr-2" />
              Cancel the class
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SessionList;
