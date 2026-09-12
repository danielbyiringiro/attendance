import { useEffect, useState } from "react";
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
import { useToast } from "@/hooks/use-toast";
import { cancelSession } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

/**
 * Call off one cohort's session.
 *
 * Lifted out of SessionList so the month view can offer it too. Destructive in
 * a way worth repeating on screen: migration 032 deletes every attendance
 * record against a cancelled session, check-ins included, because a class that
 * did not happen has no attendance. Uncancelling does not bring them back.
 *
 * Per cohort by design. Calling off Cohort A's Tuesday leaves Cohort B's alone.
 * A date the whole class is off is a different action — see NoClassDays, which
 * is also remembered, so regenerating does not undo it.
 */
const SessionCancelDialog = ({
  session,
  cohortLabel,
  onClose,
  onCancelled,
}: {
  session: SessionRow | null;
  cohortLabel: string;
  onClose: () => void;
  onCancelled: () => void | Promise<void>;
}) => {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (session) setReason("");
  }, [session]);

  const handleCancel = async () => {
    if (!session) return;
    setIsSaving(true);
    try {
      const removed = await cancelSession(session.id, reason.trim() || undefined);
      toast({
        title: "Class cancelled",
        description:
          removed === 0
            ? "Nothing was recorded against it. Only this cohort's session was affected."
            : `${removed} attendance record${removed === 1 ? "" : "s"} removed, check-ins included — a class that did not happen has no attendance. Only this cohort's session was affected.`,
      });
      onClose();
      await onCancelled();
    } catch (e) {
      toast({
        title: "Could not cancel",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const dateOf = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this class</DialogTitle>
          <DialogDescription>
            {session && (
              <>
                {dateOf(session.session_date)}, cohort {cohortLabel}. Only this
                cohort is affected — every other cohort keeps its session that
                day.{" "}
                <strong className="text-foreground">
                  Every attendance record against it is deleted, including
                  anyone who already checked in.
                </strong>{" "}
                A class that did not happen has no attendance, and uncancelling
                does not bring the check-ins back.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="cancel-reason">Reason (optional)</Label>
          <Input
            id="cancel-reason"
            value={reason}
            placeholder="Public holiday"
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Shown to students in place of the session.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            onClick={handleCancel}
            disabled={isSaving}
          >
            Cancel the class
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SessionCancelDialog;
