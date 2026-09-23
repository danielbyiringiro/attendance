// The admin switch that pauses the whole app (055).
//
// Deliberately blunt: one switch, one sentence, and a plain statement of what
// stops. A control that can shut down every class in the installation should
// not look like a preference.

import { useEffect, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
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

const PauseTheApp = () => {
  const { toast } = useToast();
  const [state, setState] = useState<ServiceState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getServiceState()
      .then((s) => {
        if (!live) return;
        setState(s);
        setMessage(s.message ?? "");
      })
      .catch(() => {
        // An admin who cannot read the switch should not see a card claiming
        // the app is running. Left null, it says it could not check.
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const set = async (paused: boolean) => {
    setBusy(true);
    try {
      const next = await adminSetServicePaused(paused, message.trim() || undefined);
      setState(next);
      setMessage(next.message ?? "");
      toast({
        title: paused ? "The app is paused" : "The app is running again",
        description: paused
          ? "Students see a notice instead of the check-in box, and nothing can be recorded until you resume."
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

  const paused = state?.paused ?? false;

  return (
    <Card className={`border-2 ${paused ? "border-warning" : ""}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {paused ? (
            <Pause className="h-4 w-4 text-warning" />
          ) : (
            <Play className="h-4 w-4 text-success" />
          )}
          {paused ? "The app is paused" : "The app is running"}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {state === null ? (
          <p className="text-sm text-muted-foreground">
            Could not check whether the app is paused.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {paused ? (
                <>
                  Nobody can check in, and no register, session or roster can be
                  changed — by anyone, in any class. Paused {when(state.since)}.
                </>
              ) : (
                <>
                  Pausing stops check-ins and every change to attendance,
                  sessions and rosters, across every class, until you resume.
                  For maintenance, or while data is being copied.
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
              <p className="text-xs text-muted-foreground">
                Optional. Without one they see a plain "attendance is paused"
                notice.
              </p>
            </div>

            <Button
              variant={paused ? "default" : "destructive"}
              disabled={busy}
              onClick={() => void set(!paused)}
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : paused ? (
                <Play className="mr-1 h-4 w-4" />
              ) : (
                <Pause className="mr-1 h-4 w-4" />
              )}
              {paused ? "Resume the app" : "Pause the app"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default PauseTheApp;
