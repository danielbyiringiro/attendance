// The warning before a scheduled pause (056).
//
// Two strengths, because one is wrong at both ends. A strip is easy to ignore
// an hour out, and that is fine — nothing has happened yet. Ten minutes out, a
// student about to walk into a lecture and a TA about to open a session both
// need to know now, so it becomes a dialog they have to dismiss.
//
// Dismissed once, it stays dismissed for that scheduled time. Remembering it
// against the start time rather than a plain flag means a NEW schedule warns
// again, while the one they have already read does not come back every minute.

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
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

/** How close the pause has to be before it interrupts rather than informs. */
const LOUD_WITHIN_MINUTES = 15;

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const day = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? ""
    : ` on ${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`;
};

const minutesUntil = (iso: string | null) =>
  iso ? Math.round((new Date(iso).getTime() - Date.now()) / 60000) : Infinity;

/** Remembered per scheduled start, so a new schedule warns again. */
const seenKey = (startsAt: string | null) => `pause-warning:${startsAt ?? ""}`;

const wasSeen = (startsAt: string | null) => {
  try {
    return sessionStorage.getItem(seenKey(startsAt)) === "1";
  } catch {
    // Private windows and blocked storage throw. Warning twice is a far
    // smaller problem than not warning at all, so carry on as if unseen.
    return false;
  }
};

const remember = (startsAt: string | null) => {
  try {
    sessionStorage.setItem(seenKey(startsAt), "1");
  } catch {
    // Nothing to do: it will simply warn again.
  }
};

/**
 * The quiet half: a strip that says what is coming. Renders nothing unless a
 * pause is scheduled.
 */
export const PauseWarningStrip = ({ service }: { service: ServiceState }) => {
  if (service.state !== "scheduled") return null;
  const mins = minutesUntil(service.starts_at);

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border-2 border-warning bg-warning/10 px-4 py-3 text-sm"
    >
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0">
        <span className="font-medium">
          Attendance pauses at {time(service.starts_at)}
          {day(service.starts_at)}
          {mins <= 90 && mins > 0 ? ` — in ${mins} minute${mins === 1 ? "" : "s"}` : ""}.
        </span>{" "}
        {service.message ?? "Planned maintenance."}{" "}
        {service.ends_at ? `Expected back by ${time(service.ends_at)}.` : ""}
      </p>
    </div>
  );
};

/**
 * The loud half: a dialog, once, when the pause is close enough that somebody
 * is about to start something they will not be able to finish.
 */
export const PauseWarningDialog = ({ service }: { service: ServiceState }) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (service.state !== "scheduled") return;
    const mins = minutesUntil(service.starts_at);
    if (mins > LOUD_WITHIN_MINUTES || mins < 0) return;
    if (wasSeen(service.starts_at)) return;
    setOpen(true);
  }, [service.state, service.starts_at]);

  const close = () => {
    remember(service.starts_at);
    setOpen(false);
  };

  if (service.state !== "scheduled") return null;
  const mins = Math.max(minutesUntil(service.starts_at), 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-warning" aria-hidden />
            Attendance pauses in {mins} minute{mins === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            At {time(service.starts_at)}
            {day(service.starts_at)}, check-in stops and nothing can be recorded
            or changed.{" "}
            {service.message ?? "Planned maintenance."}{" "}
            {service.ends_at
              ? `It should be back by ${time(service.ends_at)}.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={close}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
