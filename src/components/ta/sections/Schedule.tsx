import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CalendarPlus, Copy, Loader2, Plus, Save, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useActiveClass } from "@/lib/classContext";
import {
  listSchedules,
  setCohortSchedules,
  type ScheduleSlot,
} from "@/lib/api/classes";
import { applyScheduleToFuture, generateSessions } from "@/lib/api/sessions";
import type { CohortScheduleRow } from "@/lib/api/types";

// Monday first, Sunday last: the week as a person reads it, not as Postgres
// numbers it. The weekday values are still Postgres's DOW.
const DAYS = [
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
  { weekday: 0, label: "Sunday" },
];

const dayName = (weekday: number) =>
  DAYS.find((d) => d.weekday === weekday)?.label ?? "?";

/** One meeting in the editor. `key` is local, so two new rows stay distinct. */
interface Slot {
  key: string;
  weekday: number;
  startTime: string;
  duration: string;
}

let nextKey = 0;
const newSlot = (weekday = 2): Slot => ({
  key: `s${nextKey++}`,
  weekday,
  startTime: "09:00",
  duration: "",
});

/** "09:00:00" -> "09:00", so the value fits an <input type="time">. */
const toInputTime = (t: string) => t.slice(0, 5);

const sortSlots = (slots: Slot[]) =>
  [...slots].sort(
    (a, b) =>
      ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) ||
      a.startTime.localeCompare(b.startTime),
  );

const sameSlots = (a: Slot[], b: Slot[]) => {
  if (a.length !== b.length) return false;
  const left = sortSlots(a);
  const right = sortSlots(b);
  return left.every(
    (slot, i) =>
      slot.weekday === right[i].weekday &&
      slot.startTime === right[i].startTime &&
      slot.duration === right[i].duration,
  );
};

/**
 * When each cohort meets.
 *
 * One cohort, one visible list of days. The previous editor had a single
 * seven-row grid that stood for whichever cohorts you had ticked: with none
 * ticked it belonged to nobody, with one it was that cohort's, with three it
 * was a new pattern about to overwrite all of them — and only a line of grey
 * text said which. Cohorts that genuinely differ could never be seen at the
 * same time, and all seven weekdays sat there whether you met on them or not.
 *
 * Here a cohort shows the days it actually meets, each with its own time, and
 * "Copy to" covers cohorts that share a pattern without making that the shape
 * of the whole screen.
 */
const Schedule = () => {
  const { toast } = useToast();
  const { activeClass, cohorts, isLoading: classLoading } = useActiveClass();

  const [slots, setSlots] = useState<Record<string, Slot[]>>({});
  const [saved, setSaved] = useState<Record<string, Slot[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genFrom, setGenFrom] = useState("");
  const [genTo, setGenTo] = useState("");

  const load = useCallback(async () => {
    if (!activeClass) return;
    setIsLoading(true);
    try {
      const rows = await listSchedules(activeClass.id);
      const byCohort: Record<string, Slot[]> = {};
      cohorts.forEach((c) => {
        byCohort[c.id] = [];
      });
      rows.forEach((r: CohortScheduleRow) => {
        (byCohort[r.cohort_id] ??= []).push({
          key: `s${nextKey++}`,
          weekday: r.weekday,
          startTime: toInputTime(r.start_time),
          duration: r.duration_minutes ? String(r.duration_minutes) : "",
        });
      });
      setSlots(byCohort);
      setSaved(structuredClone(byCohort));
    } catch (e) {
      toast({
        title: "Could not load the schedule",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [activeClass, cohorts, toast]);

  useEffect(() => {
    void load();
    if (activeClass) {
      setGenFrom(activeClass.term_starts_on);
      setGenTo(activeClass.term_ends_on);
    }
  }, [activeClass, load]);

  const cohortName = (id: string) =>
    `Cohort ${cohorts.find((c) => c.id === id)?.label ?? "?"}`;

  const update = (cohortId: string, next: Slot[]) =>
    setSlots((prev) => ({ ...prev, [cohortId]: next }));

  const addSlot = (cohortId: string) => {
    const existing = slots[cohortId] ?? [];
    // Start on a day this cohort does not already use, so pressing Add twice
    // does not quietly make a duplicate the server will then reject.
    const taken = new Set(existing.map((s) => s.weekday));
    const free = DAYS.find((d) => !taken.has(d.weekday))?.weekday ?? 2;
    update(cohortId, [...existing, newSlot(free)]);
  };

  const patch = (cohortId: string, key: string, change: Partial<Slot>) =>
    update(
      cohortId,
      (slots[cohortId] ?? []).map((s) =>
        s.key === key ? { ...s, ...change } : s,
      ),
    );

  const removeSlot = (cohortId: string, key: string) =>
    update(
      cohortId,
      (slots[cohortId] ?? []).filter((s) => s.key !== key),
    );

  const copyTo = (fromId: string, toId: string) => {
    update(
      toId,
      (slots[fromId] ?? []).map((s) => ({ ...s, key: `s${nextKey++}` })),
    );
    toast({
      title: "Copied",
      description: `${cohortName(fromId)}'s days copied to ${cohortName(toId)}. Save to put it into effect.`,
    });
  };

  const dirty = cohorts.filter(
    (c) => !sameSlots(slots[c.id] ?? [], saved[c.id] ?? []),
  );

  /** Two meetings on the same weekday at the same time is what the server rejects. */
  const duplicatesIn = (cohortId: string) => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    (slots[cohortId] ?? []).forEach((s) => {
      const k = `${s.weekday}-${s.startTime}`;
      if (seen.has(k)) dupes.add(k);
      seen.add(k);
    });
    return dupes;
  };

  const anyDuplicates = cohorts.some((c) => duplicatesIn(c.id).size > 0);

  const handleSave = async () => {
    if (!activeClass || dirty.length === 0) return;
    setIsSaving(true);
    try {
      for (const cohort of dirty) {
        const payload: ScheduleSlot[] = (slots[cohort.id] ?? []).map((s) => ({
          weekday: s.weekday,
          startTime: s.startTime,
          durationMinutes: s.duration ? Number(s.duration) : undefined,
        }));
        await setCohortSchedules([cohort.id], payload);
      }

      const result = await applyScheduleToFuture(activeClass.id, {
        cohortIds: dirty.map((c) => c.id),
      });

      const changes = [
        result.moved > 0 && `${result.moved} moved`,
        result.removed > 0 && `${result.removed} removed`,
        result.created > 0 && `${result.created} added`,
      ].filter(Boolean);

      toast({
        title: `Saved ${dirty.length} cohort${dirty.length === 1 ? "" : "s"}`,
        description:
          changes.length === 0
            ? "No session from today onward needed changing."
            : `${changes.join(", ")}, from today onward. Nothing earlier changed, and sessions you cancelled or moved by hand were left alone.`,
      });
      await load();
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

  const handleGenerate = async () => {
    if (!activeClass) return;
    setIsGenerating(true);
    try {
      const created = await generateSessions(activeClass.id, {
        from: genFrom || undefined,
        to: genTo || undefined,
      });
      toast({
        title: created === 0 ? "Nothing new to create" : "Sessions created",
        description:
          created === 0
            ? "Every scheduled day in that range already has a session."
            : `${created} session${created === 1 ? "" : "s"} created. Days that already existed were left alone.`,
      });
    } catch (e) {
      toast({
        title: "Could not create the sessions",
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
      <Card className="border-2">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Weekly pattern</CardTitle>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin opacity-60" />}
        </CardHeader>

        <CardContent className="space-y-5">
          {cohorts.map((cohort) => {
            const rows = sortSlots(slots[cohort.id] ?? []);
            const dupes = duplicatesIn(cohort.id);
            const isDirty = dirty.some((c) => c.id === cohort.id);
            const others = cohorts.filter((c) => c.id !== cohort.id);

            return (
              <div key={cohort.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Cohort {cohort.label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {rows.length === 0
                      ? "does not meet"
                      : `${rows.length} meeting${rows.length === 1 ? "" : "s"} a week`}
                  </span>
                  {isDirty && (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      unsaved
                    </span>
                  )}

                  {others.length > 0 && rows.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" className="ml-auto">
                          <Copy className="mr-1 h-3.5 w-3.5" />
                          Copy to
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {others.map((o) => (
                          <DropdownMenuItem
                            key={o.id}
                            onClick={() => copyTo(cohort.id, o.id)}
                          >
                            Cohort {o.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>

                <div className="space-y-1 rounded-md border p-2">
                  {rows.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-muted-foreground">
                      No days yet.
                    </p>
                  ) : (
                    rows.map((slot) => {
                      const clashes = dupes.has(
                        `${slot.weekday}-${slot.startTime}`,
                      );
                      return (
                        <div
                          key={slot.key}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Select
                            value={String(slot.weekday)}
                            onValueChange={(v) =>
                              patch(cohort.id, slot.key, { weekday: Number(v) })
                            }
                          >
                            <SelectTrigger className="w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DAYS.map((d) => (
                                <SelectItem
                                  key={d.weekday}
                                  value={String(d.weekday)}
                                >
                                  {d.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Input
                            type="time"
                            className={`w-32 ${clashes ? "border-destructive" : ""}`}
                            value={slot.startTime}
                            onChange={(e) =>
                              patch(cohort.id, slot.key, {
                                startTime: e.target.value,
                              })
                            }
                          />

                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={1}
                              className="w-24"
                              placeholder={String(
                                activeClass.default_duration_minutes,
                              )}
                              value={slot.duration}
                              onChange={(e) =>
                                patch(cohort.id, slot.key, {
                                  duration: e.target.value,
                                })
                              }
                            />
                            <span className="text-xs text-muted-foreground">
                              min
                            </span>
                          </div>

                          <Button
                            size="sm"
                            variant="ghost"
                            title={`Remove ${dayName(slot.weekday)}`}
                            onClick={() => removeSlot(cohort.id, slot.key)}
                          >
                            <X className="h-4 w-4" />
                          </Button>

                          {clashes && (
                            <span className="text-xs text-destructive">
                              same day and time as another row
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => addSlot(cohort.id)}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Add a day
                  </Button>
                </div>
              </div>
            );
          })}

          {cohorts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              This class has no cohorts yet. Add one under Classes.
            </p>
          )}

          <div className="flex items-start gap-3 border-t pt-3">
            <Button
              className="shrink-0"
              onClick={handleSave}
              disabled={isSaving || dirty.length === 0 || anyDuplicates}
            >
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {dirty.length === 0
                ? "Saved"
                : `Save ${dirty.length} cohort${dirty.length === 1 ? "" : "s"}`}
            </Button>
            <p className="text-xs text-muted-foreground">
              Saving takes effect from today: sessions move to their new times,
              days a cohort no longer meets are removed, and new ones are created
              through to the end of term. Nothing earlier changes, and a session
              you cancelled or moved by hand stays as it is. Leave a length blank
              to use the class default ({activeClass.default_duration_minutes}{" "}
              minutes).
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Backfill earlier sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid max-w-md grid-cols-2 gap-3">
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

          <Button
            variant="outline"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CalendarPlus className="mr-2 h-4 w-4" />
            )}
            Create sessions in this range
          </Button>

          <p className="text-xs text-muted-foreground">
            Only needed for days already in the past — a class set up mid-term,
            say. Saving the pattern above already handles everything from today
            onward. Days that already have a session are left alone either way.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default Schedule;
