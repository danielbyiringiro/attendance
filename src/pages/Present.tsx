import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Loader2, Maximize } from "lucide-react";
import PresentView from "@/components/ta/PresentView";
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
 */

type State =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "not_approved" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PresentableSession };

const REFRESH_MS = 15_000;

const Present = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [sound, setSound] = useSoundPreference("attendance.sound.presenter");

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

    const id = setInterval(() => void load(false), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.kind, load]);

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
          <PresentView
            session={state.data.session}
            className={state.data.className}
            cohortLabel={state.data.cohortLabel}
            size="full"
          />
        </div>
      );
  }
};

export default Present;
