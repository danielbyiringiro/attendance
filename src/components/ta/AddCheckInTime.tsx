import { useState } from "react";
import { Button } from "@/components/ui/button";
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
 * A button that opens a small dialog, rather than a box always on the card:
 * it is used a few times a term, and a number field sitting under every open
 * session was clutter the rest of the time. Quick amounts cover the usual
 * case in one tap; the box takes anything else.
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

/** One tap for the amounts people actually give. The box takes anything else. */
const QUICK = [2, 5, 10] as const;

const AddCheckInTime = ({
  session,
  onChanged,
  className = "",
  buttonClassName = "w-full",
}: {
  session: SessionRow;
  /** Re-read, so the countdown picks up the new closing time. */
  onChanged: () => void | Promise<void>;
  /** On the wrapper, for placing it. */
  className?: string;
  /** On the button that opens the dialog. */
  buttonClassName?: string;
}) => {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(readStored);
  const [isBusy, setIsBusy] = useState(false);

  if (session.status !== "open") return null;

  const valid = isValid(value);
  const inputId = `add-time-${session.id}`;
  const extra = session.extra_minutes ?? 0;

  const handleAdd = async (minutes: number) => {
    if (!isValid(String(minutes))) return;
    setIsBusy(true);
    try {
      await extendCheckIn(session.id, minutes);
      try {
        localStorage.setItem(STORAGE_KEY, String(minutes));
      } catch {
        // Not remembering it is not a reason to fail the add.
      }
      setValue(String(minutes));
      toast({
        title: `Added ${minutes} minute${minutes === 1 ? "" : "s"}`,
        description: "Check-in stays open longer. The code has not changed.",
      });
      setOpen(false);
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
      <Button
        size="sm"
        variant="outline"
        className={buttonClassName}
        onClick={() => setOpen(true)}
      >
        <TimerReset className="mr-1 h-4 w-4" />
        Add time
        {extra > 0 && (
          <span className="ml-1 text-muted-foreground">(+{extra} so far)</span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !isBusy && setOpen(o)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add time to check-in</DialogTitle>
            <DialogDescription>
              Keeps check-in open longer with the same code, so nothing on the
              screen changes except the clock.
              {extra > 0 &&
                ` ${extra} minute${extra === 1 ? " has" : "s have"} been added so far.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex gap-2">
              {QUICK.map((m) => (
                <Button
                  key={m}
                  variant="outline"
                  className="flex-1"
                  disabled={isBusy}
                  onClick={() => void handleAdd(m)}
                >
                  +{m} min
                </Button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor={inputId} className="whitespace-nowrap text-sm">
                Or add
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
                  if (e.key === "Enter" && valid) void handleAdd(Number(value));
                }}
                className="h-9 w-20"
                autoFocus
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
            {!valid && (
              <p className="text-xs text-destructive">
                A whole number of minutes, {MIN_MINUTES} to {MAX_MINUTES}.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={isBusy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!valid || isBusy}
              onClick={() => void handleAdd(Number(value))}
            >
              {isBusy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <TimerReset className="mr-1 h-4 w-4" />
              )}
              Add {valid ? `${value} min` : "time"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AddCheckInTime;
