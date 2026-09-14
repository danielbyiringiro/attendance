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
  /** Re-read the classes, so the Weekly Absences report picks the change up. */
  onSaved: () => Promise<void> | void;
  className?: string;
}

/**
 * How many absences in a week put a student on the Weekly Absences report.
 *
 * Sits under Classes beside the lecturer and FI names, the other settings that
 * report uses: something set once a term, not changed while reading the report.
 * One number for the whole class (migration 043). It was a fixed 2.
 */
const WeeklyAbsenceThreshold = ({
  classId,
  threshold,
  onSaved,
  className,
}: WeeklyAbsenceThresholdProps) => {
  const { toast } = useToast();
  const [value, setValue] = useState(String(threshold));
  const [isSaving, setIsSaving] = useState(false);

  // Follows the stored value when the classes are re-read.
  useEffect(() => {
    setValue(String(threshold));
  }, [threshold]);

  const parsed = Number(value);
  const valid =
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= MIN_WEEKLY_ABSENCE_THRESHOLD &&
    parsed <= MAX_WEEKLY_ABSENCE_THRESHOLD;

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
      <h3 className="mb-2 text-sm font-medium">Weekly absence report</h3>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={inputId}>Absences in a week to be listed</Label>
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={MIN_WEEKLY_ABSENCE_THRESHOLD}
            max={MAX_WEEKLY_ABSENCE_THRESHOLD}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
          />
        </div>

        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={isSaving || !valid || parsed === threshold}
        >
          {isSaving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save
        </Button>
      </div>

      <p
        className={`mt-2 text-xs ${valid ? "text-muted-foreground" : "text-destructive"}`}
      >
        {valid
          ? `Students absent ${thresholdPhrase(parsed)} in a week are listed. Applies to every cohort of this class.`
          : `Enter a whole number from ${MIN_WEEKLY_ABSENCE_THRESHOLD} to ${MAX_WEEKLY_ABSENCE_THRESHOLD}.`}
      </p>
    </div>
  );
};

export default WeeklyAbsenceThreshold;
