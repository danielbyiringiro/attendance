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
  Flag,
  CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { format, parseISO } from "date-fns";
import { useToast } from "@/hooks/use-toast";

interface AttendanceRecord {
  date: string;
  status: "Present" | "Absent";
  timestamp?: string;
  isFlagged?: boolean;
  flagStatus?: "flagged" | "accepted" | "denied" | null; // Track the flag status
}

interface StudentDashboardProps {
  onBack: () => void;
}

const SEMESTER_START = new Date(Date.UTC(2026, 4, 26)); // May 26, 2026

const isValidClassDay = (date: Date): boolean => {
  const day = date.getDay();
  return day === 2 || day === 3 || day === 4; // Tue, Wed, Thu
};

const StudentDashboard = ({ onBack }: StudentDashboardProps) => {
  const [studentId, setStudentId] = useState("");
  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [stats, setStats] = useState({ present: 0, absent: 0, total: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [flaggingInProgress, setFlaggingInProgress] = useState<string | null>(
    null,
  );
  const { toast } = useToast();

  const handleFlag = async (date: string) => {
    if (flaggingInProgress === date) return; // Prevent double submission

    setFlaggingInProgress(date);

    try {
      // Flagging is handled server-side; the anon key cannot write to the table
      // directly. The RPC enforces the "already pending / denied" rules.
      const { data, error } = await supabase.rpc("flag_attendance", {
        p_student_id: studentId,
        p_session_date: date,
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
      setHistory((prev) =>
        prev.map((record) =>
          record.date === date
            ? { ...record, isFlagged: true, flagStatus: "flagged" }
            : record,
        ),
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
        present?: Array<{ timestamp: string; cohort: string }>;
        cancelled?: string[];
        flagged?: Array<{ session_date: string; status: string }>;
      };
      const presentData = payload.present ?? [];

      if (presentData.length === 0) {
        setHistory([]);
        setStats({ present: 0, absent: 0, total: 0 });
        toast({
          title: "No Records Found",
          description: `No attendance records found for ID: ${studentId}`,
        });
        setIsLoading(false);
        return;
      }

      const cancelledDates = new Set<string>(payload.cancelled ?? []);

      const flaggedMap = new Map<string, "flagged" | "accepted" | "denied">();
      (payload.flagged ?? []).forEach((row) => {
        flaggedMap.set(
          row.session_date,
          row.status as "flagged" | "accepted" | "denied",
        );
      });

      // Track present dates
      const presentDatesMap = new Map<string, string>();
      presentData.forEach((record: any) => {
        const d = new Date(record.timestamp);
        const localDateStr = d.toISOString().split("T")[0];
        presentDatesMap.set(localDateStr, record.timestamp);
      });

      const historyList: AttendanceRecord[] = [];
      let presentCount = 0;
      let absentCount = 0;

      const currentDate = new Date(SEMESTER_START);
      const today = new Date();
      today.setHours(23, 59, 59, 999);

      while (currentDate <= today) {
        if (isValidClassDay(currentDate)) {
          const dateStr = currentDate.toISOString().split("T")[0];

          // If the class wasn't cancelled, it was an expected class day
          if (!cancelledDates.has(dateStr)) {
            const flagStatus = flaggedMap.get(dateStr);

            if (presentDatesMap.has(dateStr)) {
              historyList.push({
                date: dateStr,
                status: "Present",
                timestamp: presentDatesMap.get(dateStr),
                isFlagged: flagStatus === "flagged", // Only show as flagged if pending
                flagStatus: flagStatus || null,
              });
              presentCount++;
            } else {
              historyList.push({
                date: dateStr,
                status: "Absent",
                isFlagged: flagStatus === "flagged",
                flagStatus: flagStatus || null,
              });
              absentCount++;
            }
          }
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      // Catch any edge cases where a student was present on a day not typically considered a class day
      presentDatesMap.forEach((timestamp, dateStr) => {
        if (!historyList.find((h) => h.date === dateStr)) {
          const flagStatus = flaggedMap.get(dateStr);
          historyList.push({
            date: dateStr,
            status: "Present",
            timestamp,
            isFlagged: flagStatus === "flagged",
            flagStatus: flagStatus || null,
          });
          presentCount++;
        }
      });

      // Sort by date descending
      historyList.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );

      setHistory(historyList);
      setStats({
        present: presentCount,
        absent: absentCount,
        total: presentCount + absentCount,
      });
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
  const getFlagButtonState = (record: AttendanceRecord) => {
    if (record.flagStatus === "accepted") {
      return {
        disabled: true,
        title: "Flag was accepted - attendance has been recorded",
        icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
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
        icon: <Flag className="h-4 w-4 text-orange-500 fill-orange-500" />,
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
        <Button variant="ghost" onClick={onBack} className="mb-4">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Check-in
        </Button>

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
                {/* Statistics Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card className="bg-primary/5 border-primary/20">
                    <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                      <CalendarDays className="h-8 w-8 text-primary mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">
                        Total Classes
                      </p>
                      <p className="text-3xl font-bold text-primary">
                        {stats.total}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-green-500/5 border-green-500/20">
                    <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                      <UserCheck className="h-8 w-8 text-green-600 mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">
                        Days Present
                      </p>
                      <p className="text-3xl font-bold text-green-600">
                        {stats.present}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-destructive/5 border-destructive/20">
                    <CardContent className="p-6 flex flex-col items-center justify-center text-center">
                      <UserX className="h-8 w-8 text-destructive mb-2" />
                      <p className="text-sm font-medium text-muted-foreground">
                        Days Absent
                      </p>
                      <p className="text-3xl font-bold text-destructive">
                        {stats.absent}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* History Table */}
                <div className="rounded-md border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Time Recorded</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.length > 0 ? (
                        history.map((record, index) => {
                          const buttonState = getFlagButtonState(record);

                          return (
                            <TableRow key={`${record.date}-${index}`}>
                              <TableCell className="font-medium">
                                {format(parseISO(record.date), "MMM d, yyyy")}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {record.timestamp
                                  ? format(new Date(record.timestamp), "h:mm a")
                                  : "-"}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                    record.status === "Present"
                                      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                                      : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                                  }`}
                                >
                                  {record.status}
                                </span>
                                {record.flagStatus === "accepted" && (
                                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                    Flag Accepted
                                  </span>
                                )}
                                {record.flagStatus === "denied" && (
                                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
                                    Flag Denied
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant={buttonState.variant}
                                  size="sm"
                                  onClick={() => handleFlag(record.date)}
                                  title={buttonState.title}
                                  disabled={
                                    buttonState.disabled ||
                                    flaggingInProgress === record.date
                                  }
                                >
                                  {buttonState.icon}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={4}
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
                {history.some((r) => r.flagStatus) && (
                  <div className="text-sm text-muted-foreground border-t pt-4">
                    <p className="font-medium mb-2">Flag Status Legend:</p>
                    <div className="flex flex-wrap gap-4">
                      <div className="flex items-center gap-2">
                        <Flag className="h-4 w-4 text-orange-500 fill-orange-500" />
                        <span>Pending Review</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
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
