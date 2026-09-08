import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Lock, PlayCircle, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { closeSession, openSession } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

interface SessionActionsProps {
  session: SessionRow;
  /** Re-read after the status changes. */
  onChanged: () => void | Promise<void>;
  size?: "sm" | "default";
  /** Fill the width, for the stacked card on the Attendance tab. */
  full?: boolean;
}

/**
 * Open a session, or close it. One button, whichever applies.
 *
 * Extracted so the Attendance tab and the session list cannot drift: two
 * copies of "open, toast the PIN, reload" would eventually disagree about what
 * closing does, and closing is the moment absence becomes a stored fact.
 */
const SessionActions = ({
  session,
  onChanged,
  size = "sm",
  full = false,
}: SessionActionsProps) => {
  const { toast } = useToast();
  const [isBusy, setIsBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setIsBusy(true);
    try {
      await work();
      await onChanged();
    } finally {
      setIsBusy(false);
    }
  };

  const handleOpen = () =>
    run(async () => {
      try {
        const result = await openSession(session.id);
        toast({
          title: `Open — PIN ${result.pin}`,
          description: `Read this out. Check-in closes ${session.auto_close_minutes} minutes from now.`,
        });
      } catch (e) {
        toast({
          title: "Could not open the session",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        });
      }
    });

  const handleClose = () =>
    run(async () => {
      try {
        const absences = await closeSession(session.id);
        toast({
          title: "Session closed",
          description:
            absences === 0
              ? "Everyone enrolled was accounted for."
              : `${absences} student${absences === 1 ? " was" : "s were"} recorded absent.`,
        });
      } catch (e) {
        toast({
          title: "Could not close the session",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        });
      }
    });

  if (session.status === "cancelled") return null;

  const width = full ? "w-full" : "";

  if (session.status === "open") {
    return (
      <Button
        size={size}
        variant="outline"
        className={width}
        disabled={isBusy}
        onClick={handleClose}
      >
        {isBusy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Lock className="mr-1 h-4 w-4" />
        )}
        Close check-in
      </Button>
    );
  }

  if (session.status === "closed") {
    return (
      <Button
        size={size}
        variant="ghost"
        className={width}
        disabled={isBusy}
        title="Open it again — for a student who arrived after you closed it"
        onClick={handleOpen}
      >
        {isBusy ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <RotateCcw className="mr-1 h-4 w-4" />
        )}
        Reopen
      </Button>
    );
  }

  return (
    <Button size={size} className={width} disabled={isBusy} onClick={handleOpen}>
      {isBusy ? (
        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
      ) : (
        <PlayCircle className="mr-1 h-4 w-4" />
      )}
      Open check-in
    </Button>
  );
};

export default SessionActions;
