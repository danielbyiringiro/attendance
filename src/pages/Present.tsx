import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Maximize, PictureInPicture2, X } from "lucide-react";
import PresentView from "@/components/ta/PresentView";
import AddCheckInTime from "@/components/ta/AddCheckInTime";
import SoundToggle from "@/components/SoundToggle";
import { supabase } from "@/lib/supabase";
import { ensureStaff } from "@/lib/api/staff";
import {
  getSessionForPresenting,
  type PresentableSession,
} from "@/lib/api/present";
import { useLiveClass } from "@/lib/useLiveClass";
import { useSoundPreference } from "@/lib/useSoundPreference";
import { playCheckInBeep } from "@/lib/checkInSound";
import { usePictureInPicture } from "@/lib/usePictureInPicture";
import { useNow } from "@/lib/useNow";
import { sessionWindow } from "@/lib/sessionWindow";

/**
 * The presenter tab: /present/:sessionId.
 *
 * Built to be dragged onto a projector and left alone for the length of a
 * class, which shapes most of what is here.
 *
 * It refreshes itself. Auto-open mints the PIN at the early-open moment and the
 * sweep closes the session when the window ends, both on the server, so a tab
 * that loaded once would keep showing a code that stopped working. It re-reads
 * every 15 seconds and whenever the tab becomes visible again, and straight away
 * when realtime says the session or a check-in changed; the countdown in
 * between is computed locally and ticks every second.
 *
 * It beeps for each student who checks in to this session, unless muted from
 * the button beside Full screen. The setting is remembered on this computer.
 *
 * It checks who you are, the same way the dashboard does. The PIN is only
 * readable by staff on the class — row-level security enforces that regardless
 * — but a signed-out visitor should be told to sign in rather than shown a page
 * that silently never loads. Same-origin tabs share the Supabase session, so a
 * TA who opened this from the dashboard is already signed in here.
 *
 * "Float over slides" moves the view into a small always-on-top window (see
 * usePictureInPicture), so a lecturer projecting slides can keep the code in a
 * corner and carry on teaching. This tab keeps doing the loading, polling and
 * beeping; the window is only where it is drawn. It closes itself a short while
 * after check-in ends, once it has been seen live, so it does not sit over the
 * rest of the lecture saying "Closed". Chrome and Edge only; elsewhere the
 * button is not shown.
 *
 * "Add time" (063) sits in the bottom corner while check-in is open, out of
 * the way of what the room reads. The code stays the same, so only the clock
 * moves — in this tab and in the floating window alike.
 */

type State =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "not_approved" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PresentableSession };

const REFRESH_MS = 15_000;
/** How long "Closed" stays up in the floating window before it goes. */
const PIP_LINGER_MS = 30_000;
const PIP_SIZE = { width: 440, height: 250 };

const Present = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [sound, setSound] = useSoundPreference("attendance.sound.presenter");
  const pip = usePictureInPicture();
  // With the window up, this tab is probably hidden behind the slides, where
  // the browser slows its timers. The window's own timers are not slowed, so
  // the clock and the poll run on those while it is open.
  const pipNow = useNow(pip.pipWindow !== null, 1000, pip.pipWindow);
  const timerHost = pip.pipWindow ?? window;

  const load = useCallback(
    async (first: boolean) => {
      if (!sessionId) {
        setState({ kind: "not_found" });
        return;
      }
      try {
        if (first) {
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            setState({ kind: "signed_out" });
            return;
          }
          const identity = await ensureStaff();
          if (identity.status !== "approved") {
            setState({ kind: "not_approved" });
            return;
          }
        }

        const found = await getSessionForPresenting(sessionId);
        setState(found ? { kind: "ready", data: found } : { kind: "not_found" });
      } catch (e) {
        // A refresh that fails mid-class should not blank the projector. Keep
        // what is on screen and try again on the next tick; only the first
        // load, which has nothing to fall back on, reports the error.
        if (first) {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : "Unexpected error.",
          });
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (state.kind !== "ready") return;

    const id = timerHost.setInterval(() => void load(false), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      timerHost.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.kind, load, timerHost]);

  // Close the floating window once check-in is over — but only after it has
  // shown a live code, so opening it on a finished session does not make it
  // vanish before anyone has read why there is nothing to show.
  const pipPhase =
    state.kind === "ready" && pip.pipWindow
      ? sessionWindow(state.data.session, pipNow).phase
      : null;
  const pipSawLive = useRef(false);
  useEffect(() => {
    if (pipPhase === null) {
      pipSawLive.current = false;
      return;
    }
    if (pipPhase === "live" || pipPhase === "live_late") {
      pipSawLive.current = true;
      return;
    }
    if (!pipSawLive.current) return;
    if (pipPhase !== "expired" && pipPhase !== "done") return;
    const id = window.setTimeout(pip.close, PIP_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [pipPhase, pip.close]);

  // Subscribed once the class is known. Polling stays with the effect above,
  // so `active` is left off here: this adds only the realtime half.
  useLiveClass(
    state.kind === "ready" ? state.data.session.class_id : null,
    () => load(false),
    {
      onCheckIn: (change) => {
        if (sound && change.new?.session_id === sessionId) playCheckInBeep();
      },
    },
  );

  const goFullscreen = () => {
    // Not every browser allows it, and a refusal is not worth an error.
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const floatOverSlides = (title: string) => {
    // Refused without a click behind it, or if the user dismisses it. Neither
    // needs an error: the button is still there to try again.
    void pip.open({ ...PIP_SIZE, title }).catch(() => undefined);
  };

  const message = (title: string, body: string) => (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md space-y-3 text-center">
        <p className="text-xl font-semibold">{title}</p>
        <p className="text-muted-foreground">{body}</p>
        <Button asChild variant="outline">
          <Link to="/">Go to the dashboard</Link>
        </Button>
      </div>
    </div>
  );

  switch (state.kind) {
    case "loading":
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    case "signed_out":
      return message(
        "Sign in first",
        "This screen shows a live check-in code, so it is only for staff. Sign in on the dashboard, then open it again from the attendance tab.",
      );
    case "not_approved":
      return message(
        "Your account is waiting for approval",
        "An admin has to approve it before it can show check-in codes.",
      );
    case "not_found":
      return message(
        "Nothing to show",
        "Either this session does not exist, or it belongs to a class you are not on.",
      );
    case "error":
      return message("Could not load the session", state.message);
    case "ready":
      return (
        <div className="relative flex min-h-screen items-center justify-center bg-background p-6 sm:p-10">
          <div className="absolute right-3 top-3 flex gap-1">
            <SoundToggle
              enabled={sound}
              onChange={setSound}
              className="text-muted-foreground"
            />
            {pip.supported && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() =>
                  pip.pipWindow
                    ? pip.close()
                    : floatOverSlides(`Check-in · ${state.data.className}`)
                }
              >
                <PictureInPicture2 className="mr-1 h-4 w-4" />
                {pip.pipWindow ? "Back to this tab" : "Float over slides"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={goFullscreen}
            >
              <Maximize className="mr-1 h-4 w-4" />
              Full screen
            </Button>
          </div>
          {pip.pipWindow ? (
            <div className="max-w-md space-y-3 text-center">
              <p className="text-xl font-semibold">Showing in a floating window</p>
              <p className="text-muted-foreground">
                It stays on top of your slides. Drag it anywhere, or close it to
                bring the code back here. It closes itself 30 seconds after
                check-in ends.
              </p>
            </div>
          ) : (
            <PresentView
              session={state.data.session}
              className={state.data.className}
              cohortLabel={state.data.cohortLabel}
              size="full"
              timeZone={state.data.timeZone}
            />
          )}
          <AddCheckInTime
            session={state.data.session}
            onChanged={() => load(false)}
            className="absolute bottom-3 right-3"
            buttonClassName=""
          />
          {pip.pipWindow &&
            createPortal(
              <div className="relative h-screen">
                {/* The browser's own "back to tab" control is turned off (it
                    would pull this tab over the slides), so the way out is
                    here. Small and in the corner: it is for the lecturer,
                    not the room. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1 z-10 h-7 px-2 text-xs text-muted-foreground"
                  onClick={pip.close}
                  title="Close the floating window and show the code in the tab again"
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Exit
                </Button>
                <PresentView
                  session={state.data.session}
                  className={state.data.className}
                  cohortLabel={state.data.cohortLabel}
                  size="widget"
                  now={pipNow}
                  timeZone={state.data.timeZone}
                />
              </div>,
              pip.pipWindow.document.body,
            )}
        </div>
      );
  }
};

export default Present;
