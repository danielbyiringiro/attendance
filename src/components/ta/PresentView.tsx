import { QRCodeSVG } from "qrcode.react";
import { Clock } from "lucide-react";
import type { SessionRow } from "@/lib/api/types";
import { countdown, sessionWindow } from "@/lib/sessionWindow";
import { useNow } from "@/lib/useNow";

/**
 * What goes up on the projector: the code, how long is left, and a way in.
 *
 * Shared by the dialog on the attendance tab and the standalone tab at
 * /present/:sessionId, so the two cannot drift. The dialog is for a quick look
 * on the laptop; the tab is for dragging onto a second screen and leaving
 * there, which a dialog cannot do because it closes the moment you click the
 * dashboard behind it.
 *
 * THE QR POINTS AT THE SITE, NOT AT THE CODE
 *
 * The code being readable only in the room is the anti-sharing measure. A QR
 * that carried it would let one photograph check in everybody the photo was
 * sent to, which is exactly what reading it out loud avoids. So the QR saves
 * students typing the address, and they still have to be looking at the screen
 * to get the code.
 *
 * ALWAYS BLACK ON WHITE
 *
 * The QR sits on its own white square whatever the theme. Scanners expect dark
 * modules on a light ground; an inverted code on a dark-mode page is one that
 * a fair share of phone cameras simply refuse to read, and nobody finds that
 * out until a room of students are holding their phones up at it.
 */

const siteUrl = () => `${window.location.origin}/`;

/** The sentence that goes under the code, per phase of the window. */
const timerFor = (session: SessionRow, now: Date) => {
  const w = sessionWindow(session, now);
  switch (w.phase) {
    case "not_opened":
      return {
        tone: "muted" as const,
        big: w.msUntilChange === null ? "Opening" : countdown(w.msUntilChange),
        small: w.msUntilChange === null ? "check-in is opening" : "until check-in opens",
      };
    case "opens_soon":
      return {
        tone: "muted" as const,
        big: countdown(w.msUntilChange ?? 0),
        small: "until check-in opens",
      };
    case "live":
      return {
        tone: "live" as const,
        big: countdown(w.msUntilClose),
        small: "left to check in",
      };
    case "live_late":
      return {
        tone: "late" as const,
        big: countdown(w.msUntilClose),
        small: "left — marks now count as late",
      };
    case "expired":
      return { tone: "over" as const, big: "Closed", small: "check-in has ended" };
    case "done":
      return {
        tone: "over" as const,
        big: session.status === "cancelled" ? "Cancelled" : "Closed",
        small: "this session is not taking check-ins",
      };
  }
};

const TONE: Record<"muted" | "live" | "late" | "over", string> = {
  muted: "text-muted-foreground",
  live: "text-success",
  late: "text-warning",
  over: "text-destructive",
};

const PresentView = ({
  session,
  className,
  cohortLabel,
  size = "dialog",
}: {
  session: SessionRow;
  className: string;
  cohortLabel: string;
  /** "full" is the standalone tab, sized to be read from the back of a room. */
  size?: "dialog" | "full";
}) => {
  // Ticks every second: the figure is shown to the second.
  const now = useNow(true, 1000);
  const t = timerFor(session, now);
  const full = size === "full";
  const url = siteUrl();

  // The code is only meaningful while check-in could accept it. After the
  // window, showing it invites people to type something that will be refused.
  const showPin =
    Boolean(session.pin) &&
    (t.tone === "live" || t.tone === "late" || session.status === "open");

  return (
    <div
      className={`flex flex-col items-center gap-6 text-center ${
        full ? "lg:flex-row lg:items-center lg:justify-center lg:gap-16" : ""
      }`}
    >
      <div className="min-w-0 space-y-3">
        <p className={`${full ? "text-2xl sm:text-3xl" : "text-base"} font-semibold`}>
          {className}
          <span className="text-muted-foreground"> · Cohort {cohortLabel}</span>
        </p>

        {showPin ? (
          <p
            className={`rounded-xl bg-gradient-primary px-4 font-mono font-bold tracking-[0.25em] text-primary-foreground shadow-soft ${
              full
                ? "py-6 text-6xl sm:text-8xl lg:text-9xl"
                : "py-4 text-5xl sm:text-6xl"
            }`}
          >
            {session.pin}
          </p>
        ) : (
          <p
            className={`rounded-xl border-2 border-dashed px-4 text-muted-foreground ${
              full ? "py-10 text-3xl" : "py-6 text-xl"
            }`}
          >
            {session.status === "scheduled" ? "No code yet" : "No code to show"}
          </p>
        )}

        <div className={TONE[t.tone]}>
          <p
            className={`flex items-center justify-center gap-2 font-bold tabular-nums ${
              full ? "text-5xl sm:text-6xl" : "text-3xl"
            }`}
          >
            <Clock className={full ? "h-10 w-10" : "h-6 w-6"} />
            {t.big}
          </p>
          <p className={full ? "text-xl" : "text-sm"}>{t.small}</p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-2">
        <div className="rounded-xl bg-white p-3 shadow-soft">
          <QRCodeSVG
            value={url}
            size={full ? 260 : 160}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            marginSize={0}
          />
        </div>
        <p className={`${full ? "text-lg" : "text-xs"} text-muted-foreground`}>
          Scan to open check-in
        </p>
        <p className={`${full ? "text-base" : "text-xs"} break-all font-mono`}>
          {url}
        </p>
      </div>
    </div>
  );
};

export default PresentView;
