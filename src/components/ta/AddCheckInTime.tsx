import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, TimerReset } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { extendCheckIn } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

/**
 * "Add N minutes" to check-in while it is open (migration 063).
 *
 * For the room still queuing when the countdown runs low. The PIN stays the
 * same, so nothing on the projector has to change but the clock.
 *
 * The number is the lecturer's: typed here, and remembered on this computer so
 * whoever always gives "two more minutes" does not retype it every class. Not
 * a class setting — it is a habit of the person at the desk, not a rule of the
 * class, and two TAs on one class may well differ.
 *
 * Shown only while the session is open. The server refuses anything else, and
 * offering a button that can only fail is worse than not offering it.
 */

const STORAGE_KEY = "attendance.addTimeMinutes";
const DEFAULT_MINUTES = 5;
/** Must match extend_check_in in 063. */
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

const readStored = (): string => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && isValid(v)) return v;
  } catch {
    // Storage blocked: start from the default every time.
  }
  return String(DEFAULT_MINUTES);
};

const isValid = (raw: string): boolean => {
  const n = Number(raw);
  return (
    raw.trim() !== "" &&
    Number.isInteger(n) &&
    n >= MIN_MINUTES &&
    n <= MAX_MINUTES
  );
};

const AddCheckInTime = ({
  session,
  onChanged,
  className = "",
}: {
  session: SessionRow;
  /** Re-read, so the countdown picks up the new closing time. */
  onChanged: () => void | Promise<void>;
  className?: string;
}) => {
  const { toast } = useToast();
  const [value, setValue] = useState(readStored);
  const [isBusy, setIsBusy] = useState(false);

  if (session.status !== "open") return null;

  const valid = isValid(value);
  const inputId = `add-time-${session.id}`;

  const handleAdd = async () => {
    if (!valid) return;
    const minutes = Number(value);
    setIsBusy(true);
    try {
      await extendCheckIn(session.id, minutes);
      try {
        localStorage.setItem(STORAGE_KEY, String(minutes));
      } catch {
        // Not remembering it is not a reason to fail the add.
      }
      toast({
        title: `Added ${minutes} minute${minutes === 1 ? "" : "s"}`,
        description: "Check-in stays open longer. The code has not changed.",
      });
      await onChanged();
    } catch (e) {
      toast({
        title: "Could not add time",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="sr-only">
          Minutes to add
        </Label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
          className="h-9 w-16"
        />
        <span className="text-sm text-muted-foreground">min</span>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={!valid || isBusy}
          onClick={() => void handleAdd()}
        >
          {isBusy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <TimerReset className="mr-1 h-4 w-4" />
          )}
          Add time
        </Button>
      </div>
      {!valid && (
        <p className="mt-1 text-xs text-destructive">
          A whole number of minutes, {MIN_MINUTES} to {MAX_MINUTES}.
        </p>
      )}
      {session.extra_minutes > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {session.extra_minutes} minute{session.extra_minutes === 1 ? "" : "s"}{" "}
          added so far.
        </p>
      )}
    </div>
  );
};

export default AddCheckInTime;
