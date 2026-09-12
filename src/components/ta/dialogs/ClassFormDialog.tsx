import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { createClass, updateClass } from "@/lib/api/classes";
import { listSessions } from "@/lib/api/sessions";
import type { ClassWithCohorts } from "@/lib/api/types";
import { addDays, toDateStr } from "@/lib/dates";

interface ClassFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create. Provide to edit. */
  editing?: ClassWithCohorts | null;
  onSaved: (classId: string) => void;
}

// Enough to cover an institution without offering a scrolling list of every
// zone on earth. Free text would invite a typo that silently shifts every
// session date by a day.
const TIMEZONES = [
  "Africa/Accra",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
];

/**
 * What classes.min_attendance_percentage defaults to in the schema.
 *
 * Repeated here so the form can tell "the TA left it alone" from "the TA chose
 * 75". create_class takes no threshold parameter, so on a new class this is
 * only written when it differs — no point in a second round trip to set a
 * column to the value it already has.
 */
const DEFAULT_THRESHOLD = 75;

const today = () => toDateStr(new Date());

// Sessions only exist between the term dates, so a term ending today produces
// a class that can never have one — and nothing on screen said why. Sixteen
// weeks is a semester; it is a starting point, not a rule.
const defaultTermEnd = () => toDateStr(addDays(new Date(), 16 * 7));

const ClassFormDialog = ({
  open,
  onOpenChange,
  editing,
  onSaved,
}: ClassFormDialogProps) => {
  const { toast } = useToast();
  const isEdit = Boolean(editing);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [termStart, setTermStart] = useState(today());
  const [termEnd, setTermEnd] = useState(defaultTermEnd());
  const [timezone, setTimezone] = useState("Africa/Accra");
  /*
   * The attendance a student has to reach in this class.
   *
   * Held as a string, not a number, because a number input bound to a number
   * cannot be empty mid-typing: clearing it to type "80" gives NaN, and the
   * field either snaps back to a value or shows nothing. Validated on submit.
   */
  const [threshold, setThreshold] = useState(String(DEFAULT_THRESHOLD));
  const [cohortMode, setCohortMode] = useState<"count" | "labels">("count");
  const [cohortCount, setCohortCount] = useState("1");
  const [cohortLabels, setCohortLabels] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  // Sessions that a shortened term would eventually prune. Changing the term
  // does nothing on its own; the next "Save pattern" removes anything beyond
  // the new end that has not run. Saying so up front beats discovering it a
  // week later.
  const [strandedCount, setStrandedCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCode(editing.code);
      setName(editing.name);
      setDescription(editing.description ?? "");
      setTermStart(editing.term_starts_on);
      setTermEnd(editing.term_ends_on);
      setTimezone(editing.timezone);
      setThreshold(String(editing.min_attendance_percentage));
    } else {
      setCode("");
      setName("");
      setDescription("");
      setTermStart(today());
      setTermEnd(today());
      setTimezone("Africa/Accra");
      setThreshold(String(DEFAULT_THRESHOLD));
      setCohortMode("count");
      setCohortCount("1");
      setCohortLabels("");
    }
  }, [open, editing]);

  useEffect(() => {
    if (!editing || termEnd >= editing.term_ends_on) {
      setStrandedCount(0);
      return;
    }
    let cancelled = false;
    listSessions({ classId: editing.id, from: termEnd })
      .then((rows) => {
        if (cancelled) return;
        // Only the ones that have not run: a closed session is never removed,
        // whatever the term says.
        setStrandedCount(
          rows.filter(
            (r) => r.status === "scheduled" && r.session_date > termEnd,
          ).length,
        );
      })
      .catch(() => !cancelled && setStrandedCount(0));
    return () => {
      cancelled = true;
    };
  }, [editing, termEnd]);

  const parsedLabels = cohortLabels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const handleSave = async () => {
    if (!isEdit && code.trim() === "") {
      toast({
        title: "A code is needed",
        description: "It identifies the class, and you type it back to confirm a deletion.",
        variant: "destructive",
      });
      return;
    }
    if (name.trim() === "") {
      toast({ title: "A name is needed", variant: "destructive" });
      return;
    }
    if (termEnd < termStart) {
      toast({
        title: "The term ends before it starts",
        description: "Sessions are only created between these two dates.",
        variant: "destructive",
      });
      return;
    }
    if (termEnd <= today()) {
      toast({
        title: "That term has already ended",
        description:
          "Sessions are only created between the term dates, so this class could never have one. Move the end date forward.",
        variant: "destructive",
      });
      return;
    }

    const thresholdValue = Number(threshold);
    if (
      !Number.isFinite(thresholdValue) ||
      thresholdValue < 0 ||
      thresholdValue > 100
    ) {
      toast({
        title: "Check the required attendance",
        description:
          "It has to be a percentage between 0 and 100. The database refuses anything else, so this catches it before the round trip.",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      if (editing) {
        await updateClass(editing.id, {
          name: name.trim(),
          description: description.trim(),
          termStartsOn: termStart,
          termEndsOn: termEnd,
          timezone,
          minAttendancePercentage: thresholdValue,
        });
        toast({ title: "Class updated" });
        onSaved(editing.id);
      } else {
        const count = Number(cohortCount);
        if (
          cohortMode === "count" &&
          (!Number.isInteger(count) || count < 1 || count > 26)
        ) {
          throw new Error("The number of cohorts must be between 1 and 26.");
        }
        if (cohortMode === "labels" && parsedLabels.length === 0) {
          throw new Error("Give at least one cohort label, or switch to a count.");
        }

        const result = await createClass({
          code: code.trim(),
          name: name.trim(),
          termStartsOn: termStart,
          termEndsOn: termEnd,
          timezone,
          cohortCount: cohortMode === "count" ? count : undefined,
          cohortLabels: cohortMode === "labels" ? parsedLabels : undefined,
        });
        // create_class has no threshold parameter and the column defaults to
        // 75, so this second call only happens when the TA actually chose
        // something else.
        if (thresholdValue !== DEFAULT_THRESHOLD) {
          await updateClass(result.class_id, {
            minAttendancePercentage: thresholdValue,
          });
        }

        toast({
          title: "Class created",
          description: `${result.cohorts.length} cohort${
            result.cohorts.length === 1 ? "" : "s"
          }. Set when each one meets, then generate sessions.`,
        });
        onSaved(result.class_id);
      }
      onOpenChange(false);
    } catch (e) {
      toast({
        title: isEdit ? "Could not update the class" : "Could not create the class",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit class" : "New class"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "The code cannot change — it is what you type to confirm a deletion."
              : "Cohorts are the sections of this class. You can add more later."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="class-code">Code</Label>
              <Input
                id="class-code"
                value={code}
                disabled={isEdit}
                placeholder="INTRO-AI"
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="class-name">Name</Label>
              <Input
                id="class-name"
                value={name}
                placeholder="Introduction to AI"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="class-desc">Description (optional)</Label>
            <Textarea
              id="class-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="term-start">Term starts</Label>
              <Input
                id="term-start"
                type="date"
                value={termStart}
                onChange={(e) => setTermStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="term-end">Term ends</Label>
              <Input
                id="term-end"
                type="date"
                value={termEnd}
                onChange={(e) => setTermEnd(e.target.value)}
              />
            </div>
          </div>

          {strandedCount > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
              <strong>{strandedCount}</strong> session
              {strandedCount === 1 ? "" : "s"} fall after the new end date.
              Shortening the term does not remove them now — the next time you
              save a weekly pattern, any of them that have not run will be
              removed. Sessions that have already been opened, closed or
              cancelled are always kept, whatever the term says.
            </p>
          )}
          <p className="text-xs text-muted-foreground -mt-2">
            Sessions are only generated between these dates.
          </p>

          {/*
            The threshold has driven the roster colouring, the below-threshold
            filter and what a student sees on their own history since it was
            added — and nothing edited it, so every class sat at 75 whatever it
            actually required. The number was already doing work; it just could
            not be set.
          */}
          <div className="space-y-2">
            <Label htmlFor="min-attendance">Required attendance</Label>
            <div className="flex items-center gap-2">
              <Input
                id="min-attendance"
                type="number"
                min={0}
                max={100}
                step={1}
                className="w-24"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Students below this are flagged on the roster and told on their
              own attendance page. Changing it re-colours the existing numbers;
              it does not alter anybody's records.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Each session's date is worked out in this zone, so a late-evening
              class does not land on the wrong day.
            </p>
          </div>

          {/* Cohorts: creation only. Adding is safe, removing is destructive. */}
          {!isEdit && (
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label>Cohorts</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={cohortMode === "count" ? "secondary" : "ghost"}
                    onClick={() => setCohortMode("count")}
                  >
                    How many
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={cohortMode === "labels" ? "secondary" : "ghost"}
                    onClick={() => setCohortMode("labels")}
                  >
                    Name them
                  </Button>
                </div>
              </div>

              {cohortMode === "count" ? (
                <>
                  <Input
                    type="number"
                    min={1}
                    max={26}
                    value={cohortCount}
                    onChange={(e) => setCohortCount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Labelled A, B, C… One is normal.
                  </p>
                </>
              ) : (
                <>
                  <Input
                    value={cohortLabels}
                    placeholder="Morning, Evening"
                    onChange={(e) => setCohortLabels(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated.
                    {parsedLabels.length > 0 &&
                      ` ${parsedLabels.length} cohort${
                        parsedLabels.length === 1 ? "" : "s"
                      }: ${parsedLabels.join(", ")}`}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isEdit ? "Save changes" : "Create class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ClassFormDialog;
