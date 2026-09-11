import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Clock } from "lucide-react";
import {
  countdown,
  phaseLabel,
  sessionWindow,
  type SessionWindowInput,
} from "@/lib/sessionWindow";

const time = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * What the check-in window is doing, right now.
 *
 * The dashboard used to print `status` straight from the row, and `status` only
 * changes when somebody presses a button. So a session whose window closed two
 * hours ago still showed a green "open" badge, and a session due to start in
 * five minutes showed "scheduled" with no hint of when it becomes openable.
 * Neither told the TA the thing they actually wanted to know.
 */
const SessionWindowBadge = ({
  session,
  now,
}: {
  session: SessionWindowInput;
  now: Date;
}) => {
  const w = sessionWindow(session, now);

  if (w.phase === "expired") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        Window passed
      </Badge>
    );
  }

  if (w.phase === "done") {
    return <Badge variant="secondary">{session.status}</Badge>;
  }

  if (w.phase === "not_opened") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Clock className="h-3 w-3" />
        {w.msUntilChange === null
          ? "Opening"
          : `Opens in ${countdown(w.msUntilChange)}`}
      </Badge>
    );
  }

  return (
    <Badge
      variant={w.phase === "live_late" ? "outline" : "default"}
      className={`gap-1 ${w.phase === "live_late" ? "border-warning text-warning" : ""}`}
    >
      <Clock className="h-3 w-3" />
      {phaseLabel(w)}
      {w.msUntilChange !== null && ` · ${countdown(w.msUntilChange)}`}
    </Badge>
  );
};

/**
 * The sentence under the badge. Says what happens next and when, in words,
 * because a countdown alone does not say what it is counting towards.
 */
export const SessionWindowNote = ({
  session,
  now,
}: {
  session: SessionWindowInput;
  now: Date;
}) => {
  const w = sessionWindow(session, now);

  switch (w.phase) {
    case "not_opened":
      return (
        <p className="text-xs text-muted-foreground">
          {w.msUntilChange === null
            ? "Opening itself now. Open it by hand if you would rather not wait."
            : `Opens by itself ${session.early_open_minutes} minutes before the class. Opening early does not shorten the window.`}
        </p>
      );
    case "opens_soon":
      return (
        <p className="text-xs text-muted-foreground">
          Open, but not accepting marks until {time(w.opensAt)}.
        </p>
      );
    case "live":
      return (
        <p className="text-center text-xs text-muted-foreground">
          On time until {time(w.lateFrom)}, then marks are recorded late.
          Check-in closes {time(w.closesAt)}.
        </p>
      );
    case "live_late":
      return (
        <p className="text-center text-xs text-warning">
          Past {time(w.lateFrom)} — anyone checking in now is recorded late.
          Closes {time(w.closesAt)}.
        </p>
      );
    case "expired":
      return (
        <p className="text-xs text-destructive">
          Check-in stopped accepting marks at {time(w.closesAt)} and this
          session has not closed yet. Closing is what records everyone who did
          not mark as absent, so close it rather than leaving it.
        </p>
      );
    case "done":
      return null;
  }
};

export default SessionWindowBadge;
