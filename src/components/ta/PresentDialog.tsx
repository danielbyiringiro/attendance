import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink } from "lucide-react";
import PresentView from "@/components/ta/PresentView";
import type { SessionRow } from "@/lib/api/types";

/**
 * The code, the countdown and a QR to the site, for showing a room.
 *
 * Takes the live session rather than a snapshot. The caller passes the row it
 * is already keeping current — realtime plus the poll on the attendance tab —
 * so when auto-open mints a PIN or the window closes, the dialog changes with
 * it instead of showing a code that stopped working a minute ago.
 *
 * "Open in a new tab" exists because a dialog is the wrong shape for a
 * projector. It shuts the moment you click the dashboard behind it, and it
 * cannot be dragged onto a second screen. The tab can, and stays there.
 */
const PresentDialog = ({
  session,
  className,
  cohortLabel,
  onOpenChange,
}: {
  session: SessionRow | null;
  className: string;
  cohortLabel: string;
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={session !== null} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>Show the code</DialogTitle>
        <DialogDescription>
          For the room. To keep it up on a second screen while you use the
          dashboard, open it in its own tab.
        </DialogDescription>
      </DialogHeader>

      {session && (
        <PresentView
          session={session}
          className={className}
          cohortLabel={cohortLabel}
        />
      )}

      <DialogFooter className="gap-2">
        <Button
          variant="outline"
          disabled={!session}
          onClick={() => {
            if (!session) return;
            // noopener so the presenter tab cannot reach back into this one.
            window.open(
              `/present/${session.id}`,
              "_blank",
              "noopener,noreferrer",
            );
          }}
        >
          <ExternalLink className="mr-1 h-4 w-4" />
          Open in a new tab
        </Button>
        <Button onClick={() => onOpenChange(false)}>Close</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default PresentDialog;
