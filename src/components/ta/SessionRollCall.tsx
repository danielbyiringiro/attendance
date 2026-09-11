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
import {
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Search,
  SkipForward,
  Undo2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  rosterForSession,
  setAttendanceState,
  stateLabel,
  type SessionAttendee,
} from "@/lib/api/attendance";
import type { AttendanceState, SessionRow } from "@/lib/api/types";

interface SessionRollCallProps {
  session: SessionRow | null;
  cohortLabel: string;
  onOpenChange: (open: boolean) => void;
  /** Re-read the card behind, so its count follows. */
  onChanged: () => void;
}

/**
 * The three calls worth making by hand, in the order a register is read.
 *
 * Each has a key, because the point of a card showing one student is that the
 * next arrives by itself — and then reaching for the mouse is the slow part.
 */
const CALLS: {
  state: AttendanceState;
  label: string;
  key: string;
  className: string;
}[] = [
  {
    state: "present",
    label: "Present",
    key: "P",
    className: "bg-success text-success-foreground hover:bg-success/90",
  },
  {
    state: "unexcused",
    label: "Absent",
    key: "A",
    className:
      "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  },
  {
    state: "excused",
    label: "Excused",
    key: "E",
    className: "bg-primary text-primary-foreground hover:bg-primary/90",
  },
  /*
   * Late was reachable by PIN and by nothing else.
   *
   * mark_attendance has recorded it since 006 — anyone checking in after the
   * late window is stored as `late`, and every rate in the app already counts
   * it as attendance. But a TA taking the register by hand had three buttons,
   * so the student who walked in ten minutes down had to be called present or
   * absent, and neither is true. The state existed and the only way to reach
   * it was to not be in the room when the register was taken.
   */
  {
    state: "late",
    label: "Late",
    key: "L",
    className: "bg-warning text-warning-foreground hover:bg-warning/90",
  },
];

/**
 * Taking the register by hand.
 *
 * The PIN covers the ordinary case; this covers the rest — a session where the
 * projector is down, a student whose phone is flat, a lab where reading the
 * names aloud is simply faster.
 *
 * Marked students LEAVE THE LIST. That is the whole design: reading a register
 * means keeping your place in it, and a list that stays the same length while
 * your eyes move down it is exactly how somebody gets called twice and
 * somebody else not at all. What is left on screen is what is left to do, and
 * the last name marked stays visible with an undo, so a misclick is one click
 * to fix rather than a hunt through a list it has vanished from.
 *
 * Deliberately separate from SessionRosterDialog, which answers the other
 * question — "who is here, and who is not" — and therefore has to keep
 * everybody on screen. Same data, opposite requirement.
 */
const SessionRollCall = ({
  session,
  cohortLabel,
  onOpenChange,
  onChanged,
}: SessionRollCallProps) => {
  const { toast } = useToast();
  const [attendees, setAttendees] = useState<SessionAttendee[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** Marked in this sitting, newest first — the undo trail. */
  const [justMarked, setJustMarked] = useState<SessionAttendee[]>([]);
  /**
   * Somebody pulled to the front out of order.
   *
   * Null means "whoever is next", which is the normal case: the register is
   * read in order and the card advances by itself. Cleared after a mark so it
   * does not stick.
   */
  const [focusId, setFocusId] = useState<string | null>(null);
  /**
   * Passed over for now, in the order they were passed over.
   *
   * Skipping is not a mark and must not become one — somebody whose name you
   * cannot pronounce, or who has stepped out, is not absent. They go to the
   * back so the register keeps moving, and the list still refuses to empty
   * until every one of them has been called.
   */
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setIsLoading(true);
    try {
      setAttendees(await rosterForSession(session.id));
    } catch (e) {
      toast({
        title: "Could not load the roster",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setAttendees([]);
    } finally {
      setIsLoading(false);
    }
  }, [session, toast]);

  useEffect(() => {
    if (session) {
      setQuery("");
      setJustMarked([]);
      setShowDone(false);
      setFocusId(null);
      setSkipped([]);
      void load();
    }
  }, [session, load]);

  /**
   * Still to call.
   *
   * NOT simply "has no record". close_session writes an explicit unexcused row
   * for everybody who never checked in, so the moment a session closes every
   * student has a state and a list of the unmarked is empty — which is what it
   * did before this, on exactly the sessions somebody most wants to correct.
   *
   * A system-written absence is a default, not a judgement: it means nobody
   * looked. So it belongs on the list. A mark made by a person, or by the
   * student's own check-in, is a decision and does not.
   */
  const stillToCall = (a: SessionAttendee) =>
    a.state === null ||
    (a.state === "unexcused" && a.marked_by_role === "system");

  const remaining = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const passedOver = new Map(skipped.map((id, i) => [id, i]));

    return attendees
      .filter(stillToCall)
      .filter(
        (a) =>
          needle === "" ||
          a.student_id.toLowerCase().includes(needle) ||
          (a.name ?? "").toLowerCase().includes(needle),
      )
      // Anybody skipped goes after everybody who has not been, and among
      // themselves in the order they were skipped — so a second pass through
      // the stragglers runs in the same order as the first.
      .sort((a, b) => {
        const x = passedOver.get(a.student_id) ?? -1;
        const y = passedOver.get(b.student_id) ?? -1;
        if (x === y) return 0;
        if (x === -1) return -1;
        if (y === -1) return 1;
        return x - y;
      });
  }, [attendees, query, skipped]);

  const done = useMemo(
    () => attendees.filter((a) => !stillToCall(a)),
    [attendees],
  );

  // Whoever the card is showing: the one pulled forward, else simply the next.
  const current = useMemo(
    () =>
      remaining.find((a) => a.student_id === focusId) ?? remaining[0] ?? null,
    [remaining, focusId],
  );

  const queue = useMemo(
    () => remaining.filter((a) => a.student_id !== current?.student_id),
    [remaining, current],
  );

  const mark = async (attendee: SessionAttendee, state: AttendanceState) => {
    if (!session) return;
    setBusyId(attendee.student_id);

    // Applied here first. A register is read at the pace somebody speaks, and
    // waiting for a round trip between names turns that into a stutter.
    const previous = attendee.state;
    setAttendees((rows) =>
      rows.map((r) =>
        r.student_id === attendee.student_id ? { ...r, state } : r,
      ),
    );

    try {
      await setAttendanceState(session.id, attendee.student_id, state);
      setJustMarked((rows) => [
        { ...attendee, state },
        ...rows.filter((r) => r.student_id !== attendee.student_id),
      ]);
      // Back to "whoever is next": a pull-forward is for one student, not a
      // mode somebody has to remember to leave.
      setFocusId(null);
      setSkipped((ids) => ids.filter((id) => id !== attendee.student_id));
      onChanged();
    } catch (e) {
      // Put it back. Leaving the optimistic value would show a mark that does
      // not exist, and the register would be wrong in the direction nobody
      // checks.
      setAttendees((rows) =>
        rows.map((r) =>
          r.student_id === attendee.student_id ? { ...r, state: previous } : r,
        ),
      );
      toast({
        title: `Could not mark ${attendee.name || attendee.student_id}`,
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Pass over the student on the card.
   *
   * Deliberately writes nothing. The register is a record of what somebody
   * determined, and "I will come back to you" is not a determination.
   */
  const skip = (attendee: SessionAttendee) => {
    setSkipped((ids) => [
      ...ids.filter((id) => id !== attendee.student_id),
      attendee.student_id,
    ]);
    setFocusId(null);
  };

  /**
   * Put somebody back on the list.
   *
   * There is no way to delete an attendance record through the API, and there
   * should not be — a record is a fact about a session. So this returns them
   * to the unmarked list in this dialog only; the row stays as it was until
   * they are marked again. Saying so plainly beats implying the mark is gone.
   */
  const undo = (attendee: SessionAttendee) => {
    setAttendees((rows) =>
      rows.map((r) =>
        r.student_id === attendee.student_id ? { ...r, state: null } : r,
      ),
    );
    setJustMarked((rows) =>
      rows.filter((r) => r.student_id !== attendee.student_id),
    );
  };

  /**
   * P, A and E call the student on the card.
   *
   * The card advances on its own, so without keys the whole flow is
   * mouse-to-button-back-to-list for every name. Ignored while somebody is
   * typing in the search box, and while a mark is in flight — a second press
   * mid-request would race the optimistic update.
   */
  useEffect(() => {
    if (!session || !current || busyId) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;

      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        skip(current);
        return;
      }

      const call = CALLS.find(
        (c) => c.key.toLowerCase() === e.key.toLowerCase(),
      );
      if (!call) return;

      e.preventDefault();
      void mark(current, call.state);
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `mark` is redefined every render; depending on it would rebind the
    // listener constantly. The student and the in-flight flag are what
    // actually decide what a keypress should do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, current, busyId]);

  const total = attendees.length;
  const marked = done.length;
  const defaulted = attendees.filter(
    (a) => a.state === "unexcused" && a.marked_by_role === "system",
  ).length;

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col gap-0 p-4 sm:p-6">
        <DialogHeader className="shrink-0 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Take the register — Cohort {cohortLabel}
          </DialogTitle>
          <DialogDescription>
            {marked} of {total} marked. Each one you mark leaves the list, so
            what is left is what is left to do.
            {defaulted > 0 && (
              <>
                {" "}
                {defaulted} {defaulted === 1 ? "is" : "are"} down as absent
                because the session closed without them checking in — they are
                still on the list, since nobody has actually looked.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0 space-y-3 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={query}
              placeholder="Jump to a name or ID"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {justMarked.length > 0 && (
            /*
              The last few, with an undo. A student who vanishes on a misclick
              is otherwise unreachable without switching views, which is a poor
              trade for a list that is meant to shrink.
            */
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5">
              <span className="text-xs text-muted-foreground">Just marked:</span>
              {justMarked.slice(0, 3).map((a) => (
                <Button
                  key={a.student_id}
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-xs"
                  onClick={() => undo(a)}
                >
                  <Undo2 className="h-3 w-3" />
                  {a.name || a.student_id}
                  <span className="text-muted-foreground">
                    {stateLabel(a.state)}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>

        {/*
          The one being called, then the queue.

          A register is read one name at a time, and a flat list makes you find
          your place again after every click. The card is where the marking
          happens; the list below is what is coming, and clicking any of it
          pulls that student forward for the out-of-order case.
        */}
        {current && !isLoading && (
          <div className="shrink-0 space-y-3 rounded-lg border-2 border-primary/40 bg-primary/5 p-3 shadow-soft sm:p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-lg font-bold sm:text-xl">
                  {current.name || current.student_id}
                </p>
                <p className="font-mono text-sm text-muted-foreground">
                  {current.student_id}
                </p>
                {current.state === "unexcused" &&
                  current.marked_by_role === "system" && (
                    <p className="mt-1 text-xs text-warning">
                      Down as absent because the session closed without them
                      checking in — nobody has actually looked.
                    </p>
                  )}
              </div>
              <Badge variant="outline" className="shrink-0 tabular-nums">
                {remaining.length} left
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {CALLS.map((call) => (
                <Button
                  key={call.state}
                  className={`h-16 px-2 text-sm sm:h-14 sm:px-4 sm:text-base ${call.className}`}
                  disabled={busyId === current.student_id}
                  onClick={() => void mark(current, call.state)}
                >
                  {busyId === current.student_id ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <span className="flex flex-col leading-tight">
                      <span>{call.label}</span>
                      {/*
                        Hidden on a phone. There is no keyboard to press it
                        with, so it is nothing but noise in the place where
                        space is tightest.
                      */}
                      <span className="hidden text-[10px] font-normal opacity-70 sm:block">
                        press {call.key}
                      </span>
                    </span>
                  )}
                </Button>
              ))}
            </div>

            {/*
              Only worth offering when there is somewhere to send them. With
              one name left, skipping shows the same card again, which reads
              as a broken button rather than a deliberate no-op.
            */}
            {remaining.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                disabled={busyId === current.student_id}
                onClick={() => skip(current)}
              >
                <SkipForward className="mr-2 h-4 w-4" />
                Skip
                <span className="hidden sm:inline">
                  &nbsp;— come back to them (S)
                </span>
              </Button>
            )}
          </div>
        )}

        <div className="min-h-[5rem] flex-1 space-y-2 overflow-y-auto pr-1 pt-3">
          {isLoading ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading the roster…
            </p>
          ) : remaining.length === 0 ? (
            <div className="space-y-2 py-10 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
              <p className="text-sm font-medium">
                {query.trim()
                  ? "Nobody left matching that."
                  : total === 0
                    ? "Nobody is enrolled in this cohort yet."
                    : "Everyone is marked."}
              </p>
              {!query.trim() && total > 0 && (
                <p className="text-xs text-muted-foreground">
                  {done.filter((a) => a.state === "present").length} present ·{" "}
                  {done.filter((a) => a.state === "late").length} late ·{" "}
                  {done.filter((a) => a.state === "unexcused").length} absent ·{" "}
                  {done.filter((a) => a.state === "excused").length} excused
                </p>
              )}
            </div>
          ) : (
            <>
              {queue.length > 0 && (
                <p className="text-xs font-medium text-muted-foreground">
                  Up next — click anyone to call them now
                </p>
              )}

              {queue.map((a) => (
                <button
                  key={a.student_id}
                  type="button"
                  onClick={() => setFocusId(a.student_id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {a.name || a.student_id}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {a.student_id}
                      {skipped.includes(a.student_id) && (
                        <span className="ml-2">skipped</span>
                      )}
                      {a.state === "unexcused" &&
                        a.marked_by_role === "system" && (
                          <span className="ml-2">absent by default</span>
                        )}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {showDone && done.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Already marked
              </p>
              {done.map((a) => (
                <div
                  key={a.student_id}
                  className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-1.5"
                >
                  <span className="truncate text-sm">
                    {a.name || a.student_id}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{stateLabel(a.state)}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => undo(a)}
                    >
                      Change
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="mt-4 shrink-0 gap-2 border-t pt-4 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={done.length === 0}
            onClick={() => setShowDone(!showDone)}
          >
            {showDone ? "Hide" : "Show"} the {done.length} already marked
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SessionRollCall;
