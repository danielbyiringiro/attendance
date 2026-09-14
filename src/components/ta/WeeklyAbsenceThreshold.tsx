import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { setWeeklyAbsenceThreshold } from "@/lib/api/classes";
import {
  MAX_WEEKLY_ABSENCE_THRESHOLD,
  MIN_WEEKLY_ABSENCE_THRESHOLD,
  thresholdPhrase,
} from "@/lib/weeklyAbsence";

interface WeeklyAbsenceThresholdProps {
  classId: string;
  /** What is stored for the class now. */
  threshold: number;
  /** Re-read the classes, so the report picks the saved number up. */
  onSaved: () => Promise<void> | void;
  /**
   * The number being typed while it is valid, null while it is not, so the
   * weeks on screen can follow it before it is saved.
   */
  onPreview: (threshold: number | null) => void;
  className?: string;
}

const isValidThreshold = (raw: string): boolean => {
  const n = Number(raw);
  return (
    raw.trim() !== "" &&
    Number.isInteger(n) &&
    n >= MIN_WEEKLY_ABSENCE_THRESHOLD &&
    n <= MAX_WEEKLY_ABSENCE_THRESHOLD
  );
};

/**
 * How many absences in a week put a student on the Weekly Absences report.
 *
 * One number for the whole class (migration 043); it was a fixed 2. It lives in
 * the Weekly Absences dialog, beside the cohort filter, because that is where
 * its effect can be seen: a typed number is a preview the weeks follow at once,
 * and only "Save for this class" keeps it. Closing the dialog without saving
 * leaves the class as it was.
 *
 * It was briefly also under Classes. Two places to set one number is one more
 * than it needs, and the one away from the report is the one where you cannot
 * see what the number does.
 */
const WeeklyAbsenceThreshold = ({
  classId,
  threshold,
  onSaved,
  onPreview,
  className,
}: WeeklyAbsenceThresholdProps) => {
  const { toast } = useToast();
  const [value, setValue] = useState(String(threshold));
  const [isSaving, setIsSaving] = useState(false);

  // Follows the stored value when the classes are re-read.
  useEffect(() => {
    setValue(String(threshold));
  }, [threshold]);

  const valid = isValidThreshold(value);
  const parsed = Number(value);
  const changed = valid && parsed !== threshold;

  const handleChange = (raw: string) => {
    setValue(raw);
    onPreview(isValidThreshold(raw) ? Number(raw) : null);
  };

  const handleSave = async () => {
    if (!valid) return;
    setIsSaving(true);
    try {
      await setWeeklyAbsenceThreshold(classId, parsed);
      toast({
        title: "Saved",
        description: `The weekly absence report now lists students absent ${thresholdPhrase(parsed)} in a week.`,
      });
      await onSaved();
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const inputId = `weekly-absence-threshold-${classId}`;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={inputId} className="whitespace-nowrap">
          Listed from
        </Label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={MIN_WEEKLY_ABSENCE_THRESHOLD}
          max={MAX_WEEKLY_ABSENCE_THRESHOLD}
          step={1}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          className="h-9 w-16"
        />
        <span className="whitespace-nowrap text-muted-foreground">
          {valid && parsed === 1 ? "absence" : "absences"} a week
        </span>
        {/* Only when there is something to keep: a Save beside the number the
            class already has reads as if it were unsaved. */}
        {changed && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save for this class
          </Button>
        )}
      </div>

      {!valid ? (
        <p className="mt-1 text-xs text-destructive">
          Enter a whole number from {MIN_WEEKLY_ABSENCE_THRESHOLD} to{" "}
          {MAX_WEEKLY_ABSENCE_THRESHOLD}.
        </p>
      ) : (
        changed && (
          <p className="mt-1 text-xs text-muted-foreground">
            Previewing — not saved. This class is set to {threshold}.
          </p>
        )
      )}
    </div>
  );
};

export default WeeklyAbsenceThreshold;
