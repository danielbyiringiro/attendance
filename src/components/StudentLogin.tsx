import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Logo from "@/components/Logo";

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
 */
const StudentLogin = ({ openCount, onMarkAttendance }: StudentLoginProps) => {
  const [studentId, setStudentId] = useState("");
  const [pin, setPin] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [marked, setMarked] = useState<MarkResult | null>(null);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

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

    setIsSubmitting(true);
    try {
      // The PIN is verified server-side; we never compare it in the browser.
      const result = await onMarkAttendance(studentId, pin);

      if (!result.success) {
        toast({
          title: "Attendance not recorded",
          description: result.error || "Something went wrong. Please try again.",
          variant: "destructive",
        });
        return;
      }

      setMarked(result);
      setStudentId("");
      setPin("");
    } finally {
      setIsSubmitting(false);
    }
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
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">PIN</label>
                <Input
                  type="password"
                  placeholder="Enter the PIN provided by your TA"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  disabled={isSubmitting}
                  className="h-12"
                />
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

            <p className="mt-4 text-center text-xs text-muted-foreground">
              The code decides which class you are marking, so you can use this
              page for any of your classes.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StudentLogin;
