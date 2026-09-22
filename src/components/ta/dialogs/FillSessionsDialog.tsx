// Fill in the sessions the weekly pattern wants, in either direction.
//
// Replaces two buttons that sat on the pattern screen — "Generate sessions"
// and "Backfill earlier sessions" — where everything they did was only visible
// on the other tab. You pressed, read a number, and went to look.
//
// The plan is shown before anything happens, and it is not computed here: it
// comes from fill_sessions with dry_run, which does the work, counts it and
// rolls it back (053). A preview written in this file would be a second
// implementation of the rules, and the first guard added to one and not the
// other would make this screen promise something the button does not do.

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useResetOnOpen } from "@/lib/useResetOnOpen";
import { todayStr } from "@/lib/dates";
import {
  fillSessions,
  sessionDateRange,
  type FillPlan,
  type FillScope,
} from "@/lib/api/sessions";

const pretty = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string;
  termStart: string;
  termEnd: string;
  /** Reload the calendar behind this. */
  onFilled: () => Promise<void> | void;
}

const FillSessionsDialog = ({
  open,
  onOpenChange,
  classId,
  termStart,
  termEnd,
  onFilled,
}: Props) => {
  const { toast } = useToast();
  const today = todayStr();

  const [firstSession, setFirstSession] = useState<string | null>(null);
  const [scope, setScope] = useState<FillScope>("future");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(termEnd);
  const [plan, setPlan] = useState<FillPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [working, setWorking] = useState(false);

  /**
   * Where each scope reaches.
   *
   * "gap" ends at the earliest session on record rather than the day before
   * it: a date that already has its session is skipped anyway, and naming the
   * session you can see is clearer than naming the day before it.
   */
  const rangeFor = useCallback(
    (s: FillScope): { from: string; to: string } => {
      switch (s) {
        case "gap":
          return {
            from: termStart,
            to: firstSession && firstSession > termStart ? firstSession : termStart,
          };
        case "past":
          return { from: termStart, to: today };
        case "future":
          return { from: today, to: termEnd };
        case "term":
          return { from: termStart, to: termEnd };
      }
    },
    [termStart, termEnd, today, firstSession],
  );

  useResetOnOpen(open, () => {
    setPlan(null);
    setFirstSession(null);
    setScope("future");
    setFrom(today);
    setTo(termEnd);
  });

  // The earliest session decides both the default scope and what "to the first
  // session" means, so it is read before anything is offered.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void sessionDateRange(classId)
      .then(({ first }) => {
        if (!live) return;
        setFirstSession(first);
        const opening: FillScope = first && first > termStart ? "gap" : "future";
        setScope(opening);
        const r =
          opening === "gap"
            ? { from: termStart, to: first ?? termStart }
            : { from: today, to: termEnd };
        setFrom(r.from);
        setTo(r.to);
      })
      .catch(() => {
        // A class whose sessions cannot be read still gets a working dialog;
        // it just opens on "from today on" rather than guessing at a gap.
        if (live) setFirstSession(null);
      });
    return () => {
      live = false;
    };
  }, [open, classId, termStart, termEnd, today]);

  // Every change of range asks the server what it would do. Debounced, because
  // typing a date fires on each keystroke in some browsers.
  useEffect(() => {
    if (!open || !from || !to || from > to) {
      setPlan(null);
      return;
    }
    let live = true;
    setPlanning(true);
    const timer = setTimeout(() => {
      void fillSessions(classId, { from, to, prune: true, dryRun: true })
        .then((p) => {
          if (live) setPlan(p);
        })
        .catch(() => {
          if (live) setPlan(null);
        })
        .finally(() => {
          if (live) setPlanning(false);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, classId, from, to]);

  const pick = (s: FillScope) => {
    const r = rangeFor(s);
    setScope(s);
    setFrom(r.from);
    setTo(r.to);
  };

  const blurb = useMemo(() => {
    switch (scope) {
      case "gap":
        return firstSession && firstSession > termStart
          ? `From the start of term to your earliest session, ${pretty(firstSession)}.`
          : "Your earliest session is already at the start of term. Change From to reach further back.";
      case "past":
        return `From the term's start date, ${pretty(termStart)}, through today.`;
      case "future":
        return `Today to the end of term, ${pretty(termEnd)}. Also clears sessions the pattern no longer includes.`;
      case "term":
        return "Every gap across the whole term.";
    }
  }, [scope, firstSession, termStart, termEnd]);

  const kept = plan ? plan.kept.marked + plan.kept.by_hand + plan.kept.cancelled : 0;
  const nothingToDo = !plan || (plan.created === 0 && plan.removed === 0);

  const handleFill = async () => {
    if (!plan || nothingToDo) return;
    setWorking(true);
    try {
      const r = await fillSessions(classId, { from, to, prune: true });
      const bits: string[] = [];
      if (r.created > 0) bits.push(`${r.created} created`);
      if (r.removed > 0) bits.push(`${r.removed} removed`);
      toast({
        title: bits.length ? bits.join(", ") : "Nothing to do",
        description:
          r.kept.marked + r.kept.by_hand + r.kept.cancelled > 0
            ? "Sessions that were marked, moved by hand or cancelled were left where they are."
            : `Between ${pretty(r.from)} and ${pretty(r.to)}.`,
      });
      onOpenChange(false);
      await onFilled();
    } catch (e) {
      toast({
        title: "Could not fill the sessions in",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setWorking(false);
    }
  };

  const SCOPES: Array<[FillScope, string]> = [
    ["gap", "To the first session"],
    ["past", "Up to today"],
    ["future", "From today on"],
    ["term", "The entire term"],
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fill in sessions</DialogTitle>
          <DialogDescription>
            Creates what the weekly pattern says should exist. Nothing is
            written until you press the button below, and it says what it will
            do.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          {SCOPES.map(([s, label]) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={scope === s ? "default" : "outline"}
              aria-pressed={scope === s}
              onClick={() => pick(s)}
            >
              {label}
            </Button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">{blurb}</p>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="fill-from">From</Label>
            <Input
              id="fill-from"
              type="date"
              value={from}
              min={termStart}
              max={termEnd}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fill-to">To</Label>
            <Input
              id="fill-to"
              type="date"
              value={to}
              min={termStart}
              max={termEnd}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1 rounded-md border p-3 text-sm">
          {from > to ? (
            <p className="text-destructive">Pick a range that runs forwards.</p>
          ) : planning && !plan ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out what this would do…
            </p>
          ) : !plan ? (
            <p className="text-muted-foreground">
              Could not work out the plan. The button stays disabled rather than
              guessing.
            </p>
          ) : (
            <>
              <p className={plan.created > 0 ? "text-success" : "text-muted-foreground"}>
                {plan.created > 0
                  ? `Create ${plan.created} session${plan.created === 1 ? "" : "s"}.`
                  : "Nothing to create — every date the pattern names already has its session."}
              </p>
              {plan.removed > 0 && (
                <p className="text-destructive">
                  Remove {plan.removed} scheduled session
                  {plan.removed === 1 ? "" : "s"} the pattern no longer includes.
                </p>
              )}
              {kept > 0 ? (
                <p className="text-muted-foreground">
                  Leave alone:{" "}
                  {[
                    plan.kept.marked > 0 && `${plan.kept.marked} with attendance recorded`,
                    plan.kept.by_hand > 0 && `${plan.kept.by_hand} moved by hand`,
                    plan.kept.cancelled > 0 && `${plan.kept.cancelled} cancelled`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  . These no longer match the pattern, and are kept anyway.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Nothing marked, moved or cancelled is touched.
                </p>
              )}
              {!plan.pruned && (
                <p className="text-xs text-muted-foreground">
                  This range ends behind today, so nothing is removed — a class
                  that has already happened is not a mistake to tidy up.
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleFill()}
            disabled={working || planning || nothingToDo}
          >
            {working && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {nothingToDo
              ? "Nothing to do"
              : plan && plan.removed > 0
                ? `Create ${plan.created} and remove ${plan.removed}`
                : `Create ${plan?.created ?? 0}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default FillSessionsDialog;
