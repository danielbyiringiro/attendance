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

/** The three calls worth making by hand, in the order a register is read. */
const CALLS: { state: AttendanceState; label: string; className: string }[] = [
  {
    state: "present",
    label: "Present",
    className: "bg-success text-success-foreground hover:bg-success/90",
  },
  {
    state: "unexcused",
    label: "Absent",
    className:
      "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  },
  {
    state: "excused",
    label: "Excused",
    className: "bg-primary text-primary-foreground hover:bg-primary/90",
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
    return attendees
      .filter(stillToCall)
      .filter(
        (a) =>
          needle === "" ||
          a.student_id.toLowerCase().includes(needle) ||
          (a.name ?? "").toLowerCase().includes(needle),
      );
  }, [attendees, query]);

  const done = useMemo(
    () => attendees.filter((a) => !stillToCall(a)),
    [attendees],
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

  const total = attendees.length;
  const marked = done.length;
  const defaulted = attendees.filter(
    (a) => a.state === "unexcused" && a.marked_by_role === "system",
  ).length;

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0">
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

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
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
                  {done.filter((a) => a.state === "unexcused").length} absent ·{" "}
                  {done.filter((a) => a.state === "excused").length} excused
                </p>
              )}
            </div>
          ) : (
            remaining.map((a) => (
              <div
                key={a.student_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {a.name || a.student_id}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {a.name ? `${a.student_id}` : ""}
                    {a.state === "unexcused" && a.marked_by_role === "system" && (
                      <span className={a.name ? "ml-2" : ""}>
                        absent by default — nobody has marked them
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex gap-1.5">
                  {CALLS.map((call) => (
                    <Button
                      key={call.state}
                      size="sm"
                      className={call.className}
                      disabled={busyId === a.student_id}
                      onClick={() => void mark(a, call.state)}
                    >
                      {busyId === a.student_id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        call.label
                      )}
                    </Button>
                  ))}
                </div>
              </div>
            ))
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
