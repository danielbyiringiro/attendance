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
  canSweep = true,
}: {
  session: SessionWindowInput;
  now: Date;
  /** See SessionWindowNote — false until migration 031 is applied. */
  canSweep?: boolean;
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
      // Three different situations, and calling all of them "scheduled" is why
      // this was impossible to diagnose: waiting for its turn, due right now,
      // and too late for anything to open it but a person.
      if (w.autoOpenMissed) {
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Not opened
          </Badge>
        );
      }
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" />
          {w.msUntilChange !== null
            ? `Opens in ${countdown(w.msUntilChange)}`
            : canSweep
              ? "Opening"
              : "Not open"}
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
  canSweep = true,
}: {
  session: SessionWindowInput;
  now: Date;
  /**
   * Whether this database opens and closes sessions by itself — false until
   * migration 031 is applied. Promising a TA that a session is "opening itself
   * now" when nothing is going to open it is how somebody ends up standing in
   * front of a class waiting for a PIN that never appears.
   */
  canSweep?: boolean;
}) => {
  const w = sessionWindow(session, now);

  switch (w.phase) {
    case "not_opened":
      if (!canSweep) {
        return (
          <p className="text-xs text-muted-foreground">
            Open it to start check-in. This database does not open sessions
            automatically.
          </p>
        );
      }
      // The span is stated rather than described, because "it opens by itself"
      // plus a session that has not opened is not something a TA can act on.
      // Seeing 08:45 to 09:15 against the clock on the wall is.
      if (w.autoOpenMissed) {
        return (
          <p className="text-xs text-muted-foreground">
            It could have opened itself between {time(w.autoOpenFrom)} and{" "}
            {time(w.autoOpenUntil)}, and did not. Only opening it by hand will
            start check-in now.
          </p>
        );
      }
      return (
        <p className="text-xs text-muted-foreground">
          Opens by itself between {time(w.autoOpenFrom)} and{" "}
          {time(w.autoOpenUntil)}.
          {w.msUntilChange === null
            ? " That has started — it should open within a minute."
            : " Opening early does not shorten the window."}
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
