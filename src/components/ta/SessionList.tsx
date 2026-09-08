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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Ban,
  Loader2,
  Lock,
  MoreVertical,
  PencilLine,
  PlayCircle,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cancelSession,
  closeSession,
  listSessions,
  openSession,
  updateSession,
} from "@/lib/api/sessions";
import type { CohortRow, SessionRow, SessionStatus } from "@/lib/api/types";
import { addDays, toDateStr, todayStr } from "@/lib/dates";

interface SessionListProps {
  classId: string;
  cohorts: CohortRow[];
  /** The class's own timezone, so times read as the room saw them. */
  timezone: string;
  /** Bump to force a reload — a schedule change elsewhere. */
  refreshToken?: number;
}

const STATUS_STYLE: Record<SessionStatus, string> = {
  scheduled: "bg-muted text-muted-foreground",
  open: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  closed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
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

// Sessions are grouped by when they are, not filtered by a date range you have
// to type. "What is on today" and "what is coming" were both a two-field date
// exercise before, which is a lot of work to answer a question the screen
// already knows the answer to.
type Bucket = "today" | "week" | "later" | "past";

const BUCKETS: Array<{ id: Bucket; heading: string; empty: string }> = [
  { id: "today", heading: "Today", empty: "Nothing scheduled today." },
  { id: "week", heading: "Next 7 days", empty: "Nothing in the next week." },
  { id: "later", heading: "Later", empty: "Nothing further ahead." },
  { id: "past", heading: "Past", empty: "Nothing yet." },
];

const SessionList = ({
  classId,
  cohorts,
  timezone,
  refreshToken = 0,
}: SessionListProps) => {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("today");
  const [cohortFilter, setCohortFilter] = useState<string>("all");

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
      // The whole term in one read: grouping happens here, so switching between
      // Today and Later is instant rather than another round trip.
      setSessions(await listSessions({ classId }));
    } catch (e) {
      toast({
        title: "Could not load sessions",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, toast, refreshToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const today = todayStr();
    const weekEnd = toDateStr(addDays(new Date(), 7));
    const out: Record<Bucket, SessionRow[]> = {
      today: [],
      week: [],
      later: [],
      past: [],
    };

    sessions
      .filter((s) => cohortFilter === "all" || s.cohort_id === cohortFilter)
      .forEach((s) => {
        if (s.session_date === today) out.today.push(s);
        else if (s.session_date < today) out.past.push(s);
        else if (s.session_date <= weekEnd) out.week.push(s);
        else out.later.push(s);
      });

    out.today.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    out.week.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    out.later.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    // Most recent first: the past is read backwards from now.
    out.past.sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    return out;
  }, [sessions, cohortFilter]);

  const openCount = sessions.filter((s) => s.status === "open").length;

  const run = async (
    session: SessionRow,
    work: () => Promise<void>,
  ): Promise<void> => {
    setBusyId(session.id);
    try {
      await work();
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleOpen = (s: SessionRow) =>
    run(s, async () => {
      try {
        const result = await openSession(s.id);
        toast({
          title: `Open — PIN ${result.pin}`,
          description: "Read this out. It closes on its own when the window ends.",
        });
      } catch (e) {
        toast({
          title: "Could not open the session",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        });
      }
    });

  const handleClose = (s: SessionRow) =>
    run(s, async () => {
      try {
        const absences = await closeSession(s.id);
        toast({
          title: "Session closed",
          description:
            absences === 0
              ? "Everyone enrolled was accounted for."
              : `${absences} student${absences === 1 ? " was" : "s were"} recorded absent.`,
        });
      } catch (e) {
        toast({
          title: "Could not close the session",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        });
      }
    });

  const startEditing = (s: SessionRow) => {
    setEditing(s);
    setEditDate(s.session_date);
    // Read back in the class's timezone, because that is the clock the server
    // resolves the value against when it is sent. Formatting in the viewer's
    // zone would show a TA abroad a time the room never met at, and saving it
    // unchanged would then move the session.
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

  const rows = grouped[bucket];
  const current = BUCKETS.find((b) => b.id === bucket)!;

  return (
    <div className="space-y-3">
      {/* When, and whose. Two rows of chips instead of four date inputs. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {BUCKETS.map((b) => (
            <Button
              key={b.id}
              size="sm"
              variant={bucket === b.id ? "secondary" : "ghost"}
              onClick={() => setBucket(b.id)}
            >
              {b.heading}
              {grouped[b.id].length > 0 && (
                <span className="ml-1.5 text-xs opacity-60">
                  {grouped[b.id].length}
                </span>
              )}
            </Button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {cohorts.length > 1 && (
            <>
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
                  variant={cohortFilter === c.id ? "secondary" : "ghost"}
                  onClick={() => setCohortFilter(c.id)}
                >
                  {c.label}
                </Button>
              ))}
            </>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {openCount > 0 && bucket !== "today" && (
        <button
          type="button"
          onClick={() => setBucket("today")}
          className="w-full rounded-md bg-emerald-500/10 px-3 py-2 text-left text-sm text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400"
        >
          {openCount} session{openCount === 1 ? " is" : "s are"} open right now —
          show today
        </button>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions…
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {sessions.length === 0
            ? "This class has no sessions yet. Set a weekly pattern under Schedule."
            : current.empty}
        </p>
      ) : (
        <div className="max-h-[34rem] space-y-1 overflow-y-auto">
          {rows.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="w-20 shrink-0 tabular-nums">
                  <p className="text-sm font-medium">
                    {timeIn(s.starts_at, timezone)}
                  </p>
                  {bucket !== "today" && (
                    <p className="text-xs text-muted-foreground">
                      {dateOf(s.session_date)}
                    </p>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-xs">
                      {cohortLabel.get(s.cohort_id) ?? "?"}
                    </Badge>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[s.status]}`}
                    >
                      {s.status}
                    </span>
                    {s.status === "open" && s.pin && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-xs tracking-widest text-emerald-700 dark:text-emerald-400">
                        {s.pin}
                      </span>
                    )}
                    {s.moved_manually && (
                      <Badge variant="secondary" className="text-xs">
                        moved
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.duration_minutes} min
                    {s.cancellation_reason && ` · ${s.cancellation_reason}`}
                  </p>
                </div>
              </div>

              {/* One primary action, everything else behind the menu. Three
                  buttons per row made the common case — open, then close —
                  something you had to look for. */}
              <div className="flex shrink-0 items-center gap-1">
                {s.status === "scheduled" && (
                  <Button
                    size="sm"
                    disabled={busyId === s.id}
                    onClick={() => handleOpen(s)}
                  >
                    <PlayCircle className="mr-1 h-4 w-4" />
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
                    <Lock className="mr-1 h-4 w-4" />
                    Close
                  </Button>
                )}
                {s.status === "closed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === s.id}
                    onClick={() => handleOpen(s)}
                  >
                    Reopen
                  </Button>
                )}

                {s.status !== "cancelled" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" disabled={busyId === s.id}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={s.status !== "scheduled"}
                        onClick={() => startEditing(s)}
                      >
                        <PencilLine className="mr-2 h-4 w-4" />
                        {s.status === "scheduled"
                          ? "Move…"
                          : "Move (already run)"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => {
                          setCancelling(s);
                          setReason("");
                        }}
                      >
                        <Ban className="mr-2 h-4 w-4" />
                        Cancel class…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                  {cohortLabel.get(editing.cohort_id)}. Changes this session only
                  — the weekly pattern is left alone.
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
            A session that has already run cannot be moved: attendance is
            recorded against it, and moving it would put those marks on a
            different day.
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
              <Ban className="mr-2 h-4 w-4" />
              Cancel the class
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SessionList;
