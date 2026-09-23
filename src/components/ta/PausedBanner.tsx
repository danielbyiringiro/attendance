// What staff see while the app is paused (055).
//
// A strip across the top of the dashboard rather than a dialog: a TA mid-class
// should not have to dismiss something to see their register. It says what is
// stopped, because "paused" alone reads as "slow" and the next thing they do
// is try to open a session and wonder why it failed.

import { PauseCircle } from "lucide-react";
import { useServiceState } from "@/lib/useServiceState";

const PausedBanner = () => {
  const { paused, message } = useServiceState();
  if (!paused) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border-2 border-warning bg-warning/10 px-4 py-3 text-sm"
    >
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0">
        <span className="font-medium">The app is paused.</span>{" "}
        {message ?? "An admin has paused it for maintenance."} Students cannot
        check in, and nothing can be marked, opened, closed or edited until it
        is resumed. An admin can resume it under Admin.
      </p>
    </div>
  );
};

export default PausedBanner;
