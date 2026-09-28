// An announcement that asks to be read (061).
//
// 049 put announcements under Help with an unread dot, and said in its own
// header that "an announcement nobody notices is a changelog". The dot turned
// out to be exactly that: somebody who never opens Help never sees it, and the
// things worth announcing — we are pausing on Saturday, check-in closes when
// class starts now — are the ones people need to have been TOLD.
//
// So an announcement posted with a reminder period appears here, and comes back
// until it is acknowledged. The period is the part that makes this bearable: a
// notice appearing on every page load is one people learn to click away without
// reading, which is worse than the dot it replaced.
//
// WHY "LATER" IS OFFERED AT ALL
//
// Because the alternative is a notice somebody cannot get past while a room of
// students is waiting to check in. Dismissing it starts the clock rather than
// ending it: they will be asked again, and the admin can see how many times
// somebody has been shown one and still not read it.

import { useCallback, useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  dueAnnouncements,
  markAnnouncementsRead,
  noteAnnouncementsShown,
  type Announcement,
} from "@/lib/api/help";

const postedOn = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const AnnouncementNudge = ({
  /**
   * False while something more important is already in front of them — a pause
   * notice, for instance. Two stacked modals is how both get dismissed unread.
   */
  enabled = true,
  /** So the sidebar dot can clear when these are acknowledged here. */
  onRead,
}: {
  enabled?: boolean;
  onRead?: () => void;
}) => {
  const [due, setDue] = useState<Announcement[]>([]);
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;

    /*
     * Asked once, when the dashboard opens.
     *
     * Not on a timer: the period is measured in hours, so polling would only
     * ever find the same answer, and an announcement appearing mid-register is
     * an interruption nobody asked for. The next sign-in is soon enough.
     */
    void dueAnnouncements()
      .then((rows) => {
        if (!live || rows.length === 0) return;
        setDue(rows);
        // Recorded as shown when it goes on screen, not when it is dismissed.
        // Somebody who closes the tab without answering has still had it put in
        // front of them, and should not be shown it again this afternoon.
        void noteAnnouncementsShown(rows.map((a) => a.id)).catch(() => {
          // The clock not restarting means they see it again sooner than
          // intended. Harmless, and not worth an error in front of them.
        });
      })
      .catch(() => {
        // A notice that cannot be fetched is not an error worth showing: the
        // dot in Help is still there, and so is the announcement.
      });

    return () => {
      live = false;
    };
  }, [enabled]);

  const acknowledge = useCallback(async () => {
    setIsWorking(true);
    try {
      await markAnnouncementsRead(due.map((a) => a.id));
      onRead?.();
      setDue([]);
    } catch {
      // Could not record it: close anyway rather than trapping them, and it
      // will come back when the period is up — which is the fallback working
      // as intended rather than a failure.
      setDue([]);
    } finally {
      setIsWorking(false);
    }
  }, [due, onRead]);

  if (!enabled || due.length === 0) return null;

  const several = due.length > 1;

  return (
    <Dialog
      open
      // Closing by any route — the X, Escape, the overlay — is "later". It has
      // already been recorded as shown, so this cannot be used to make one
      // disappear for good without reading it.
      onOpenChange={(open) => !open && setDue([])}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" aria-hidden />
            {several ? `${due.length} updates` : "An update"}
          </DialogTitle>
          <DialogDescription>
            {several
              ? "These have not been read yet."
              : "Posted by an admin, and not read yet."}
          </DialogDescription>
        </DialogHeader>

        {/* Scrolls rather than growing: the dialog is already capped at the
            viewport, and several long notices should not push the buttons off
            the bottom of it. */}
        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {due.map((a) => (
            <div key={a.id} className="space-y-1 rounded-lg border p-3">
              <p className="text-sm font-semibold">{a.title}</p>
              <p className="text-xs text-muted-foreground">
                {postedOn(a.posted_at)}
              </p>
              {/* Whitespace kept: somebody wrote this as paragraphs. */}
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {a.body}
              </p>
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            disabled={isWorking}
            onClick={() => setDue([])}
          >
            Later
          </Button>
          <Button disabled={isWorking} onClick={() => void acknowledge()}>
            {several ? "Got it, mark all read" : "Got it"}
          </Button>
        </DialogFooter>

        <p className="text-xs text-muted-foreground">
          "Later" shows this again another day. "Got it" marks it read, and it
          stays in Help under Updates either way.
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default AnnouncementNudge;
