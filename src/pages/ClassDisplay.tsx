import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Lock,
  Maximize,
  Monitor,
  PictureInPicture2,
  X,
} from "lucide-react";
import PresentView from "@/components/ta/PresentView";
import SoundToggle from "@/components/SoundToggle";
import { getClassDisplay, type ClassDisplayResult } from "@/lib/api/display";
import {
  DISPLAY_CODE_LENGTH,
  normalizeDisplayCode,
  pickDisplay,
} from "@/lib/classDisplay";
import {
  checkInCounts,
  newCheckIns,
  playCheckInBeep,
  primeSound,
} from "@/lib/checkInSound";
import { useNow } from "@/lib/useNow";
import { useSoundPreference } from "@/lib/useSoundPreference";
import { usePictureInPicture } from "@/lib/usePictureInPicture";

/**
 * The class display: /display/:token.
 *
 * The presenter view for a screen nobody is signed in to — a room PC, a TV, a
 * tablet by the door. The link names the class; the access code, typed here,
 * is what lets it show anything. See migration 041.
 *
 * Built to be left up all day. It re-reads every 15 seconds and whenever the
 * tab becomes visible, every 5 while a session is taking check-ins, and chooses
 * what to show from what comes back: every session running now, otherwise a
 * countdown to the next one today, otherwise when the class next meets. Nobody
 * has to touch it between classes.
 *
 * It beeps when students check in (migration 044). With no realtime for a
 * signed-out screen, it compares each session's check-in count with the last
 * read and beeps for the difference — so a beep can trail the scan by a few
 * seconds, and a screen switched on mid-class does not beep for everyone who
 * arrived before it. Muted from the button beside Full screen, remembered here.
 *
 * The code is remembered on this device, so a reload or a power cut does not
 * need somebody to come and type it again. "Lock screen" forgets it. When the
 * TA issues a new code or turns the link off, the next refresh is refused, the
 * remembered code is dropped, and the screen goes back to asking — so the live
 * PIN is off the screen within about 15 seconds.
 *
 * "Float over slides" works as it does on the presenter tab (see Present and
 * usePictureInPicture): the view moves into a small always-on-top window while
 * this tab keeps polling and beeping. The window shows whatever this screen
 * would — every running session stacked, otherwise the next one or "no
 * check-in" — and closes itself a short while after check-in ends, once it has
 * shown one live. Locking the screen closes it too. Chrome and Edge only.
 */

type Ready = Extract<ClassDisplayResult, { ok: true }>;

type State =
  | { kind: "checking" }
  | { kind: "code"; message: string | null }
  | { kind: "locked" }
  | { kind: "ready"; data: Ready };

/** How a check was started, which decides what a failure should say. */
type Source = "typed" | "stored" | "poll";

const REFRESH_MS = 15_000;
/** While check-in is running, so a beep follows a scan closely. */
const LIVE_REFRESH_MS = 5_000;
/** How long the floating window stays up after check-in ends. */
const PIP_LINGER_MS = 30_000;
/** One session's strip; two cohorts at once get one each, stacked. */
const PIP_WIDTH = 440;
const PIP_ROW_HEIGHT = 250;

const storageKey = (token: string) => `class-display-code:${token}`;

// Storage can be missing or throw (private windows, blocked site data). The
// screen still works without it; it just asks again after a reload.
const readStoredCode = (token: string): string | null => {
  try {
    return localStorage.getItem(storageKey(token));
  } catch {
    return null;
  }
};

const storeCode = (token: string, code: string | null) => {
  try {
    if (code) localStorage.setItem(storageKey(token), code);
    else localStorage.removeItem(storageKey(token));
  } catch {
    // Not remembered; nothing else depends on it.
  }
};

/** An instant as the class's own wall clock, not the screen's. */
const whenIn = (iso: string, timezone: string) =>
  new Date(iso).toLocaleString(undefined, {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const ClassDisplay = () => {
  const { token = "" } = useParams<{ token: string }>();
  const [stored] = useState(() => readStoredCode(token));
  const [code, setCode] = useState<string | null>(stored);
  const [typed, setTyped] = useState(stored ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [state, setState] = useState<State>(
    stored ? { kind: "checking" } : { kind: "code", message: null },
  );
  const [sound, setSound] = useSoundPreference("attendance.sound.presenter");
  const pip = usePictureInPicture();
  // With the window up this tab is probably behind the slides, where the
  // browser slows its timers; the window's own are not slowed, so the clock
  // and the poll run on those while it is open.
  const timerHost = pip.pipWindow ?? window;
  // Re-evaluates which session to show as the clock moves between refreshes.
  const now = useNow(state.kind === "ready", 1000, pip.pipWindow);

  // Read inside `check`, which is memoised on the token alone: the beep has to
  // follow the toggle without rebuilding the polling loop.
  const soundRef = useRef(sound);
  soundRef.current = sound;
  /** Each session's check-in count at the last successful read. */
  const countsRef = useRef<Map<string, number> | null>(null);

  const check = useCallback(
    async (candidate: string, source: Source) => {
      try {
        const r = await getClassDisplay(token, candidate);

        if (r.ok) {
          const arrived = newCheckIns(countsRef.current, r.sessions);
          countsRef.current = checkInCounts(r.sessions);
          if (arrived > 0 && soundRef.current) playCheckInBeep(arrived);

          storeCode(token, candidate);
          setCode(candidate);
          setState({ kind: "ready", data: r });
          return;
        }

        // Refused: forget the code, so a reload cannot put it back.
        storeCode(token, null);
        setCode(null);
        countsRef.current = null;

        if (r.reason === "locked") {
          setState({ kind: "locked" });
          return;
        }

        setState({
          kind: "code",
          message:
            source === "typed"
              ? "That code did not work. Check it with your TA."
              : "This screen was signed out: the access code was changed or the link was turned off. Enter the current code.",
        });
      } catch {
        // A refresh that fails mid-class keeps what is on screen; the next
        // one tries again. Only a check with nothing on screen reports it.
        if (source !== "poll") {
          setState({
            kind: "code",
            message:
              "Could not reach the server. Check the connection and try again.",
          });
        }
      }
    },
    [token],
  );

  useEffect(() => {
    if (stored) void check(stored, "stored");
  }, [stored, check]);

  const checkingInNow =
    state.kind === "ready" &&
    pickDisplay(state.data.sessions, now).kind === "active";

  useEffect(() => {
    if (state.kind !== "ready" || !code) return;

    const id = timerHost.setInterval(
      () => void check(code, "poll"),
      checkingInNow ? LIVE_REFRESH_MS : REFRESH_MS,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(code, "poll");
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      timerHost.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.kind, code, check, checkingInNow, timerHost]);

  // Nothing to float once the screen stops showing a class (locked, or signed
  // out by a new code): the PIN must not outlive the page's own view of it.
  const { close: closePip } = pip;
  useEffect(() => {
    if (state.kind !== "ready") closePip();
  }, [state.kind, closePip]);

  // Close the floating window once check-in is over — but only after it has
  // shown a live code, so floating it between classes does not make it vanish.
  const pipActive =
    state.kind === "ready" && pip.pipWindow ? checkingInNow : null;
  const pipSawLive = useRef(false);
  useEffect(() => {
    if (pipActive === null) {
      pipSawLive.current = false;
      return;
    }
    if (pipActive) {
      pipSawLive.current = true;
      return;
    }
    if (!pipSawLive.current) return;
    const id = window.setTimeout(closePip, PIP_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [pipActive, closePip]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Typing the code is the tap that lets this screen make sound later.
    if (sound) primeSound();
    const candidate = normalizeDisplayCode(typed);

    // Checked here so a typo of the wrong length does not count as one of the
    // ten wrong codes that lock the link.
    if (candidate.length !== DISPLAY_CODE_LENGTH) {
      setState({
        kind: "code",
        message: `The access code is ${DISPLAY_CODE_LENGTH} letters and numbers.`,
      });
      return;
    }

    setSubmitting(true);
    try {
      await check(candidate, "typed");
    } finally {
      setSubmitting(false);
    }
  };

  const lockScreen = () => {
    storeCode(token, null);
    setCode(null);
    setTyped("");
    countsRef.current = null;
    setState({ kind: "code", message: null });
  };

  const goFullscreen = () => {
    // Not every browser allows it, and a refusal is not worth an error.
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const floatOverSlides = (title: string, rows: number) => {
    // Refused without a click behind it, or if the user dismisses it. Neither
    // needs an error: the button is still there to try again.
    void pip
      .open({ width: PIP_WIDTH, height: PIP_ROW_HEIGHT * rows, title })
      .catch(() => undefined);
  };

  switch (state.kind) {
    case "checking":
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );

    case "locked":
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="max-w-md space-y-3 text-center">
            <Lock className="mx-auto h-8 w-8 text-destructive" />
            <p className="text-xl font-semibold">This display link is locked</p>
            <p className="text-muted-foreground">
              Too many wrong codes were entered. Ask your TA to issue a new
              access code, then enter it here.
            </p>
            <Button
              variant="outline"
              onClick={() => setState({ kind: "code", message: null })}
            >
              Enter the new code
            </Button>
          </div>
        </div>
      );

    case "code":
      return (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-6">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-sm space-y-4 rounded-xl border-2 bg-card p-6 shadow-medium"
          >
            <div className="space-y-1 text-center">
              <Monitor className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="text-xl font-semibold">Class display</p>
              <p className="text-sm text-muted-foreground">
                Enter the access code from your TA to show this class&apos;s
                check-in code on this screen.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="display-code">Access code</Label>
              <Input
                id="display-code"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={submitting}
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={16}
                className="h-12 text-center font-mono text-2xl uppercase tracking-[0.25em]"
              />
            </div>

            {state.message && (
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
            )}

            <Button type="submit" className="h-12 w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Show
            </Button>
          </form>
        </div>
      );

    case "ready": {
      const { data } = state;
      const pick = pickDisplay(data.sessions, now);

      return (
        <div className="relative flex min-h-screen items-center justify-center bg-background p-6 pt-14 sm:p-10 sm:pt-14">
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
                    : floatOverSlides(
                        `Check-in · ${data.class_name}`,
                        pick.kind === "active" ? pick.sessions.length : 1,
                      )
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
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={lockScreen}
            >
              <Lock className="mr-1 h-4 w-4" />
              Lock screen
            </Button>
          </div>

          {pip.pipWindow && (
            <div className="max-w-md space-y-3 text-center">
              <p className="text-xl font-semibold">Showing in a floating window</p>
              <p className="text-muted-foreground">
                It stays on top of your slides. Drag it anywhere, or close it to
                bring the code back here. It closes itself 30 seconds after
                check-in ends.
              </p>
            </div>
          )}

          {!pip.pipWindow && pick.kind === "active" && pick.sessions.length === 1 && (
            <PresentView
              session={pick.sessions[0]}
              className={data.class_name}
              cohortLabel={pick.sessions[0].cohort_label}
              size="full"
              timeZone={data.timezone}
            />
          )}

          {/* Two cohorts checking in at once: both codes, side by side where
              there is room. Hiding one would strand that room. */}
          {!pip.pipWindow && pick.kind === "active" && pick.sessions.length > 1 && (
            <div className="grid w-full gap-10 lg:grid-cols-2">
              {pick.sessions.map((s) => (
                <PresentView
                  key={s.id}
                  session={s}
                  className={data.class_name}
                  cohortLabel={s.cohort_label}
                  timeZone={data.timezone}
                />
              ))}
            </div>
          )}

          {!pip.pipWindow && pick.kind === "upcoming" && (
            <PresentView
              session={pick.session}
              className={data.class_name}
              cohortLabel={pick.session.cohort_label}
              size="full"
              timeZone={data.timezone}
            />
          )}

          {!pip.pipWindow && pick.kind === "idle" && (
            <div className="max-w-xl space-y-3 text-center">
              <p className="text-2xl font-semibold sm:text-3xl">
                {data.class_name}
              </p>
              <p className="text-4xl font-bold text-muted-foreground sm:text-5xl">
                No check-in right now
              </p>
              <p className="text-lg text-muted-foreground sm:text-xl">
                {data.next
                  ? `Next: Cohort ${data.next.cohort_label}, ${whenIn(data.next.starts_at, data.timezone)}`
                  : "Nothing else is scheduled."}
              </p>
            </div>
          )}

          {pip.pipWindow &&
            createPortal(
              <div className="relative flex h-screen flex-col divide-y">
                {/* The browser's own "back to tab" control is turned off, so
                    the way out is here, small and in the corner. */}
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
                {(pick.kind === "active"
                  ? pick.sessions
                  : pick.kind === "upcoming"
                    ? [pick.session]
                    : []
                ).map((s) => (
                  <div key={s.id} className="min-h-0 flex-1">
                    <PresentView
                      session={s}
                      className={data.class_name}
                      cohortLabel={s.cohort_label}
                      size="widget"
                      now={now}
                      timeZone={data.timezone}
                    />
                  </div>
                ))}
                {pick.kind === "idle" && (
                  <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
                    <p className="text-sm font-semibold">{data.class_name}</p>
                    <p className="text-2xl font-bold text-muted-foreground">
                      No check-in right now
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {data.next
                        ? `Next: Cohort ${data.next.cohort_label}, ${whenIn(data.next.starts_at, data.timezone)}`
                        : "Nothing else is scheduled."}
                    </p>
                  </div>
                )}
              </div>,
              pip.pipWindow.document.body,
            )}
        </div>
      );
    }
  }
};

export default ClassDisplay;
