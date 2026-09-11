import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Clock } from "lucide-react";
import {
  countdown,
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

  // A switch on the discriminant rather than a chain of early returns. Narrowing
  // by elimination across two interfaces did not give TypeScript enough to know
  // msUntilClose was a number by the time it reached the live cases; switching
  // on `phase` directly does.
  switch (w.phase) {
    case "expired":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertTriangle className="h-3 w-3" />
          Window passed
        </Badge>
      );

    case "done":
      return <Badge variant="secondary">{session.status}</Badge>;

    case "not_opened":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" />
          {w.msUntilChange === null
            ? "Opening"
            : `Opens in ${countdown(w.msUntilChange)}`}
        </Badge>
      );

    case "opens_soon":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" />
          Opens in {countdown(w.msUntilChange ?? 0)}
        </Badge>
      );

    // Counting to the close, not to the next phase change. Mid-session the next
    // change is the late threshold, and a badge that counted down to that and
    // then started again from a larger number reads as the clock going
    // backwards. The deadline is what a TA is watching.
    case "live":
      return (
        <Badge variant="default" className="gap-1">
          <Clock className="h-3 w-3" />
          Closes in {countdown(w.msUntilClose)}
        </Badge>
      );

    case "live_late":
      return (
        <Badge variant="outline" className="gap-1 border-warning text-warning">
          <Clock className="h-3 w-3" />
          Late · closes in {countdown(w.msUntilClose)}
        </Badge>
      );
  }
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
          On time for another{" "}
          <span className="font-medium tabular-nums text-foreground">
            {countdown(w.msUntilLate ?? 0)}
          </span>{" "}
          until {time(w.lateFrom)}, then marks are recorded late. Check-in
          closes {time(w.closesAt)}.
        </p>
      );
    case "live_late":
      return (
        <p className="text-center text-xs text-warning">
          Past {time(w.lateFrom)} — anyone checking in now is recorded late.
          Check-in closes {time(w.closesAt)}.
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
