import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarPlus, CalendarSync, Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useActiveClass } from "@/lib/classContext";
import {
  listSchedules,
  setCohortSchedules,
  type ScheduleSlot,
} from "@/lib/api/classes";
import { applyScheduleToFuture, generateSessions } from "@/lib/api/sessions";
import SessionList from "@/components/ta/SessionList";
import type { CohortScheduleRow } from "@/lib/api/types";

const DAYS = [
  { weekday: 0, label: "Sunday", short: "Sun" },
  { weekday: 1, label: "Monday", short: "Mon" },
  { weekday: 2, label: "Tuesday", short: "Tue" },
  { weekday: 3, label: "Wednesday", short: "Wed" },
  { weekday: 4, label: "Thursday", short: "Thu" },
  { weekday: 5, label: "Friday", short: "Fri" },
  { weekday: 6, label: "Saturday", short: "Sat" },
];

interface DayState {
  enabled: boolean;
  startTime: string;
  duration: string;
}

const emptyDays = (): Record<number, DayState> =>
  Object.fromEntries(
    DAYS.map((d) => [d.weekday, { enabled: false, startTime: "09:00", duration: "" }]),
  );

/** "09:00:00" -> "09:00", so the value fits an <input type="time">. */
const toInputTime = (t: string) => t.slice(0, 5);

const Schedule = () => {
  const { toast } = useToast();
  const { activeClass, cohorts, isLoading: classLoading } = useActiveClass();

  const [selectedCohorts, setSelectedCohorts] = useState<string[]>([]);
  const [days, setDays] = useState<Record<number, DayState>>(emptyDays);
  const [existing, setExisting] = useState<CohortScheduleRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genFrom, setGenFrom] = useState("");
  const [genTo, setGenTo] = useState("");
  const [sessionsToken, setSessionsToken] = useState(0);
  const [isApplying, setIsApplying] = useState(false);

  const loadSchedules = useCallback(async () => {
    if (!activeClass) return;
    setIsLoading(true);
    try {
      setExisting(await listSchedules(activeClass.id));
    } catch (e) {
      toast({
        title: "Could not load the schedule",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [activeClass, toast]);

  useEffect(() => {
    void loadSchedules();
    setSelectedCohorts([]);
    setDays(emptyDays());
    if (activeClass) {
      setGenFrom(activeClass.term_starts_on);
      setGenTo(activeClass.term_ends_on);
    }
  }, [activeClass, loadSchedules]);

  const byCohort = useMemo(() => {
    const map = new Map<string, CohortScheduleRow[]>();
    existing.forEach((row) => {
      const list = map.get(row.cohort_id) ?? [];
      list.push(row);
      map.set(row.cohort_id, list);
    });
    return map;
  }, [existing]);

  const toggleCohort = (cohortId: string) => {
    const next = selectedCohorts.includes(cohortId)
      ? selectedCohorts.filter((id) => id !== cohortId)
      : [...selectedCohorts, cohortId];

    setSelectedCohorts(next);

    // Computed out here, not inside the setSelectedCohorts updater. A state
    // updater must be pure: React invokes it twice in development, so a
    // setDays() call in there runs twice and the pre-fill fights itself.
    //
    // Selecting exactly one cohort loads what it already has, so "adjust
    // Thursday" is not "retype the week". With several selected there is no
    // single pattern to show, and saving overwrites all of them with whatever
    // is on screen.
    if (next.length === 1) {
      const rows = byCohort.get(next[0]) ?? [];
      const seeded = emptyDays();
      rows.forEach((r) => {
        seeded[r.weekday] = {
          enabled: true,
          startTime: toInputTime(r.start_time),
          duration: r.duration_minutes ? String(r.duration_minutes) : "",
        };
      });
      setDays(seeded);
    }
  };

  const setDay = (weekday: number, patch: Partial<DayState>) =>
    setDays((prev) => ({ ...prev, [weekday]: { ...prev[weekday], ...patch } }));

  const slots: ScheduleSlot[] = DAYS.filter((d) => days[d.weekday].enabled).map(
    (d) => ({
      weekday: d.weekday,
      startTime: days[d.weekday].startTime,
      durationMinutes: days[d.weekday].duration
        ? Number(days[d.weekday].duration)
        : undefined,
    }),
  );

  const handleSave = async () => {
    if (selectedCohorts.length === 0) {
      toast({
        title: "Choose at least one cohort",
        description: "The pattern is written to every cohort you tick.",
        variant: "destructive",
      });
      return;
    }
    setIsSaving(true);
    try {
      const written = await setCohortSchedules(selectedCohorts, slots);
      toast({
        title: slots.length === 0 ? "Schedule cleared" : "Schedule saved",
        description:
          slots.length === 0
            ? `${selectedCohorts.length} cohort${
                selectedCohorts.length === 1 ? "" : "s"
              } now meet on no fixed days.`
            : `${written} slot${written === 1 ? "" : "s"} across ${
                selectedCohorts.length
              } cohort${selectedCohorts.length === 1 ? "" : "s"}. Generate sessions to create the days.`,
      });
      await loadSchedules();
    } catch (e) {
      toast({
        title: "Could not save the schedule",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Push a pattern change onto the sessions it should have changed.
  //
  // Saving a pattern only rewrites cohort_schedules. Generating then adds the
  // days that are missing but, being ON CONFLICT DO NOTHING, leaves every
  // session already sitting at the old time — so moving Tuesday from 09:00 to
  // 14:00 gave the cohort both.
  const handleApplyToFuture = async () => {
    if (!activeClass) return;
    setIsApplying(true);
    try {
      const result = await applyScheduleToFuture(activeClass.id, {
        cohortIds: selectedCohorts.length > 0 ? selectedCohorts : undefined,
      });
      const parts = [
        result.moved > 0 && `${result.moved} moved`,
        result.removed > 0 && `${result.removed} removed`,
        result.created > 0 && `${result.created} added`,
      ].filter(Boolean);
      toast({
        title:
          parts.length === 0
            ? "Already up to date"
            : "Future sessions updated",
        description:
          parts.length === 0
            ? "Every session from today onward already matches the pattern."
            : `${parts.join(", ")}. Nothing before today was touched, and cancelled or hand-edited sessions were left alone.`,
      });
      setSessionsToken((n) => n + 1);
    } catch (e) {
      toast({
        title: "Could not update the future sessions",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleGenerate = async () => {
    if (!activeClass) return;
    setIsGenerating(true);
    try {
      const created = await generateSessions(activeClass.id, {
        from: genFrom || undefined,
        to: genTo || undefined,
      });
      toast({
        title: created === 0 ? "Nothing new to create" : "Sessions generated",
        description:
          created === 0
            ? "Every scheduled day in that range already has a session."
            : `${created} session${created === 1 ? "" : "s"} created. Days that already existed were left alone.`,
      });
      setSessionsToken((n) => n + 1);
    } catch (e) {
      toast({
        title: "Could not generate sessions",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  if (classLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!activeClass) {
    return (
      <Card className="border-2 border-dashed">
        <CardContent className="pt-6 text-center">
          <p className="font-medium">No class selected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose one in the sidebar, or create one under Classes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* What each cohort meets on today */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Current pattern</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin opacity-60" />
          ) : (
            cohorts.map((co) => {
              const rows = (byCohort.get(co.id) ?? []).sort(
                (a, b) => a.weekday - b.weekday,
              );
              return (
                <div key={co.id} className="flex items-start gap-3 text-sm">
                  <Badge variant="outline" className="shrink-0">
                    {co.label}
                  </Badge>
                  {rows.length === 0 ? (
                    <span className="text-muted-foreground">No fixed days yet</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {rows.map((r) => (
                        <span key={r.id}>
                          {DAYS[r.weekday].short} {toInputTime(r.start_time)}
                          {r.duration_minutes && (
                            <span className="text-muted-foreground">
                              {" "}
                              ({r.duration_minutes}m)
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Editor */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Set the pattern</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Apply to</Label>
            <div className="flex flex-wrap gap-3">
              {cohorts.map((co) => (
                <label
                  key={co.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedCohorts.includes(co.id)}
                    onCheckedChange={() => toggleCohort(co.id)}
                  />
                  <span className="text-sm">{co.label}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedCohorts.length === 1
                ? "Loaded this cohort's current pattern below."
                : selectedCohorts.length > 1
                  ? `Saving writes the same pattern to all ${selectedCohorts.length}, replacing what they have.`
                  : "Tick one to edit what it has, or several to give them the same pattern."}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Days and times</Label>
            <div className="space-y-1">
              {DAYS.map((d) => {
                const state = days[d.weekday];
                return (
                  <div
                    key={d.weekday}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                  >
                    <label className="flex w-32 items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={state.enabled}
                        onCheckedChange={(v) =>
                          setDay(d.weekday, { enabled: v === true })
                        }
                      />
                      <span className="text-sm">{d.label}</span>
                    </label>

                    <Input
                      type="time"
                      className="w-32"
                      value={state.startTime}
                      disabled={!state.enabled}
                      onChange={(e) =>
                        setDay(d.weekday, { startTime: e.target.value })
                      }
                    />
                    <Input
                      type="number"
                      min={1}
                      className="w-28"
                      placeholder={`${activeClass.default_duration_minutes}m`}
                      value={state.duration}
                      disabled={!state.enabled}
                      onChange={(e) => setDay(d.weekday, { duration: e.target.value })}
                    />
                    <span className="text-xs text-muted-foreground">
                      {state.enabled && !state.duration && "default length"}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Each day keeps its own time, so a cohort can meet Tuesday morning
              and Thursday afternoon. Leave the length blank to use the class
              default ({activeClass.default_duration_minutes} minutes).
            </p>
          </div>

          <Button onClick={handleSave} disabled={isSaving || selectedCohorts.length === 0}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save pattern
          </Button>
        </CardContent>
      </Card>

      {/* Generation */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Create the sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="gen-from">From</Label>
              <Input
                id="gen-from"
                type="date"
                value={genFrom}
                onChange={(e) => setGenFrom(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gen-to">To</Label>
              <Input
                id="gen-to"
                type="date"
                value={genTo}
                onChange={(e) => setGenTo(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={handleGenerate} disabled={isGenerating}>
              {isGenerating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CalendarPlus className="h-4 w-4 mr-2" />
              )}
              Generate sessions
            </Button>

            <Button onClick={handleApplyToFuture} disabled={isApplying}>
              {isApplying ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CalendarSync className="h-4 w-4 mr-2" />
              )}
              Apply pattern to future sessions
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            <strong>Generate</strong> only adds days that have no session yet,
            over the range above. Use it when you first set up a term.
          </p>
          <p className="text-xs text-muted-foreground">
            <strong>Apply to future sessions</strong> is what you want after
            changing a time: from today onward it moves sessions to the new
            time, removes days the cohort no longer meets, and adds the ones it
            now does — for the cohorts ticked above, or all of them if none is.
            Nothing before today changes, and a session you cancelled or moved
            by hand is left where it is.
          </p>
        </CardContent>
      </Card>

      {/* The sessions themselves — open, close, cancel */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionList
            classId={activeClass.id}
            cohorts={cohorts}
            timezone={activeClass.timezone}
            refreshToken={sessionsToken}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default Schedule;
