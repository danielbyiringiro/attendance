import { RefreshCw } from "lucide-react";
import { countdown } from "@/lib/sessionWindow";

/**
 * Says the screen is keeping itself up to date, and when it last did.
 *
 * This replaces a refresh button. The button was not wrong when the tab read
 * once on mount and never again, but it put the work on the TA and gave them no
 * way to know whether they needed to press it — the only signal that the count
 * was stale was pressing refresh and watching it change.
 *
 * Now that check-ins arrive on their own, the useful thing is not a button but
 * evidence. A dot that moves and an age that ticks up answer "is this actually
 * live, or has it quietly stopped", which a static screen full of correct
 * numbers cannot.
 *
 * It stays clickable. Realtime needs the table to be in the publication
 * (migration 030), and if that has not been applied the page falls back to
 * polling — so there is still a case for asking now rather than waiting, and
 * hiding the ability to would be hiding it exactly when it matters.
 */
const LiveIndicator = ({
  lastLoadedAt,
  now,
  isLoading,
  onRefresh,
}: {
  lastLoadedAt: Date | null;
  now: Date;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const ageMs = lastLoadedAt ? now.getTime() - lastLoadedAt.getTime() : null;

  // Under five seconds reads as "just now" rather than a number flickering
  // through 1s, 2s, 3s, which draws the eye for no reason.
  const label =
    isLoading || ageMs === null
      ? "Updating"
      : ageMs < 5_000
        ? "Live"
        : `Updated ${countdown(ageMs)} ago`;

  // Past a minute without an update, something is wrong: the poll is 20 seconds
  // while a session is live and two minutes otherwise, so this is the honest
  // way to say "do not trust this number" rather than showing it confidently.
  const stale = ageMs !== null && ageMs > 150_000;

  return (
    <button
      type="button"
      onClick={onRefresh}
      title="Updates by itself. Click to fetch now."
      className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-muted ${
        stale ? "text-warning" : "text-muted-foreground"
      }`}
    >
      {isLoading ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : (
        <span className="relative flex h-2 w-2">
          {!stale && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
          )}
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              stale ? "bg-warning" : "bg-success"
            }`}
          />
        </span>
      )}
      <span className="tabular-nums">{label}</span>
    </button>
  );
};

export default LiveIndicator;
