// What a drop on the calendar means — asked, not guessed.
//
// Dragging a repeating session has two defensible meanings: move this one, or
// move the run from here on. Picking either silently rewrites somebody's term
// the day it is the wrong one, which is why SessionCalendar's header used to
// say the calendar was edited by clicking a day and never by dragging.
//
// So a drop opens this, and both answers arrive with their numbers already
// worked out — by the server doing each move for real and rolling it back
// (054), not by a second implementation here that could disagree with it.
// When one answer is refused (a day off, the same weekday, a session nothing
// in the pattern produced) the refusal is shown in its place. An option that
// silently vanishes is one nobody can tell from a broken one; that cost a
// round trip in the edit dialog already.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { moveSessionTo, type MovePlan } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

type Scope = "one" | "future";

/** A plan, or the reason the server gave for refusing that scope. */
type Outcome = { plan: MovePlan } | { refused: string } | null;

const pretty = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

const weekdayOf = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" });

/** The server's refusal, without the wrapper our API layer puts round it. */
const reasonOf = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Could not move the session:\s*/, "");
};

const s = (n: number) => (n === 1 ? "" : "s");

/** What a run move leaves where it was, in words. Empty when nothing. */
const keptLine = (p: MovePlan): string =>
  [
    p.kept.marked > 0 && `${p.kept.marked} with attendance already taken`,
    p.kept.by_hand > 0 && `${p.kept.by_hand} moved by hand earlier`,
    p.kept.running > 0 && `${p.kept.running} already open or closed`,
    p.kept.clash > 0 && `${p.kept.clash} whose new day already has one`,
  ]
    .filter(Boolean)
    .join(", ");

const MoveSessionDialog = ({
  session,
  toDate,
  cohortLabel,
  timeLabel,
  onClose,
  onMoved,
}: {
  session: SessionRow | null;
  toDate: string | null;
  cohortLabel: string;
  timeLabel: string;
  onClose: () => void;
  onMoved: () => void | Promise<void>;
}) => {
  const { toast } = useToast();
  const [one, setOne] = useState<Outcome>(null);
  const [future, setFuture] = useState<Outcome>(null);
  const [scope, setScope] = useState<Scope>("one");
  const [working, setWorking] = useState(false);

  const open = session !== null && toDate !== null;

  useEffect(() => {
    if (!session || !toDate) return;
    // "Just this one" is always the starting answer. A drop is quick and
    // careless by nature; the choice that rewrites a term has to be chosen.
    setScope("one");
    setOne(null);
    setFuture(null);

    let live = true;
    const ask = (sc: Scope, set: (o: Outcome) => void) =>
      moveSessionTo(session.id, toDate, sc, true)
        .then((plan) => live && set({ plan }))
        .catch((e) => live && set({ refused: reasonOf(e) }));
    void ask("one", setOne);
    void ask("future", setFuture);
    return () => {
      live = false;
    };
  }, [session, toDate]);

  const chosen = scope === "one" ? one : future;
  const ready = chosen !== null && "plan" in chosen;

  const handleMove = async () => {
    if (!session || !toDate || !ready) return;
    setWorking(true);
    try {
      const r = await moveSessionTo(session.id, toDate, scope);
      const dropped = r.dropped.day_off + r.dropped.past_term;
      const kept = keptLine(r);
      toast({
        title:
          scope === "one"
            ? `Moved to ${pretty(toDate)}`
            : `${r.moved} session${s(r.moved)} moved to ${weekdayOf(toDate)}s`,
        description:
          scope === "one"
            ? "The weekly pattern is unchanged; this session now stands on its own."
            : [
                r.split
                  ? `The weekly pattern now says ${weekdayOf(toDate)}s from ${pretty(toDate)}.`
                  : `The weekly pattern now says ${weekdayOf(toDate)}s.`,
                dropped > 0 &&
                  `${dropped} removed because the new day was off or past the end of term.`,
                kept && `Left where they were: ${kept}.`,
              ]
                .filter(Boolean)
                .join(" "),
      });
      onClose();
      await onMoved();
    } catch (e) {
      toast({
        title: "Could not move it",
        description: reasonOf(e),
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const fromDay = session ? weekdayOf(session.session_date) : "";

  const Option = ({
    value,
    title,
    outcome,
    detail,
  }: {
    value: Scope;
    title: string;
    outcome: Outcome;
    detail: (p: MovePlan) => React.ReactNode;
  }) => {
    const refused = outcome !== null && "refused" in outcome ? outcome.refused : null;
    const plan = outcome !== null && "plan" in outcome ? outcome.plan : null;
    return (
      <label
        className={`block rounded-md border p-3 text-sm transition-colors ${
          refused
            ? "cursor-not-allowed opacity-70"
            : scope === value
              ? "cursor-pointer border-primary bg-primary/5"
              : "cursor-pointer hover:border-primary/40"
        }`}
      >
        <span className="flex items-start gap-2">
          <input
            type="radio"
            name="move-scope"
            className="mt-1"
            value={value}
            checked={scope === value}
            disabled={!!refused || outcome === null}
            onChange={() => setScope(value)}
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block font-medium">{title}</span>
            {outcome === null ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Working out what this would do…
              </span>
            ) : refused ? (
              <span className="block text-xs text-muted-foreground">
                Not possible here: {refused}
              </span>
            ) : (
              plan && <span className="block text-xs text-muted-foreground">{detail(plan)}</span>
            )}
          </span>
        </span>
      </label>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Move cohort {cohortLabel}, {timeLabel}
          </DialogTitle>
          <DialogDescription>
            {session && toDate && (
              <>
                {pretty(session.session_date)} → {pretty(toDate)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Option
            value="one"
            title="Just this session"
            outcome={one}
            detail={() => (
              <>
                The weekly pattern keeps {fromDay}s. This one session moves and
                stands on its own from then on, so a later pattern change will
                not pull it back.
              </>
            )}
          />
          <Option
            value="future"
            title={`This and every later ${fromDay}`}
            outcome={future}
            detail={(p) => (
              <>
                Moves {p.moved} session{s(p.moved)} to {toDate ? weekdayOf(toDate) : ""}
                s and changes the weekly pattern from {toDate ? pretty(toDate) : ""} on.
                {p.dropped.day_off + p.dropped.past_term > 0 && (
                  <>
                    {" "}
                    {p.dropped.day_off + p.dropped.past_term} would land on a day
                    off or past the end of term, and are removed.
                  </>
                )}
                {keptLine(p) && <> Left where they are: {keptLine(p)}.</>}
              </>
            )}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleMove()} disabled={!ready || working}>
            {working && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {scope === "one"
              ? "Move this session"
              : ready && chosen && "plan" in chosen
                ? `Move ${chosen.plan.moved} session${s(chosen.plan.moved)}`
                : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MoveSessionDialog;
