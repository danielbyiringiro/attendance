// What a member of staff meets when they open a paused app (055).
//
// The banner alone was not enough. Every screen still looked usable, so the
// honest reading of it was "something is broken" rather than "somebody paused
// this on purpose" — and for an admin, who is the one person who can undo it,
// that is the worst possible impression.
//
// So while paused: everything but Admin and Logout is greyed and inert, and
// this says why. It can be escaped, because a TA may genuinely want to read a
// register they cannot change.

import { useEffect, useState } from "react";
import { PauseCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ServiceState } from "@/lib/api/service";

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const PausedInterrupt = ({
  service,
  isAdmin,
  onGoToAdmin,
}: {
  service: ServiceState;
  isAdmin: boolean;
  onGoToAdmin: () => void;
}) => {
  const [open, setOpen] = useState(false);

  // Opens when the pause starts, and closes by itself when it ends — somebody
  // who dismissed it should not have to dismiss it again after the app came
  // back, and somebody who left the tab open should see it go.
  useEffect(() => {
    setOpen(service.paused);
  }, [service.paused]);

  if (!service.paused) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PauseCircle className="h-5 w-5 text-warning" aria-hidden />
            The app is paused
          </DialogTitle>
          <DialogDescription>
            {service.message ?? "An admin has paused it for maintenance."}{" "}
            Nobody can check in, and nothing can be marked, opened, closed or
            edited.{" "}
            {service.ends_at
              ? `It should be back by ${time(service.ends_at)}.`
              : "It stays paused until an admin resumes it."}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "Admin still works, so you can resume it there. Everything else is greyed out until you do."
            : "You can close this and read anything you like — nothing can be changed until it resumes."}
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {isAdmin ? "Stay here" : "Close"}
          </Button>
          {isAdmin && (
            <Button
              onClick={() => {
                setOpen(false);
                onGoToAdmin();
              }}
            >
              Go to Admin
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PausedInterrupt;
