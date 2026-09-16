import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

interface ConfirmDeleteProps {
  /** What the first press offers: "Delete permanently", "Remove student". */
  label: string;
  /** What the second press says. Defaults to "Yes, <label lowercased>". */
  confirmLabel?: string;
  /** One line naming what is about to go. Shown only once armed. */
  warning: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  isWorking?: boolean;
  /** Rendered before the label on both presses. */
  icon?: ReactNode;
  size?: "sm" | "default";
  /**
   * Changing this disarms.
   *
   * Pass whatever identifies the thing being deleted, or the dialog's open
   * state. Without it a dialog closed while armed reopens armed, one press
   * away from deleting something the person has not looked at yet.
   */
  resetKey?: unknown;
  className?: string;
}

/**
 * A delete that takes two presses, with the warning between them.
 *
 * Every destructive action in this app already explains itself — a preview of
 * what goes, often a typed class code. What none of them had was a moment
 * between deciding and doing. The typed code is read before it is typed and
 * then muscle memory; the preview is read once and scrolled past. The second
 * press is deliberately not a better explanation, it is a pause with the
 * consequence in front of you.
 *
 * Used everywhere something is destroyed — a class, a roster, a student, a
 * staff member, a day off, a cancelled session's check-ins — so that "the
 * second press is the real one" is a habit rather than a special case.
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
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false);
  }, [resetKey]);

  // Something that cannot be pressed cannot stay armed either: a preview that
  // reloads, or a confirmation that stops matching, takes the armed state with
  // it rather than leaving a live button behind stale numbers.
  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled]);

  if (!armed) {
    return (
      <Button
        type="button"
        variant="destructive"
        size={size}
        className={className}
        disabled={disabled || isWorking}
        onClick={() => setArmed(true)}
      >
        {icon}
        {label}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {warning}
      </span>
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={isWorking}
        onClick={() => setArmed(false)}
      >
        Back
      </Button>
      <Button
        type="button"
        variant="destructive"
        size={size}
        disabled={disabled || isWorking}
        onClick={onConfirm}
      >
        {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon}
        {confirmLabel ?? `Yes, ${label.toLowerCase()}`}
      </Button>
    </div>
  );
};

export default ConfirmDelete;
