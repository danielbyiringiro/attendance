import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useActiveClass } from "@/lib/classContext";
import { setSessionWindows } from "@/lib/api/windows";

const ALL = "all";

/**
 * Check-in timing for a cohort, or every cohort, from the class's Settings tab.
 *
 * The sign-up window and the early-open time were only editable a weekly slot at
 * a time on the Weekly pattern tab, or a session at a time in the edit dialog, so
 * changing them for a cohort meant repeating the edit across every slot and then
 * every session already generated. This is one change that reaches all of them.
 *
 * It says plainly what it will not touch, because the count it reports can be
 * smaller than the number of sessions a TA can see: anything already open,
 * closed, in the past, or with attendance recorded keeps its timing.
 */
const SessionTimingSettings = () => {
  const { activeClass, cohorts, refresh } = useActiveClass();
  const { toast } = useToast();
  const [scope, setScope] = useState(ALL);
  const [signup, setSignup] = useState("");
  const [early, setEarly] = useState("");
  // 048. Off is what every class did before this existed, so nothing here
  // changes a class until somebody turns it on deliberately.
  const [closesAtStart, setClosesAtStart] = useState(false);
  const [grace, setGrace] = useState("5");
  const [graceLate, setGraceLate] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Prefilled from the class defaults. Individual slots may differ; this is the
  // value a whole-class change starts from, not a claim about every session.
  useEffect(() => {
    if (!activeClass) return;
    setSignup(String(activeClass.default_auto_close_minutes));
    setEarly(String(activeClass.default_early_open_minutes));
    setClosesAtStart(activeClass.default_closes_at_start);
    setGrace(String(activeClass.default_grace_minutes ?? 5));
    setGraceLate(activeClass.default_grace_counts_late);
  }, [activeClass]);

  if (!activeClass) return null;

  const parse = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const handleApply = async () => {
    const autoClose = parse(signup);
    const earlyOpen = parse(early);

    if (
      autoClose === undefined &&
      earlyOpen === undefined &&
      closesAtStart === activeClass.default_closes_at_start
    ) {
      toast({
        title: "Nothing to change",
        description:
          "Give a sign-up window, an early-open time, or change when check-in closes.",
        variant: "destructive",
      });
      return;
    }
    if (
      (autoClose !== undefined && (!Number.isInteger(autoClose) || autoClose < 1)) ||
      (earlyOpen !== undefined && (!Number.isInteger(earlyOpen) || earlyOpen < 0))
    ) {
      toast({
        title: "Check the numbers",
        description:
          "The sign-up window has to be at least one minute, and opening early cannot be negative.",
        variant: "destructive",
      });
      return;
    }

    const graceValue = Number(grace);
    if (closesAtStart && (!Number.isInteger(graceValue) || graceValue < 1 || graceValue > 30)) {
      toast({
        title: "Check the grace window",
        description:
          "It has to be a whole number of minutes between 1 and 30. It only applies when a session is opened after its class already started.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const r = await setSessionWindows(activeClass.id, {
        cohortId: scope === ALL ? undefined : scope,
        autoCloseMinutes: autoClose,
        earlyOpenMinutes: earlyOpen,
        closesAtStart,
        // Sent only when the rule is on, so a class on the ordinary rule does
        // not quietly acquire a grace setting it never asked about.
        graceMinutes: closesAtStart ? graceValue : undefined,
        graceCountsLate: closesAtStart ? graceLate : undefined,
      });

      const who =
        scope === ALL
          ? "every cohort"
          : `cohort ${cohorts.find((c) => c.id === scope)?.label ?? "?"}`;
      const parts = [
        `${r.sessions} upcoming session${r.sessions === 1 ? "" : "s"}`,
        `${r.slots} weekly slot${r.slots === 1 ? "" : "s"}`,
      ];
      toast({
        title: `Timing updated for ${who}`,
        description:
          `${parts.join(" and ")} changed.` +
          (r.kept > 0
            ? ` ${r.kept} left as they were because attendance is already recorded.`
            : ""),
      });

      // The class defaults changed for a whole-class call, and other screens
      // read them from the context.
      if (r.defaults_updated) await refresh();
    } catch (e) {
      toast({
        title: "Could not update the timing",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium">
          <Timer className="h-4 w-4" />
          Check-in timing
        </p>
        <p className="text-xs text-muted-foreground">
          Sets the sign-up window and how early check-in opens, for one cohort or
          all of them. Applies to the weekly slots and every upcoming session
          that has not opened. Sessions already open, closed, in the past, or
          with attendance recorded keep their timing.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="timing-scope">For</Label>
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger id="timing-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All cohorts</SelectItem>
              {cohorts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  Cohort {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label
            htmlFor="timing-signup"
            className={closesAtStart ? "text-muted-foreground" : undefined}
          >
            Sign-up open (min)
          </Label>
          {/*
            048: with check-in closing at the start, this number decides
            nothing — the window shuts before it could run out. Disabled rather
            than hidden, so it is clear the setting still exists and what turned
            it off, and so its value is still there when the rule goes back off.
          */}
          <Input
            id="timing-signup"
            type="number"
            min={1}
            max={600}
            value={signup}
            disabled={closesAtStart}
            onChange={(e) => setSignup(e.target.value)}
          />
          {closesAtStart && (
            <p className="text-xs text-muted-foreground">
              Not used while check-in closes at the start.
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="timing-early">Opens early (min)</Label>
          <Input
            id="timing-early"
            type="number"
            min={0}
            max={600}
            value={early}
            onChange={(e) => setEarly(e.target.value)}
          />
        </div>
      </div>

      {/*
        048. Two ways to run a class, and the second one makes the sign-up
        window above irrelevant — so it says so rather than leaving a field on
        screen that quietly stops mattering.
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
              Check-in closes when the class starts
            </span>
            <span className="block text-xs text-muted-foreground">
              For a class where being there at the start is the point. Check-in
              still opens early; it shuts at the start rather than staying open
              for the sign-up window above.
            </span>
          </span>
        </label>

        {closesAtStart && (
          <div className="space-y-2 border-t pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="timing-grace" className="text-xs">
                If opened late, stay open for
              </Label>
              <Input
                id="timing-grace"
                type="number"
                min={1}
                max={30}
                className="h-8 w-20"
                value={grace}
                onChange={(e) => setGrace(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Otherwise a session opened after its class began would shut in the
              same instant and nobody could mark at all.
            </p>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={graceLate}
                onChange={(e) => setGraceLate(e.target.checked)}
              />
              <span className="text-xs">
                Record those check-ins as late.{" "}
                <span className="text-muted-foreground">
                  Off by default — somebody who marked while their TA got the
                  projector working was not the one running late.
                </span>
              </span>
            </label>
          </div>
        )}
      </div>

      {scope === ALL && (
        <p className="text-xs text-muted-foreground">
          All cohorts also becomes the class default, so new cohorts and
          hand-added sessions start with it.
        </p>
      )}

      <Button size="sm" onClick={() => void handleApply()} disabled={isSaving}>
        {isSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        Apply
      </Button>
    </div>
  );
};

export default SessionTimingSettings;
