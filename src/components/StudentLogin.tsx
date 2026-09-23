import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Clock, History, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Logo from "@/components/Logo";
import SoundToggle from "@/components/SoundToggle";
import { pinFromSearch, searchWithoutPin } from "@/lib/checkinLink";
import { playCheckInBeep, primeSound } from "@/lib/checkInSound";
import { useSoundPreference } from "@/lib/useSoundPreference";

export interface MarkResult {
  success: boolean;
  error?: string;
  name?: string;
  /** Which class the PIN turned out to belong to. */
  class?: string;
  /** Its code — what a timetable calls the course. Added in migration 025. */
  class_code?: string;
  cohort?: string;
  state?: string;
}

interface StudentLoginProps {
  /**
   * Opens this student's own attendance history.
   *
   * It has a button in the corner of the page as well, which is the only one
   * left when a pause replaces this card — but a corner button on a screen
   * whose whole job is one form is easy to never look at. This one sits under
   * the thing they came to do.
   */
  onShowHistory?: () => void;
  /**
   * How many check-in windows are open anywhere, for the status line only.
   * It is never a gate: with several classes running, "a window is open" is
   * not a fact about any particular student.
   */
  openCount: number;
  onMarkAttendance: (studentId: string, pin: string) => Promise<MarkResult>;
}

/**
 * The student check-in page.
 *
 * The form is never disabled. It used to be locked whenever the one shared
 * timer had run out, which was built when the installation had a single class
 * and one PIN. With several classes that lock is wrong in both directions: a
 * student whose own class is open cannot type while every other class is
 * closed, and a student whose class is NOT open gets a form that looks ready
 * and a countdown belonging to somebody else's room.
 *
 * mark_attendance already resolves which session a PIN belongs to, whether its
 * window is open, and whether the student is enrolled in that cohort — and
 * refuses with one message that distinguishes none of them, so the endpoint
 * cannot be used to find out who is enrolled in what. That makes the server
 * the only thing that can answer the question, so the browser stops guessing.
 *
 * ARRIVING FROM THE QR
 *
 * A scan opens a dialog that asks for the student ID and nothing else, with the
 * scanned code shown above it. Filling the code into the form alone was not
 * enough: the PIN box is a password field, so the code arrived as dots nobody
 * typed, below an empty ID box, and a working scan was hard to tell from a
 * broken one. The dialog makes the outcome of the scan the first thing seen.
 *
 * The presenter only puts a code in the QR while check-in is live, so a scan
 * that carries one was an active code when it was scanned. Nothing is sent
 * until the student enters their ID and presses the button.
 *
 * THE BEEP
 *
 * The phone beeps when a check-in is accepted, so a student in a noisy room
 * knows it worked without reading the screen. Muted from the toggle under the
 * form, and remembered on the phone. The submit tap is what browsers require
 * before a page may make sound, so it is primed there, before the request.
 */
const StudentLogin = ({
  openCount,
  onMarkAttendance,
  onShowHistory,
}: StudentLoginProps) => {
  const [studentId, setStudentId] = useState("");
  /*
   * The code from the address when the student arrived by scanning the QR on
   * the projector.
   *
   * Read once, at first render. The address is tidied straight afterwards, so
   * a later render or a refresh does not see it again. Kept apart from `pin`
   * because the dialog submits what was scanned, whatever happens to the form
   * behind it.
   */
  const [scanned] = useState(() => pinFromSearch(window.location.search));
  const [pin, setPin] = useState(scanned ?? "");
  const [pinFromQr, setPinFromQr] = useState(scanned !== null);
  const [scanOpen, setScanOpen] = useState(scanned !== null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [sound, setSound] = useSoundPreference("attendance.sound.checkin");

  /*
   * Take the code out of the address bar once it has been read.
   *
   * Left there, it survives a refresh and sits in browser history, so a
   * student coming back to the tab after class gets a code filled in that
   * stopped working an hour ago — and the refusal they then get looks like
   * their ID is wrong. replaceState, not a navigation: nothing reloads, and
   * the back button does not return to the version with the code in it.
   */
  useEffect(() => {
    if (pinFromSearch(window.location.search) === null) return;
    const { pathname, hash } = window.location;
    window.history.replaceState(
      window.history.state,
      "",
      pathname + searchWithoutPin(window.location.search) + hash,
    );
  }, []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [marked, setMarked] = useState<MarkResult | null>(null);
  const { toast } = useToast();

  /*
   * One path for both ways in, so the dialog and the form cannot disagree
   * about what a success clears or what is shown afterwards.
   */
  const submit = async (id: string, code: string): Promise<MarkResult> => {
    setIsSubmitting(true);
    try {
      // The PIN is verified server-side; we never compare it in the browser.
      const result = await onMarkAttendance(id, code);
      if (result.success) {
        if (sound) playCheckInBeep();
        setMarked(result);
        setStudentId("");
        setPin("");
        setPinFromQr(false);
      }
      return result;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Inside the tap, before the request: after the await it no longer counts.
    if (sound) primeSound();

    if (!studentId.trim()) {
      toast({
        title: "Student ID Required",
        description: "Please enter your student ID.",
        variant: "destructive",
      });
      return;
    }

    if (!pin.trim()) {
      toast({
        title: "PIN Required",
        description: "Please enter the PIN provided by your TA.",
        variant: "destructive",
      });
      return;
    }

    const result = await submit(studentId, pin);
    if (!result.success) {
      toast({
        title: "Attendance not recorded",
        description: result.error || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleScanSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sound) primeSound();
    if (!scanned) return;

    if (!studentId.trim()) {
      setScanError("Enter your student ID.");
      return;
    }

    setScanError(null);
    const result = await submit(studentId, scanned);
    if (result.success) {
      // The confirmation card on the page behind says which class it was.
      setScanOpen(false);
      return;
    }
    // Said inside the dialog, where the student is looking, rather than in a
    // toast that can land behind it. The ID stays so a retry is one tap.
    setScanError(result.error || "Something went wrong. Please try again.");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="mb-4 flex items-center justify-center">
            <Logo className="h-16 w-16 shadow-soft" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">
            Attendance Check-In
          </h1>
          <p className="text-muted-foreground">
            Enter your Student ID and PIN to mark attendance
          </p>
        </div>

        {/* A hint, not a gate. It says whether ANY window is open, because
            that is all a logged-out visitor is told — no class names, no
            cohorts. Your own class may be open when this says one window is,
            or may not; only the PIN can settle it. */}
        <Card
          className={`border-2 shadow-soft transition-colors ${
            openCount > 0
              ? "border-success/40 bg-success/5"
              : "border-border bg-card"
          }`}
        >
          <CardContent className="flex items-center justify-center gap-3 py-4">
            <Clock
              className={`h-5 w-5 ${openCount > 0 ? "text-success" : "text-muted-foreground"}`}
            />
            <p className="text-sm text-muted-foreground">
              {openCount === 0
                ? "No check-in is open right now. If your TA has just read out a code, enter it anyway."
                : `${openCount} check-in ${openCount === 1 ? "window is" : "windows are"} open. Enter the code your TA read out.`}
            </p>
          </CardContent>
        </Card>

        {/*
          Which class this was, said properly.

          The class was already named here, in the same grey small print as the
          student's own name — so the one fact somebody wants confirmed before
          walking out of a room was the least prominent thing on the card. A
          student with back-to-back lectures reads the code, which is what a
          timetable calls the course, so that leads.

          Nothing above the PIN box can say this: naming the open classes to
          anyone who loads the page would announce which of the institution's
          classes are meeting, and resolving it from a student ID would make
          this box an enrolment oracle. See migration 025.
        */}
        {marked && (
          <Card className="border-2 border-success/40 bg-success/5 shadow-medium">
            <CardContent className="space-y-2 py-4 text-center">
              <CheckCircle2 className="mx-auto h-6 w-6 text-success" />

              <p className="text-sm font-medium">
                {marked.state === "late" ? "Marked late" : "You are marked present"}
              </p>

              <div className="space-y-0.5">
                {marked.class_code && (
                  <p className="text-2xl font-bold leading-tight tracking-tight">
                    {marked.class_code}
                  </p>
                )}
                {marked.class && (
                  <p
                    className={
                      marked.class_code
                        ? "text-sm text-muted-foreground"
                        : "text-xl font-bold leading-tight"
                    }
                  >
                    {marked.class}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {marked.cohort && (
                  <Badge variant="outline">Cohort {marked.cohort}</Badge>
                )}
                {marked.state === "late" && (
                  <Badge variant="secondary">after the late cut-off</Badge>
                )}
              </div>

              {marked.name && (
                <p className="text-xs text-muted-foreground">{marked.name}</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Login Form */}
        <Card className="border-2 shadow-medium">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-accent" />
              Mark Your Attendance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Student ID</label>
                <Input
                  type="text"
                  placeholder="Enter your student ID"
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  disabled={isSubmitting}
                  className="h-12"
                  // Straight to the only thing left to type — including after
                  // the scan dialog is dismissed, which hands focus back here.
                  autoFocus={pinFromQr}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">PIN</label>
                <Input
                  type="password"
                  placeholder="Enter the PIN provided by your TA"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value);
                    setPinFromQr(false);
                  }}
                  disabled={isSubmitting}
                  className="h-12"
                />
                {/*
                  Said, because the field is a password box: a student who
                  scanned sees dots they did not type, and without this reads
                  it as somebody else's leftover input.
                */}
                {pinFromQr && pin && (
                  <p className="text-xs text-muted-foreground">
                    Filled in from the QR code. If it is refused, the code on
                    the screen may have changed — scan it again.
                  </p>
                )}
              </div>

              <Button
                type="submit"
                className="h-12 w-full bg-gradient-to-r from-primary to-accent transition-all duration-300 hover:opacity-90"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking…
                  </>
                ) : (
                  "Mark Attendance"
                )}
              </Button>
            </form>

            {onShowHistory && (
              <Button
                type="button"
                variant="outline"
                className="mt-4 h-11 w-full"
                onClick={onShowHistory}
              >
                <History className="mr-2 h-4 w-4" />
                See my attendance history
              </Button>
            )}

            <p className="mt-4 text-center text-xs text-muted-foreground">
              The code decides which class you are marking, so you can use this
              page for any of your classes.
            </p>

            <div className="mt-2 flex justify-center">
              <SoundToggle
                enabled={sound}
                onChange={setSound}
                label={sound ? "Beep when marked: on" : "Beep when marked: off"}
                className="text-xs text-muted-foreground"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/*
        Dismissing it is not a dead end: the scanned code is already in the form
        behind, so "type it myself" and a tap outside both land somewhere that
        works. It cannot be dismissed mid-request, which would hide the answer.
      */}
      <Dialog
        open={scanOpen}
        onOpenChange={(open) => {
          if (!isSubmitting) setScanOpen(open);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Check in</DialogTitle>
            <DialogDescription>
              You scanned the code on the screen. Enter your student ID to
              finish.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleScanSubmit} className="space-y-4">
            {/* Shown in full, unlike the password box: it is already on the
                projector, and a student refused can compare the two. */}
            <div className="rounded-md bg-muted px-3 py-2 text-center">
              <p className="text-xs text-muted-foreground">Code from the QR</p>
              <p className="font-mono text-2xl font-bold tracking-[0.25em]">
                {scanned}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="scan-student-id">Student ID</Label>
              <Input
                id="scan-student-id"
                type="text"
                placeholder="Enter your student ID"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                disabled={isSubmitting}
                className="h-12"
                autoFocus
              />
            </div>

            {scanError && (
              <div role="alert" className="space-y-1 text-sm">
                <p className="font-medium text-destructive">{scanError}</p>
                <p className="text-xs text-muted-foreground">
                  If the code on the screen has changed since you scanned, scan
                  it again.
                </p>
              </div>
            )}

            <Button
              type="submit"
              className="h-12 w-full bg-gradient-to-r from-primary to-accent transition-all duration-300 hover:opacity-90"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking…
                </>
              ) : (
                "Mark Attendance"
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              disabled={isSubmitting}
              onClick={() => setScanOpen(false)}
            >
              Type the code in myself instead
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StudentLogin;
