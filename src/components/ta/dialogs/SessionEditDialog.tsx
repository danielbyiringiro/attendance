import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
import {
  countSessionSeries,
  updateSession,
  updateSessionSeries,
  type EditScope,
  type SeriesEditResult,
} from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

/**
 * Edit a session — this one, this and every later one in its run, or the whole
 * run — the way a calendar app asks about a repeating event (053).
 *
 * Lifted out of SessionList so the month view can offer the same thing. It owns
 * its form state rather than taking it as props: the caller has a session or it
 * has null, which is the whole of what it needs to know, and two screens both
 * threading five fields and a busy flag is how they drift apart.
 *
 * Changes this session only. The weekly pattern is untouched, and
 * update_session sets moved_manually so a later schedule save leaves it alone.
 */
const SessionEditDialog = ({
  session,
  timezone,
  cohortLabel,
  onClose,
  onSaved,
}: {
  session: SessionRow | null;
  /** The class's own timezone. See the note on reading the time back. */
  timezone: string;
  cohortLabel: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) => {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [signup, setSignup] = useState("");
  // 048, for this session alone: the pattern it came from is left as it is.
  const [closesAtStart, setClosesAtStart] = useState(false);
  const [grace, setGrace] = useState("5");
  const [isSaving, setIsSaving] = useState(false);
  const [scope, setScope] = useState<EditScope>("one");
  // How many each scope would reach. Null until counted, and while it is null
  // the choice is not offered: "this and every later one" with no number
  // beside it is a choice made blind.
  const [counts, setCounts] = useState<{ future: number; series: number } | null>(
    null,
  );

  useEffect(() => {
    if (!session) return;
    setDate(session.session_date);
    // Read back in the CLASS's timezone, because that is the clock the server
    // resolves the value against when it is sent. Formatting in the viewer's
    // zone would show a TA abroad a time the room never met at, and saving it
    // unchanged would then silently move the session.
    setTime(
      new Date(session.starts_at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone,
      }),
    );
    setDuration(String(session.duration_minutes));
    setSignup(String(session.auto_close_minutes));
    setClosesAtStart(session.closes_at_start ?? false);
    setGrace(String(session.grace_minutes ?? 5));
    // Every open starts on the narrowest scope. Opening a session to fix one
    // time and finding the dialog set to rewrite the whole run is how a term
    // gets rewritten by accident.
    setScope("one");
    setCounts(null);

    let live = true;
    void countSessionSeries(session.id)
      .then((c) => {
        if (live) setCounts(c);
      })
      .catch(() => {
        // Without the counts the dialog still edits one session, which is all
        // it ever did. It just does not offer the wider choices.
      });
    return () => {
      live = false;
    };
  }, [session, timezone]);

  /** Only worth asking when the run has more than this one session in it. */
  const offersScope = counts !== null && counts.series > 1;

  const handleSave = async () => {
    if (!session) return;
    setIsSaving(true);
    try {
      const changes = {
        startTime: time || undefined,
        durationMinutes: duration ? Number(duration) : undefined,
        autoCloseMinutes: signup ? Number(signup) : undefined,
        closesAtStart,
        graceMinutes: closesAtStart && grace ? Number(grace) : undefined,
      };
      // One session keeps going through update_session, which every database
      // this app has ever run against already has. Only the run scopes need
      // 053's function — so a client deployed before that migration is run
      // loses the new choices (they are not offered: the count fails too) and
      // keeps the edit it always had, rather than losing every edit at once.
      const r: SeriesEditResult =
        scope === "one"
          ? (await updateSession(session.id, {
              ...changes,
              date: date || undefined,
            }),
            { scope: "one", updated: 1, skipped_marked: 0, skipped_status: 0 })
          : // A run cannot change its date: that is the weekly pattern's job,
            // and the server refuses it. Not sent, rather than sent and refused.
            await updateSessionSeries(session.id, scope, changes);
      const skipped = r.skipped_marked + r.skipped_status;
      const why = [
        r.skipped_marked > 0 && `${r.skipped_marked} already had attendance taken`,
        r.skipped_status > 0 && `${r.skipped_status} already open, closed or cancelled`,
      ]
        .filter(Boolean)
        .join(", ");
      toast({
        title: r.updated === 1 ? "Session changed" : `${r.updated} sessions changed`,
        description:
          scope === "one"
            ? "Only this one session changed."
            : skipped > 0
              ? `${skipped} left as they were: ${why}.`
              : "Every session in that range changed.",
      });
      onClose();
      await onSaved();
    } catch (e) {
      toast({
        title: "Could not change the session",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const dateOf = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
          <DialogDescription>
            {session && (
              <>
                {dateOf(session.session_date)}, cohort {cohortLabel}.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {offersScope && counts && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium">Apply to</legend>
            {(
              [
                ["one", "Only this session", null],
                [
                  "future",
                  "This and every later one",
                  `${counts.future} session${counts.future === 1 ? "" : "s"}`,
                ],
                ["series", "Every session in this run", `${counts.series} sessions`],
              ] as Array<[EditScope, string, string | null]>
            ).map(([value, label, count]) => (
              <label
                key={value}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                  scope === value
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/40"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="edit-scope"
                    value={value}
                    checked={scope === value}
                    onChange={() => setScope(value)}
                  />
                  {label}
                </span>
                {count && (
                  <span className="text-xs text-muted-foreground">{count}</span>
                )}
              </label>
            ))}
            {scope !== "one" && (
              <p className="text-xs text-muted-foreground">
                A run is this cohort on this weekday at this time. Sessions that
                already have attendance taken, or are open, closed or
                cancelled, are left as they are. The ones that change stop
                following the weekly pattern, so a later pattern edit will not
                undo this.
              </p>
            )}
          </fieldset>
        )}

        <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label
              htmlFor="edit-date"
              className={scope !== "one" ? "text-muted-foreground" : undefined}
            >
              Date
            </Label>
            <Input
              id="edit-date"
              type="date"
              value={date}
              disabled={scope !== "one"}
              onChange={(e) => setDate(e.target.value)}
            />
            {scope !== "one" && (
              <p className="text-xs text-muted-foreground">
                To move a run to another day, change the weekly pattern.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-time">Start</Label>
            <Input
              id="edit-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-duration">Class runs (min)</Label>
            <Input
              id="edit-duration"
              type="number"
              min={1}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor="edit-signup"
              className={closesAtStart ? "text-muted-foreground" : undefined}
            >
              Sign-up open (min)
            </Label>
            <Input
              id="edit-signup"
              type="number"
              min={1}
              value={signup}
              disabled={closesAtStart}
              onChange={(e) => setSignup(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {closesAtStart
                ? "Not used while check-in closes at the start."
                : "How long check-in stays open once you open it."}
            </p>
          </div>
        </div>

        {/*
          048, for one session. The class setting is on Class → Settings and the
          weekly one is on the pattern; this is the day the lecturer asked for
          the register to be shut at the door, or the day it should not be.
        */}
        <div className="space-y-2 rounded-md border p-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={closesAtStart}
              onChange={(e) => setClosesAtStart(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Check-in closes when this class starts
              </span>
              <span className="block text-xs text-muted-foreground">
                {scope === "one"
                  ? "This session only. The weekly pattern keeps whatever it says."
                  : "For the sessions chosen above. The weekly pattern keeps whatever it says."}
              </span>
            </span>
          </label>

          {closesAtStart && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <Label htmlFor="edit-grace" className="text-xs">
                If opened late, stay open for
              </Label>
              <Input
                id="edit-grace"
                type="number"
                min={1}
                max={30}
                className="h-8 w-20"
                value={grace}
                onChange={(e) => setGrace(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          A session that has already run cannot be moved: attendance is recorded
          against it, and moving it would put those marks on a different day.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SessionEditDialog;
