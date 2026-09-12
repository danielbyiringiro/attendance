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
  MoreVertical,
  PencilLine,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cancelSession, listSessions, updateSession } from "@/lib/api/sessions";
import SessionActions from "@/components/ta/SessionActions";
import { markAllPresent } from "@/lib/api/attendance";
import { Checkbox } from "@/components/ui/checkbox";
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
  open: "bg-success/15 text-success",
  closed: "bg-primary/10 text-primary",
  cancelled: "bg-destructive/10 text-destructive",
};

/** An open session is the one being run right now, so its row says so. */
const ROW_STYLE: Record<SessionStatus, string> = {
  scheduled: "border bg-card",
  open: "border-2 border-success/40 bg-success/5 shadow-soft",
  closed: "border bg-card",
  cancelled: "border border-destructive/20 bg-destructive/5",
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
  const [editSignup, setEditSignup] = useState("");
  const [markingAll, setMarkingAll] = useState<SessionRow | null>(null);
  const [overwriteAll, setOverwriteAll] = useState(false);

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

  const startEditing = (s: SessionRow) => {
    setEditing(s);
    setEditDate(s.session_date);
    // Read back in the class's timezone, because that is the clock the server
    // resolves the value against when it is sent. Formatting in the viewer's
    // zone would show a TA abroad a time the room never met at, and saving it
    // unchanged would then move the session.
    setEditTime(timeIn(s.starts_at, timezone, false));
    setEditDuration(String(s.duration_minutes));
    setEditSignup(String(s.auto_close_minutes));
  };

  const handleEdit = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await updateSession(editing.id, {
        date: editDate || undefined,
        startTime: editTime || undefined,
        durationMinutes: editDuration ? Number(editDuration) : undefined,
        autoCloseMinutes: editSignup ? Number(editSignup) : undefined,
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

  // The register went round on paper, or the PIN never went up.
  const handleMarkAll = async () => {
    if (!markingAll) return;
    setBusyId(markingAll.id);
    try {
      const r = await markAllPresent(markingAll.id, { overwrite: overwriteAll });
      const parts = [
        r.filled > 0 && `${r.filled} had no mark`,
        r.changed > 0 && `${r.changed} changed`,
        r.left_alone > 0 && `${r.left_alone} left as ${r.left_alone === 1 ? "it was" : "they were"}`,
      ].filter(Boolean);
      toast({
        title: `${r.filled + r.changed} of ${r.roll} marked present`,
        description:
          parts.length > 0
            ? `${parts.join(", ")}. Every change is logged as a correction.`
            : "Everyone was already accounted for.",
      });
      setMarkingAll(null);
      setOverwriteAll(false);
      await load();
    } catch (e) {
      toast({
        title: "Could not mark the session",
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
            ? "Nothing was recorded against it. Only this cohort's session was affected."
            : `${removed} attendance record${removed === 1 ? "" : "s"} removed, check-ins included — a class that did not happen has no attendance. Only this cohort's session was affected.`,
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
          className="w-full rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-left text-sm text-success transition-colors hover:bg-success/15"
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
              className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 transition-colors ${ROW_STYLE[s.status]}`}
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
                      <span className="rounded bg-gradient-primary px-2 py-0.5 font-mono text-xs tracking-widest text-primary-foreground">
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
                    {s.duration_minutes} min class · {s.auto_close_minutes} min
                    sign-up
                    {s.cancellation_reason && ` · ${s.cancellation_reason}`}
                  </p>
                </div>
              </div>

              {/* One primary action, everything else behind the menu. Three
                  buttons per row made the common case — open, then close —
                  something you had to look for. */}
              <div className="flex shrink-0 items-center gap-1">
                <SessionActions session={s} onChanged={load} />

                {/* Retiming one session is a frequent job, so it stays on the
                    row rather than behind the menu. */}
                {s.status === "scheduled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Change the day or time"
                    disabled={busyId === s.id}
                    onClick={() => startEditing(s)}
                  >
                    <PencilLine className="h-4 w-4" />
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
                        onClick={() => {
                          setMarkingAll(s);
                          setOverwriteAll(false);
                        }}
                      >
                        <UserCheck className="mr-2 h-4 w-4" />
                        Mark everyone present…
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

      <Dialog
        open={markingAll !== null}
        onOpenChange={(o) => !o && setMarkingAll(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark everyone present</DialogTitle>
            <DialogDescription>
              {markingAll && (
                <>
                  {dateOf(markingAll.session_date)}, cohort{" "}
                  {cohortLabel.get(markingAll.cohort_id)}. Everyone on the roster
                  that day is recorded present.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Students with no mark, and anyone already recorded absent, become
              present. An excused absence, an exemption and a late arrival are
              left alone — someone chose those, and "late" says more than
              "present" does.
            </p>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 hover:bg-muted/50">
              <Checkbox
                className="mt-0.5"
                checked={overwriteAll}
                onCheckedChange={(v) => setOverwriteAll(v === true)}
              />
              <span className="text-sm">
                Replace excused and late marks too
                <span className="block text-xs text-muted-foreground">
                  For when the paper register is the record and what is stored
                  is wrong. Exempt students are never changed.
                </span>
              </span>
            </label>

            {markingAll?.status === "scheduled" && (
              <p className="text-xs text-muted-foreground">
                This session has not run yet, so it will also be closed —
                otherwise the marks would not count towards anything.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              Every state this replaces is recorded as a correction, with what it
              was and who changed it.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkingAll(null)}>
              Cancel
            </Button>
            <Button onClick={handleMarkAll} disabled={busyId !== null}>
              <UserCheck className="mr-2 h-4 w-4" />
              Mark everyone present
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 py-2">
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
              <Label htmlFor="edit-duration">Class runs (min)</Label>
              <Input
                id="edit-duration"
                type="number"
                min={1}
                value={editDuration}
                onChange={(e) => setEditDuration(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-signup">Sign-up open (min)</Label>
              <Input
                id="edit-signup"
                type="number"
                min={1}
                value={editSignup}
                onChange={(e) => setEditSignup(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                How long check-in stays open once you open it.
              </p>
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
                  {" "}
                  <strong className="text-foreground">
                    Every attendance record against it is deleted, including
                    anyone who already checked in.
                  </strong>{" "}
                  A class that did not happen has no attendance, and
                  uncancelling does not bring the check-ins back.
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
