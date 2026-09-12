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
  CalendarPlus,
  Loader2,
  MoreVertical,
  PencilLine,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  createAdHocSessions,
  describeAdd,
  listSessions,
  untilFor,
  type AddScope,
} from "@/lib/api/sessions";
import SessionActions from "@/components/ta/SessionActions";
import SessionEditDialog from "@/components/ta/dialogs/SessionEditDialog";
import SessionCancelDialog from "@/components/ta/dialogs/SessionCancelDialog";
import { markAllPresent } from "@/lib/api/attendance";
import { Checkbox } from "@/components/ui/checkbox";
import type { CohortRow, SessionRow, SessionStatus } from "@/lib/api/types";
import { addDays, toDateStr, todayStr } from "@/lib/dates";

interface SessionListProps {
  classId: string;
  cohorts: CohortRow[];
  /** The class's own timezone, so times read as the room saw them. */
  timezone: string;
  /** Caps "for the rest of term" at the class's own end date. */
  termEndsOn: string;
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
  termEndsOn,
  refreshToken = 0,
}: SessionListProps) => {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("today");
  const [cohortFilter, setCohortFilter] = useState<string>("all");

  const [cancelling, setCancelling] = useState<SessionRow | null>(null);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  /*
   * A one-off date, outside the weekly pattern.
   *
   * Separate state from the edit dialog rather than reusing it: editing moves
   * an existing session and is refused once it has run, while this creates one
   * and has to pick a cohort as well. Sharing the fields would mean one of them
   * carrying a cohort the other must ignore.
   */
  const [adding, setAdding] = useState(false);
  const [addCohort, setAddCohort] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addTime, setAddTime] = useState("09:00");
  const [addDuration, setAddDuration] = useState("");
  /*
   * How far the new session repeats.
   *
   * "day" is one date. "range" and "term" repeat weekly on that weekday, which
   * is what a TA means by picking a Tuesday and saying "to the end of term" —
   * a daily reading would quietly create sixty sessions.
   *
   * These stay instances rather than becoming a rule: the Schedule editor owns
   * the weekly pattern, and anything added here is immune to it.
   */
  const [addScope, setAddScope] = useState<AddScope>("day");
  const [addUntil, setAddUntil] = useState("");

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

  const handleAdd = async () => {
    if (!addCohort) {
      toast({
        title: "Pick a cohort",
        description: "A session belongs to one cohort, not to the whole class.",
        variant: "destructive",
      });
      return;
    }

    setBusyId("adding");
    try {
      const result = await createAdHocSessions(addCohort, addDate, addTime, {
        to: untilFor(addScope, addDate, addUntil, termEndsOn),
        durationMinutes: addDuration.trim() ? Number(addDuration) : undefined,
      });

      toast({
        title: result.created === 1 ? "Session added" : "Sessions added",
        description: describeAdd(result),
      });
      setAdding(false);
      await load();
    } catch (e) {
      toast({
        title: "Could not add the session",
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true);
              setAddCohort(cohortFilter === "all" ? (cohorts[0]?.id ?? "") : cohortFilter);
              setAddDate(todayStr());
              setAddTime("09:00");
              setAddDuration("");
              setAddScope("day");
              setAddUntil("");
            }}
          >
            <CalendarPlus className="mr-1 h-4 w-4" />
            Add a date
          </Button>
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
              /*
                Stacked on a phone, one line above sm.
                
                The action block is shrink-0 and holds "Open check-in" or
                "Close check-in" plus an edit button plus a menu — about 215px
                that will not compress. With the 80px time column, the gaps and
                the padding, the row could not go below roughly 380px, so on a
                375px screen the menu button fell off the edge.
                
                Stacking rather than shrinking, because every part of this row
                is already as small as it can usefully be: the time cannot
                abbreviate, and "Open" without "check-in" stops saying what it
                opens.
              */
              className={`flex flex-col gap-2 rounded-lg px-3 py-2 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${ROW_STYLE[s.status]}`}
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
              <div className="flex flex-wrap items-center gap-1 sm:shrink-0 sm:flex-nowrap">
                <SessionActions session={s} onChanged={load} />

                {/* Retiming one session is a frequent job, so it stays on the
                    row rather than behind the menu. */}
                {s.status === "scheduled" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Change the day or time"
                    disabled={busyId === s.id}
                    onClick={() => setEditing(s)}
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
                        onClick={() => setCancelling(s)}
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

      {/* A date outside the weekly pattern */}
      <Dialog open={adding} onOpenChange={(o) => !o && setAdding(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add a date</DialogTitle>
            <DialogDescription>
              One session on one day, outside the weekly pattern — a catch-up
              class, a moved lecture, an extra lab.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="add-cohort">Cohort</Label>
              <Select value={addCohort} onValueChange={setAddCohort}>
                <SelectTrigger id="add-cohort">
                  <SelectValue placeholder="Which cohort meets?" />
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
                A session belongs to one cohort. Add it again for another.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="add-date">Date</Label>
                <Input
                  id="add-date"
                  type="date"
                  value={addDate}
                  onChange={(e) => setAddDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-time">Starts</Label>
                <Input
                  id="add-time"
                  type="time"
                  value={addTime}
                  onChange={(e) => setAddTime(e.target.value)}
                />
              </div>
            </div>

            {/*
              How far it repeats. Three named choices rather than a date field
              that might be blank: "to the end of term" is the common case and
              reading it off the class saves the TA finding the date.
            */}
            <div className="space-y-2">
              <Label>Repeat</Label>
              <div className="grid gap-1">
                {(
                  [
                    ["day", "Just this date"],
                    ["range", "Weekly, until a date I choose"],
                    ["term", "Weekly, to the end of term"],
                  ] as Array<[AddScope, string]>
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setAddScope(value)}
                    className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
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
                  min={addDate}
                  onChange={(e) => setAddUntil(e.target.value)}
                />
              )}
              {addScope !== "day" && (
                <p className="text-xs text-muted-foreground">
                  Repeats weekly on the same weekday, not every day. Dates
                  already taken, or declared off, are skipped and reported.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-duration">Length (optional)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="add-duration"
                  type="number"
                  min={1}
                  className="w-24"
                  placeholder="60"
                  value={addDuration}
                  onChange={(e) => setAddDuration(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">minutes</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Left blank, it uses the class default.
              </p>
            </div>

            <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Added this way, the session is yours rather than the pattern's.
              Changing the weekly schedule later will neither move it nor remove
              it. The date does not have to fall inside the term.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={busyId === "adding"}>
              {busyId === "adding" && (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              )}
              Add the session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <SessionEditDialog
        session={editing}
        timezone={timezone}
        cohortLabel={editing ? (cohortLabel.get(editing.cohort_id) ?? "?") : ""}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      <SessionCancelDialog
        session={cancelling}
        cohortLabel={
          cancelling ? (cohortLabel.get(cancelling.cohort_id) ?? "?") : ""
        }
        onClose={() => setCancelling(null)}
        onCancelled={load}
      />

    </div>
  );
};

export default SessionList;
