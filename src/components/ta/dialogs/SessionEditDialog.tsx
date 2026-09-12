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
import { updateSession } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";

/**
 * Move or retime one session.
 *
 * Lifted out of SessionList so the month view can offer the same thing. It owns
 * its form state rather than taking it as props: the caller has a session or it
 * has null, which is the whole of what it needs to know, and two screens both
 * threading five fields and a busy flag is how they drift apart.
 *
 * Changes this session only. The weekly pattern is untouched, and
 * update_session sets moved_manually so a later schedule save leaves it alone.
 */
const SessionEditDialog = ({
  session,
  timezone,
  cohortLabel,
  onClose,
  onSaved,
}: {
  session: SessionRow | null;
  /** The class's own timezone. See the note on reading the time back. */
  timezone: string;
  cohortLabel: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) => {
  const { toast } = useToast();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [signup, setSignup] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    setDate(session.session_date);
    // Read back in the CLASS's timezone, because that is the clock the server
    // resolves the value against when it is sent. Formatting in the viewer's
    // zone would show a TA abroad a time the room never met at, and saving it
    // unchanged would then silently move the session.
    setTime(
      new Date(session.starts_at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone,
      }),
    );
    setDuration(String(session.duration_minutes));
    setSignup(String(session.auto_close_minutes));
  }, [session, timezone]);

  const handleSave = async () => {
    if (!session) return;
    setIsSaving(true);
    try {
      await updateSession(session.id, {
        date: date || undefined,
        startTime: time || undefined,
        durationMinutes: duration ? Number(duration) : undefined,
        autoCloseMinutes: signup ? Number(signup) : undefined,
      });
      toast({
        title: "Session moved",
        description: "Only this one session changed.",
      });
      onClose();
      await onSaved();
    } catch (e) {
      toast({
        title: "Could not change the session",
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
          <DialogTitle>Move this session</DialogTitle>
          <DialogDescription>
            {session && (
              <>
                {dateOf(session.session_date)}, cohort {cohortLabel}. Changes
                this session only — the weekly pattern is left alone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="edit-date">Date</Label>
            <Input
              id="edit-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-time">Start</Label>
            <Input
              id="edit-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-duration">Class runs (min)</Label>
            <Input
              id="edit-duration"
              type="number"
              min={1}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-signup">Sign-up open (min)</Label>
            <Input
              id="edit-signup"
              type="number"
              min={1}
              value={signup}
              onChange={(e) => setSignup(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How long check-in stays open once you open it.
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A session that has already run cannot be moved: attendance is recorded
          against it, and moving it would put those marks on a different day.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SessionEditDialog;
