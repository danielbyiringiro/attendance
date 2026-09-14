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
 * Check-in timing for a cohort, or every cohort, from the Sessions tab.
 *
 * The sign-up window and the early-open time were only editable a weekly slot at
 * a time on the Schedule tab, or a session at a time in the edit dialog, so
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
  const [isSaving, setIsSaving] = useState(false);

  // Prefilled from the class defaults. Individual slots may differ; this is the
  // value a whole-class change starts from, not a claim about every session.
  useEffect(() => {
    if (!activeClass) return;
    setSignup(String(activeClass.default_auto_close_minutes));
    setEarly(String(activeClass.default_early_open_minutes));
  }, [activeClass]);

  if (!activeClass) return null;

  const parse = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const handleApply = async () => {
    const autoClose = parse(signup);
    const earlyOpen = parse(early);

    if (autoClose === undefined && earlyOpen === undefined) {
      toast({
        title: "Nothing to change",
        description: "Give a sign-up window, an early-open time, or both.",
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

    setIsSaving(true);
    try {
      const r = await setSessionWindows(activeClass.id, {
        cohortId: scope === ALL ? undefined : scope,
        autoCloseMinutes: autoClose,
        earlyOpenMinutes: earlyOpen,
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
          <Label htmlFor="timing-signup">Sign-up open (min)</Label>
          <Input
            id="timing-signup"
            type="number"
            min={1}
            max={600}
            value={signup}
            onChange={(e) => setSignup(e.target.value)}
          />
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
