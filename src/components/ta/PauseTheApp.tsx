// The admin switch that pauses the whole app, now or later (055, 056).
//
// Deliberately blunt: one card, plain words, and a statement of exactly what
// stops. A control that can halt every class in the installation should not
// look like a preference.
//
// Scheduling is the ordinary case, not the advanced one. An immediate pause
// interrupts whoever is mid-register; a pause set for tonight gives the app a
// chance to warn people first, which is the whole reason 056 exists.

import { useEffect, useState } from "react";
import { CalendarClock, Loader2, Pause, Play } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  adminSetServicePaused,
  getServiceState,
  type ServiceState,
} from "@/lib/api/service";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/** "2026-09-23T21:00" for a datetime-local box, in the viewer's own clock. */
const forInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

const PauseTheApp = () => {
  const { toast } = useToast();
  const [state, setState] = useState<ServiceState | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    getServiceState()
      .then((s) => {
        setState(s);
        setFailed(false);
        setMessage(s.message ?? "");
        setStartAt(s.starts_at ? forInput(new Date(s.starts_at)) : "");
        setEndAt(s.ends_at ? forInput(new Date(s.ends_at)) : "");
      })
      .catch(() => setFailed(true));

  useEffect(() => {
    void load();
  }, []);

  const apply = async (paused: boolean, scheduled: boolean) => {
    setBusy(true);
    try {
      const next = await adminSetServicePaused(
        paused,
        message.trim() || undefined,
        paused && scheduled && startAt
          ? new Date(startAt).toISOString()
          : undefined,
        paused && endAt ? new Date(endAt).toISOString() : undefined,
      );
      setState(next);
      toast({
        title:
          next.state === "scheduled"
            ? `Pause scheduled for ${when(next.starts_at)}`
            : next.state === "paused"
              ? "The app is paused"
              : "The app is running again",
        description:
          next.state === "scheduled"
            ? "Nothing stops until then. Students and staff are warned as it approaches."
            : next.state === "paused"
              ? "Students see a notice instead of the check-in box, and nothing can be recorded."
              : "Check-in and every other change work as usual.",
      });
    } catch (e) {
      toast({
        title: "Could not change it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const status = state?.state ?? "running";
  const running = status === "running";

  return (
    <Card className={`border-2 ${running ? "" : "border-warning"}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {status === "paused" ? (
            <Pause className="h-4 w-4 text-warning" />
          ) : status === "scheduled" ? (
            <CalendarClock className="h-4 w-4 text-warning" />
          ) : (
            <Play className="h-4 w-4 text-success" />
          )}
          {status === "paused"
            ? "The app is paused"
            : status === "scheduled"
              ? `Pause scheduled for ${when(state?.starts_at ?? null)}`
              : "The app is running"}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {failed ? (
          <p className="text-sm text-muted-foreground">
            Could not check whether the app is paused.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {status === "paused" ? (
                <>
                  Nobody can check in, and no register, session or roster can be
                  changed — by anyone, in any class.
                  {state?.ends_at
                    ? ` People are told to expect it back by ${when(state.ends_at)}; it will not resume on its own.`
                    : " It will not resume on its own."}
                </>
              ) : status === "scheduled" ? (
                <>
                  Nothing is stopped yet. Students and staff see it coming, and
                  are warned again shortly before it starts.
                  {state?.ends_at
                    ? ` Expected back by ${when(state.ends_at)}.`
                    : ""}
                </>
              ) : (
                <>
                  Pausing stops check-ins and every change to attendance,
                  sessions and rosters, across every class. Schedule it if you
                  can: an immediate pause interrupts whoever is mid-register.
                </>
              )}
            </p>

            <div className="space-y-1">
              <Label htmlFor="pause-message">
                What students and staff are told
              </Label>
              <Input
                id="pause-message"
                value={message}
                placeholder="Back shortly — we're doing some maintenance"
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pause-start">Starts</Label>
                <Input
                  id="pause-start"
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pause-end">Expected back by</Label>
                <Input
                  id="pause-end"
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Only what people are told. Nothing resumes by itself.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !startAt}
                onClick={() => void apply(true, true)}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <CalendarClock className="mr-1 h-4 w-4" />
                )}
                {status === "scheduled" ? "Update the schedule" : "Schedule it"}
              </Button>

              {status === "running" || status === "scheduled" ? (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void apply(true, false)}
                >
                  <Pause className="mr-1 h-4 w-4" />
                  Pause now
                </Button>
              ) : null}

              {status !== "running" && (
                <Button disabled={busy} onClick={() => void apply(false, false)}>
                  <Play className="mr-1 h-4 w-4" />
                  {status === "scheduled" ? "Cancel the pause" : "Resume the app"}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default PauseTheApp;
