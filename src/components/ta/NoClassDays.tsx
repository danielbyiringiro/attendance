import { useCallback, useEffect, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarOff, Loader2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  clearNoClassDay,
  listNoClassDays,
  setNoClassDay,
  type NoClassMode,
} from "@/lib/api/sessions";
import type { CohortRow } from "@/lib/api/types";
import { todayStr } from "@/lib/dates";

const dateOf = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * Days the class does not meet.
 *
 * Deliberately separate from cancelling a session, which lives on the list
 * below and means "this particular meeting did not happen". A day off is a date
 * rather than a session: it covers every cohort, and it is remembered, so
 * regenerating the term does not bring the holiday back.
 *
 * The two modes are two buttons rather than a toggle, because they do opposite
 * things to every student's percentage and the wrong one is silent. "Does not
 * count" leaves the day out of the calculation entirely; "counts as attended"
 * credits everybody. A switch labelled `counts` would let a slip pass for a
 * term.
 */
const NoClassDays = ({
  classId,
  cohorts,
}: {
  classId: string;
  cohorts: CohortRow[];
}) => {
  const { toast } = useToast();
  const [days, setDays] = useState<
    Array<{
      id: string;
      on_date: string;
      mode: NoClassMode;
      reason: string;
      cohort_id: string | null;
    }>
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(todayStr());
  const [mode, setMode] = useState<NoClassMode>("exempt");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("all");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setDays(await listNoClassDays(classId));
    } catch {
      setDays([]);
    } finally {
      setIsLoading(false);
    }
  }, [classId]);

  useEffect(() => {
    void load();
  }, [load]);

  const labelFor = (id: string | null) =>
    id ? `Cohort ${cohorts.find((c) => c.id === id)?.label ?? "?"}` : "All cohorts";

  const handleAdd = async () => {
    if (!reason.trim()) {
      toast({
        title: "Say why",
        description:
          "A day that stops counting needs a reason, or a student's record cannot explain itself a term later.",
        variant: "destructive",
      });
      return;
    }

    setBusy("adding");
    try {
      const result = await setNoClassDay(
        classId,
        date,
        mode,
        reason.trim(),
        scope === "all" ? undefined : scope,
      );
      // Three outcomes worth telling apart, because "nothing happened" and
      // "four empty sessions were removed" look identical otherwise.
      const parts: string[] = [];
      if (result.removed > 0) {
        parts.push(
          `${result.removed} empty session${result.removed === 1 ? "" : "s"} removed`,
        );
      }
      if (result.sessions > 0) {
        parts.push(
          `${result.sessions} session${result.sessions === 1 ? "" : "s"} marked, ${result.students} student record${result.students === 1 ? "" : "s"}`,
        );
      }

      toast({
        title: mode === "exempt" ? "Day off recorded" : "Day credited",
        description:
          parts.length === 0
            ? "Nothing was scheduled on that date, and nothing will be created there now."
            : `${parts.join(". ")}. Regenerating will not put the day back.`,
      });
      setAdding(false);
      setReason("");
      await load();
    } catch (e) {
      toast({
        title: "Could not set the day",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async (d: (typeof days)[number]) => {
    setBusy(d.id);
    try {
      await clearNoClassDay(classId, d.on_date, d.cohort_id ?? undefined);
      toast({
        title: "Day cleared",
        description:
          "Sessions on that date are scheduled again. Check-ins that were replaced do not come back.",
      });
      await load();
    } catch (e) {
      toast({
        title: "Could not clear it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Days off</p>
          <p className="text-xs text-muted-foreground">
            Holidays and reading weeks. Sessions are never created on these
            dates, however often you regenerate.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <CalendarOff className="mr-1 h-4 w-4" />
          Add a day off
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : days.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          None set. The weekly pattern runs through every date in the term.
        </p>
      ) : (
        <div className="space-y-1">
          {days.map((d) => (
            <div
              key={d.id}
              className="flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">
                    {dateOf(d.on_date)}
                  </span>
                  <Badge
                    variant={d.mode === "exempt" ? "secondary" : "default"}
                    className="text-xs"
                  >
                    {d.mode === "exempt" ? "does not count" : "counts as attended"}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {labelFor(d.cohort_id)}
                  </Badge>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {d.reason}
                </p>
              </div>

              <Button
                size="sm"
                variant="ghost"
                className="self-start sm:self-auto"
                disabled={busy === d.id}
                onClick={() => void handleClear(d)}
              >
                {busy === d.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                <span className="ml-1 sm:hidden">Remove</span>
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={adding} onOpenChange={(o) => !o && setAdding(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>A day the class does not meet</DialogTitle>
            <DialogDescription>
              Sessions already on this date are closed out, and none will be
              created there afterwards.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="ncd-date">Date</Label>
              <Input
                id="ncd-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>

            {/*
              Two buttons, not a switch. These do opposite things to every
              student's percentage, and picking the wrong one is silent — the
              records look perfectly plausible either way, and nobody finds out
              until somebody queries a rate at the end of term.
            */}
            <div className="space-y-2">
              <Label>What it does to attendance</Label>
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setMode("exempt")}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    mode === "exempt"
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/40"
                  }`}
                >
                  <p className="text-sm font-medium">Does not count</p>
                  <p className="text-xs text-muted-foreground">
                    The day leaves the calculation entirely. Nobody is helped or
                    harmed by it. A public holiday or a reading week.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setMode("present")}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    mode === "present"
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/40"
                  }`}
                >
                  <p className="text-sm font-medium">Counts as attended</p>
                  <p className="text-xs text-muted-foreground">
                    Everybody is marked present and the day counts normally. An
                    online quiz or a take-home, where there is no room but the
                    work happened.
                  </p>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ncd-scope">Applies to</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="ncd-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    Every cohort, including any added later
                  </SelectItem>
                  {cohorts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      Cohort {c.label} only
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ncd-reason">Reason</Label>
              <Input
                id="ncd-reason"
                value={reason}
                placeholder="Public holiday"
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Shown on the student's own record, so it explains itself a term
                later.
              </p>
            </div>

            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
              Any check-ins already recorded on this date are replaced. Removing
              the day afterwards puts the sessions back, but does not bring those
              check-ins back.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={busy === "adding"}>
              {busy === "adding" && (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              )}
              {mode === "exempt" ? "Set the day off" : "Credit the day"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NoClassDays;
