import { useEffect, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

interface ConfirmDeleteProps {
  /** What the first press offers: "Delete permanently", "Remove student". */
  label: string;
  /** What the second press says. Defaults to "Yes, <label lowercased>". */
  confirmLabel?: string;
  /** What is about to go, in a sentence. The whole point of the second step. */
  warning: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  isWorking?: boolean;
  /** Rendered before the label on the button that opens this. */
  icon?: ReactNode;
  size?: "sm" | "default";
  /**
   * Changing this closes the confirmation.
   *
   * Pass whatever identifies the thing being deleted, or the dialog's open
   * state: a confirmation left standing while the thing underneath changes is
   * one press away from deleting something nobody has looked at.
   */
  resetKey?: unknown;
  className?: string;
}

/**
 * A delete that takes two presses, with the consequence in between.
 *
 * Every destructive action here already explained itself — a preview of what
 * goes, often a typed class code. What none of them had was a moment between
 * deciding and doing. A typed code is read before it is typed and then becomes
 * muscle memory; a preview is read once and scrolled past.
 *
 * This was a line of small red text beside the button first, and it read like a
 * form hint: something to click past, not something to stop at. It is a modal
 * over the top now, because the whole job of the second step is to interrupt,
 * and because a full-width warning cannot sit in a DialogFooter without
 * flattening the Cancel button next to it.
 *
 * Used everywhere something is destroyed — a class, a roster, a student, a
 * staff member, a day off, a cancelled session's check-ins — so "the second
 * press is the real one" is a habit rather than a special case.
 */
const ConfirmDelete = ({
  label,
  confirmLabel,
  warning,
  onConfirm,
  disabled = false,
  isWorking = false,
  icon,
  size = "default",
  resetKey,
  className,
}: ConfirmDeleteProps) => {
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setAsking(false);
  }, [resetKey]);

  // Something that cannot be pressed cannot stay open either: a preview that
  // reloads, or a confirmation that stops matching, takes the question with it
  // rather than leaving a live button over stale numbers.
  useEffect(() => {
    if (disabled) setAsking(false);
  }, [disabled]);

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size={size}
        className={className}
        disabled={disabled || isWorking}
        onClick={() => setAsking(true)}
      >
        {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon}
        {label}
      </Button>

      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className="border-2 border-destructive">
          <AlertDialogHeader>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/15">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </span>
              <div className="min-w-0 space-y-1.5 text-left">
                <AlertDialogTitle className="text-destructive">
                  This cannot be undone
                </AlertDialogTitle>
                {/* Not muted: this sentence is the reason the step exists. */}
                <AlertDialogDescription className="text-sm text-foreground">
                  {warning}
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={onConfirm}
            >
              {confirmLabel ?? `Yes, ${label.toLowerCase()}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ConfirmDelete;
