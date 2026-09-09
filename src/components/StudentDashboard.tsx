import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  History,
  ArrowLeft,
  UserCheck,
  UserX,
  CalendarDays,
  CalendarCheck,
  Flag,
  CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  tallyStates,
  type AttendanceTally,
} from "@/lib/api/attendance";
import type { AttendanceState } from "@/lib/api/types";
import { format, parseISO } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import ThemeToggle from "@/components/ThemeToggle";
import AccessibilitySettings from "@/components/AccessibilitySettings";

interface AttendanceRecord {
  /** The session this row is about — what a flag is filed against. */
  sessionId: string;
  date: string;
  status: string;
  /** A student can be in more than one class, so a date alone is ambiguous. */
  className: string;
  cohort: string;
  wasCancelled: boolean;
  timestamp?: string;
  isFlagged?: boolean;
  flagStatus?: "flagged" | "accepted" | "denied" | null;
}

/** One class the student is in, with its own record and its own rate. */
interface ClassHistory {
  classCode: string;
  className: string;
  cohort: string;
  /** The percentage this class requires. */
  threshold: number;
  records: AttendanceRecord[];
  tally: AttendanceTally;
}

interface StudentDashboardProps {
  onBack: () => void;
}

/** One session of one class, as get_student_attendance returns it. */
interface SessionRecord {
  session_id: string;
  date: string;
  class: string;
  class_code: string;
  cohort: string;
  status: "scheduled" | "open" | "closed" | "cancelled";
  state:
    | "present"
    | "late"
    | "excused"
    | "unexcused"
    | "pending"
    | "exempted"
    | null;
  marked_at: string | null;
  /** What this class requires, so the screen does not have to assume. */
  min_attendance: number | null;
}

// This file used to carry its own SEMESTER_START (May 26 2026) and a third copy
// of the Tue/Wed/Thu isValidClassDay rule, and walked the term day by day to
// work out which days the student had missed. The exporter's semester start was
// May 18, so a student's own history and the CSV about them counted from
// different days. Both are gone: the server returns the sessions.

const StudentDashboard = ({ onBack }: StudentDashboardProps) => {
  const [studentId, setStudentId] = useState("");
  // Grouped by class. A single blended figure across every course describes
  // none of them: 90% in one and 40% in another reads as 65%, and the number
  // that actually matters — am I at risk in THIS class — is not shown at all.
  const [classes, setClasses] = useState<ClassHistory[]>([]);
  const [selectedClass, setSelectedClass] = useState<string>("all");
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [flaggingInProgress, setFlaggingInProgress] = useState<string | null>(
    null,
  );
  const { toast } = useToast();

  // Flag one session, named by its id.
  //
  // This passed a date, and the server resolved it with ORDER BY starts_at
  // LIMIT 1 across every class the student was in — so a student taking two
  // courses that both met that day had their dispute filed against whichever
  // started earlier. Every row on this screen already carries its session_id.
  const handleFlag = async (sessionId: string, date: string) => {
    if (flaggingInProgress === sessionId) return; // Prevent double submission

    setFlaggingInProgress(sessionId);

    try {
      // Flagging is handled server-side; the anon key cannot write to the table
      // directly. The RPC enforces the "already pending / denied" rules, and
      // refuses a session the student is not enrolled in.
      const { data, error } = await supabase.rpc("flag_attendance", {
        p_student_id: studentId,
        p_session_id: sessionId,
      });

      if (error) throw error;

      const result = (data ?? {}) as { success?: boolean; error?: string };

      if (!result.success) {
        if (result.error === "already_pending") {
          toast({
            title: "Already Flagged",
            description:
              "This record has already been flagged and is pending review.",
            variant: "default",
          });
        } else if (result.error === "already_present") {
          toast({
            title: "Already recorded",
            description:
              "You are marked as present for this session, so there is nothing to dispute.",
          });
        } else if (result.error === "not_an_absence") {
          toast({
            title: "Nothing to dispute",
            description:
              "Your TA excused you from this session, so it does not count against you.",
          });
        } else if (result.error === "not_your_session") {
          toast({
            title: "Not your session",
            description: "That session belongs to a class you are not enrolled in.",
            variant: "destructive",
          });
        } else if (result.error === "denied") {
          toast({
            title: "Cannot Flag",
            description:
              "This record has already been reviewed and denied. Please contact your TA if you believe this is an error.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Error",
            description: "Failed to flag record. Please try again.",
            variant: "destructive",
          });
        }
        return;
      }

      // Update local state
      setClasses((prev) =>
        prev.map((c) => ({
          ...c,
          records: c.records.map((record) =>
            record.sessionId === sessionId
              ? { ...record, isFlagged: true, flagStatus: "flagged" }
              : record,
          ),
        })),
      );

      toast({
        title: "Record Flagged",
        description:
          "This attendance record has been flagged for review. Your TA will review it shortly.",
      });
    } catch (error) {
      console.error("Error flagging record:", error);
      toast({
        title: "Error",
        description: "Failed to flag record. Please try again.",
        variant: "destructive",
      });
    } finally {
      setFlaggingInProgress(null);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!studentId.trim()) {
      toast({
        title: "Student ID Required",
        description: "Please enter your student ID to view history.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setHasSearched(true);

    try {
      // One server-side call returns just this student's data. The anon key has
      // no direct read access to these tables (RLS); everything goes through the
      // get_student_attendance RPC.
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "get_student_attendance",
        { p_student_id: studentId },
      );

      if (rpcError) {
        throw rpcError;
      }

      const payload = (rpcData ?? {}) as {
        sessions?: SessionRecord[];
        flagged?: Array<{
          session_date: string;
          session_id: string | null;
          status: string;
        }>;
      };
      const sessions = payload.sessions ?? [];

      if (sessions.length === 0) {
        setClasses([]);
        toast({
          title: "No Records Found",
          description: `No attendance records found for ID: ${studentId}`,
        });
        setIsLoading(false);
        return;
      }

      // Keyed by session, not date. A student in two classes has two rows on
      // the same date, and a dispute against one of them is not a dispute
      // against the other.
      const flaggedMap = new Map<string, "flagged" | "accepted" | "denied">();
      (payload.flagged ?? []).forEach((row) => {
        if (!row.session_id) return;
        flaggedMap.set(
          row.session_id,
          row.status as "flagged" | "accepted" | "denied",
        );
      });

      // Read off the stored state. There is no arithmetic left to get wrong:
      // "absent" is a row someone wrote, not the absence of one.
      const label: Record<string, string> = {
        present: "Present",
        late: "Late",
        excused: "Excused",
        unexcused: "Absent",
        exempted: "Exempt",
        pending: "Pending",
      };

      const toRecord = (sn: SessionRecord): AttendanceRecord => {
        const flagStatus = flaggedMap.get(sn.session_id) ?? null;
        const cancelled = sn.status === "cancelled";
        return {
          sessionId: sn.session_id,
          date: sn.date,
          className: sn.class,
          cohort: sn.cohort,
          wasCancelled: cancelled,
          status: cancelled ? "No class" : (label[sn.state ?? ""] ?? "No record"),
          timestamp: sn.marked_at ?? undefined,
          isFlagged: flagStatus === "flagged",
          flagStatus,
        };
      };

      // Grouped by class, each with its own rate. tallyStates is the same
      // function the TA dashboard and the exporter use, so a student sees the
      // number their TA sees rather than a second opinion.
      const byClass = new Map<string, SessionRecord[]>();
      sessions.forEach((sn) => {
        const list = byClass.get(sn.class_code);
        if (list) list.push(sn);
        else byClass.set(sn.class_code, [sn]);
      });

      const grouped: ClassHistory[] = [...byClass.entries()]
        .map(([classCode, own]) => {
          const records = own
            .map(toRecord)
            .sort((a, b) => b.date.localeCompare(a.date));

          return {
            classCode,
            className: own[0].class,
            cohort: own[0].cohort,
            threshold: own[0].min_attendance ?? 75,
            records,
            // Cancelled sessions are dropped: nobody attended a class that did
            // not run, and it must not count against them.
            tally: tallyStates(
              own
                .filter((sn) => sn.status !== "cancelled")
                .map((sn) => (sn.state as AttendanceState | null) ?? null),
            ),
          };
        })
        .sort((a, b) => a.className.localeCompare(b.className));

      setClasses(grouped);
      setSelectedClass(grouped.length === 1 ? grouped[0].classCode : "all");
    } catch (error) {
      console.error("Error fetching history:", error);
      toast({
        title: "Error",
        description: "Failed to fetch attendance history.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Helper function to get button state
  // The rows for whichever class is selected, newest first. With several
  // classes and no selection they interleave by date, which is why each row
  // still names its class.
  const shownRecords = classes
    .filter((c) => selectedClass === "all" || c.classCode === selectedClass)
    .flatMap((c) => c.records)
    .sort((a, b) => b.date.localeCompare(a.date));

  const getFlagButtonState = (record: AttendanceRecord) => {
    if (record.flagStatus === "accepted") {
      return {
        disabled: true,
        title: "Flag was accepted - attendance has been recorded",
        icon: <CheckCircle2 className="h-4 w-4 text-success" />,
        variant: "ghost" as const,
      };
    }
    if (record.flagStatus === "denied") {
      return {
        disabled: true,
        title: "Flag was denied - cannot flag again",
        icon: <Flag className="h-4 w-4 text-muted-foreground/50" />,
        variant: "ghost" as const,
      };
    }
    if (record.isFlagged) {
      return {
        disabled: true,
        title: "Flag pending review",
        icon: <Flag className="h-4 w-4 text-warning fill-warning" />,
        variant: "ghost" as const,
      };
    }
    return {
      disabled: false,
      title: "Flag as incorrect",
      icon: (
        <Flag className="h-4 w-4 text-muted-foreground hover:text-destructive" />
      ),
      variant: "ghost" as const,
    };
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="mb-4 flex items-center justify-between">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Check-in
          </Button>
          <AccessibilitySettings />
          <ThemeToggle />
        </div>

        <Card className="border-2 shadow-medium">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <History className="h-6 w-6 text-primary" />
              My Attendance History
            </CardTitle>
            <CardDescription>
              Enter your student ID to view your attendance statistics and
              history. If you see an error, you can flag it for review.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSearch} className="flex gap-4 mb-8">
              <Input
                type="text"
                placeholder="Enter Student ID"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="max-w-md h-12"
              />
              <Button type="submit" className="h-12" disabled={isLoading}>
                {isLoading ? (
                  "Searching..."
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    View Details
                  </>
                )}
              </Button>
            </form>

            {hasSearched && (
              <div className="space-y-6">
                {/* One card per class. A student is at risk in a particular
                    course, not on average across all of them. */}
                {classes.length === 0 ? (
                  <p className="py-8 text-center text-muted-foreground">
                    No attendance recorded yet.
                  </p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    {classes.map((c) => (
                      <Card
                        key={c.classCode}
                        className={`cursor-pointer border-2 bg-gradient-card shadow-soft transition-all ${
                          selectedClass === c.classCode
                            ? "border-primary shadow-medium"
                            : "border-border hover:border-primary/40"
                        }`}
                        onClick={() =>
                          setSelectedClass(
                            selectedClass === c.classCode ? "all" : c.classCode,
                          )
                        }
                      >
                        <CardContent className="space-y-3 p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-semibold">
                                {c.className}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {c.classCode} · Cohort {c.cohort}
                              </p>
                            </div>
                            <div className="text-right">
                              <p
                                className={`text-2xl font-bold ${
                                  c.tally.graded === 0
                                    ? "text-muted-foreground"
                                    : c.tally.rate >= c.threshold
                                      ? "text-success"
                                      : c.tally.rate >= c.threshold - 15
                                        ? "text-warning"
                                        : "text-destructive"
                                }`}
                              >
                                {c.tally.graded === 0 ? "—" : `${c.tally.rate}%`}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                of {c.threshold}% needed
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                            <span className="text-success">
                              {c.tally.present + c.tally.late} present
                              {c.tally.late > 0 && ` (${c.tally.late} late)`}
                            </span>
                            {c.tally.absent > 0 && (
                              <span className="text-destructive">
                                {c.tally.absent} absent
                              </span>
                            )}
                            {c.tally.excused > 0 && (
                              <span className="text-muted-foreground">
                                {c.tally.excused} excused
                              </span>
                            )}
                            {c.tally.pending > 0 && (
                              <span className="text-muted-foreground">
                                {c.tally.pending} not yet closed
                              </span>
                            )}
                          </div>

                          <p className="text-xs text-muted-foreground">
                            {selectedClass === c.classCode
                              ? "Showing this class below — click to show all."
                              : "Click to see only this class."}
                          </p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* History Table */}
                <div className="rounded-md border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Class</TableHead>
                        <TableHead>Time Recorded</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shownRecords.length > 0 ? (
                        shownRecords.map((record, index) => {
                          const buttonState = getFlagButtonState(record);

                          return (
                            <TableRow key={`${record.date}-${index}`}>
                              <TableCell className="font-medium">
                                {format(parseISO(record.date), "MMM d, yyyy")}
                              </TableCell>
                              <TableCell className="text-sm">
                                {record.className}
                                <span className="text-muted-foreground">
                                  {" "}
                                  · {record.cohort}
                                </span>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {record.timestamp
                                  ? format(new Date(record.timestamp), "h:mm a")
                                  : "-"}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                    record.status === "Present" ||
                                    record.status === "Late"
                                      ? "bg-success/15 text-success"
                                      : record.status === "Excused" ||
                                          record.status === "Exempt"
                                        ? "bg-primary/10 text-primary"
                                        : record.status === "Absent"
                                          ? "bg-destructive/10 text-destructive"
                                          : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  {record.status}
                                </span>
                                {record.flagStatus === "accepted" && (
                                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success/15 text-success">
                                    Flag Accepted
                                  </span>
                                )}
                                {record.flagStatus === "denied" && (
                                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                                    Flag Denied
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {/* Only an absence can be disputed. Migration
                                    017 enforces this server-side too — the RPC
                                    is granted to anon, so a hidden button is
                                    not a rule. */}
                                {record.status === "Present" ||
                                record.status === "Late" ? (
                                  <span className="text-xs text-muted-foreground">
                                    Recorded
                                  </span>
                                ) : record.status === "Excused" ? (
                                  <span className="text-xs text-muted-foreground">
                                    Excused by TA
                                  </span>
                                ) : record.status === "Exempt" ? (
                                  <span className="text-xs text-muted-foreground">
                                    Not required
                                  </span>
                                ) : record.wasCancelled ? (
                                  <span className="text-xs text-muted-foreground">
                                    Class cancelled
                                  </span>
                                ) : (
                                  <Button
                                    variant={buttonState.variant}
                                    size="sm"
                                    onClick={() =>
                                      handleFlag(record.sessionId, record.date)
                                    }
                                    title={buttonState.title}
                                    disabled={
                                      buttonState.disabled ||
                                      flaggingInProgress === record.sessionId
                                    }
                                  >
                                    {buttonState.icon}
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="text-center py-8 text-muted-foreground"
                          >
                            No class records to display.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                {/* Legend for flag statuses */}
                {shownRecords.some((r) => r.flagStatus) && (
                  <div className="text-sm text-muted-foreground border-t pt-4">
                    <p className="font-medium mb-2">Flag Status Legend:</p>
                    <div className="flex flex-wrap gap-4">
                      <div className="flex items-center gap-2">
                        <Flag className="h-4 w-4 text-warning fill-warning" />
                        <span>Pending Review</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-success" />
                        <span>Accepted - Attendance Recorded</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Flag className="h-4 w-4 text-muted-foreground/50" />
                        <span>Denied - Cannot Flag Again</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StudentDashboard;
