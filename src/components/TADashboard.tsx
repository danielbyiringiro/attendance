import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase";
import {
  Settings,
  Users,
  UserCheck,
  UserX,
  RefreshCw,
  Timer,
  Shield,
  History,
  CheckCircle2,
  XCircle,
  Calendar as CalendarIcon,
  Search,
  UserPlus,
  UserMinus,
  CalendarDays,
  Flag,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

// Semester start date — attendance is only tracked from this date forward
const SEMESTER_START = new Date(Date.UTC(2026, 0, 26)); // January 26, 2026

export const isValidClassDay = (date: Date): boolean => {
  const day = date.getDay();
  return day === 2 || day === 3 || day === 4;
};

interface Student {
  id: string;
  cohort: string;
  timestamp: Date;
  name?: string;
}

interface RosterStudent {
  student_id: string;
  cohort: "A" | "B" | "C" | string;
  name?: string;
}

interface TADashboardProps {
  activeSection?: "attendance" | "analytics" | "students" | "sessions";
  presentStudents: Student[];
  roster: RosterStudent[];
  currentPin: string;
  timeLimit: number;
  isTimeUp: boolean;
  onSetPin: (pin: string) => void;
  onSetTimeLimit: (seconds: number) => void;
  onResetAttendance: () => void;
  onLogout: () => void;
  onMarkAttendance: (
    studentId: string,
    cohort: string,
  ) => Promise<{ success: boolean; error?: string }>;
}

interface AbsenceHistory {
  date: string;
  student_id: string;
  cohort: string;
  was_class_cancelled: boolean;
}

interface ClassSession {
  date: string;
  cohort: "A" | "B" | "C";
  is_cancelled: boolean;
}

interface ClassSchedule {
  cohort: "A" | "B" | "C";
  day_of_week: number; // 0 = Sunday, 1 = Monday, etc.
}

interface WeeklyAbsence {
  student_id: string;
  cohort: "A" | "B" | "C";
  name?: string;
  absentDays: string[]; // YYYY-MM-DD dates they were absent
  frequency: number;
}

interface FlaggedRecord {
  id: string;
  student_id: string;
  session_date: string;
  status: string;
  created_at: string;
}

const TADashboard = ({
  activeSection = "attendance",
  presentStudents,
  roster,
  currentPin,
  timeLimit,
  isTimeUp,
  onSetPin,
  onSetTimeLimit,
  onResetAttendance,
  onLogout,
  onMarkAttendance,
}: TADashboardProps) => {
  const [newPin, setNewPin] = useState("");
  const [newTimeLimit, setNewTimeLimit] = useState("");
  const [selectedCohort, setSelectedCohort] = useState("all");
  const { toast } = useToast();
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [absenceHistory, setAbsenceHistory] = useState<AbsenceHistory[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyDate, setHistoryDate] = useState<Date | undefined>(undefined);
  const [cancelledSessions, setCancelledSessions] = useState<ClassSession[]>(
    [],
  );
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelDate, setCancelDate] = useState<Date | undefined>(undefined);
  const [cancelCohort, setCancelCohort] = useState<"A" | "B" | "C" | "">("");
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [studentAbsenceHistory, setStudentAbsenceHistory] = useState<
    AbsenceHistory[]
  >([]);
  const [isLoadingStudentHistory, setIsLoadingStudentHistory] = useState(false);
  const [classDates, setClassDates] = useState<Map<string, boolean>>(new Map()); // key: "YYYY-MM-DD-cohort"
  const [classSchedule, setClassSchedule] = useState<ClassSchedule[]>([]);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleCohort, setScheduleCohort] = useState<"A" | "B" | "C" | "">(
    "",
  );
  const [selectedDays, setSelectedDays] = useState<number[]>([]);

  // Weekly absence search state
  const [showWeeklyAbsenceDialog, setShowWeeklyAbsenceDialog] = useState(false);
  const [weeklyAbsenceDate, setWeeklyAbsenceDate] = useState<Date | undefined>(
    undefined,
  );
  const [weeklyAbsences, setWeeklyAbsences] = useState<WeeklyAbsence[]>([]);
  const [isLoadingWeeklyAbsences, setIsLoadingWeeklyAbsences] = useState(false);
  const [weeklyAbsenceCohortFilter, setWeeklyAbsenceCohortFilter] =
    useState("all");

  // Add/Remove student state
  const [showAddStudentDialog, setShowAddStudentDialog] = useState(false);
  const [addStudentId, setAddStudentId] = useState("");
  const [addStudentName, setAddStudentName] = useState("");
  const [addStudentCohort, setAddStudentCohort] = useState<
    "A" | "B" | "C" | ""
  >("");
  const [showRemoveStudentDialog, setShowRemoveStudentDialog] = useState(false);
  const [removeSearchQuery, setRemoveSearchQuery] = useState("");
  const [studentToRemove, setStudentToRemove] = useState<{
    student_id: string;
    cohort: "A" | "B" | "C";
    name?: string;
  } | null>(null);

  const [showFlaggedDialog, setShowFlaggedDialog] = useState(false);
  const [flaggedRecords, setFlaggedRecords] = useState<FlaggedRecord[]>([]);
  const [isLoadingFlagged, setIsLoadingFlagged] = useState(false);

  const isValidClassDay = (date: Date): boolean => {
    const day = date.getDay();
    return day === 2 || day === 3 || day === 4; // Tue, Wed, Thu
  };
  const allStudents = roster.map((r) => r.student_id);
  const rosterIds = new Set(allStudents);
  const inferCohort = (id: string): "A" | "B" | "C" =>
    id.toUpperCase().includes("A")
      ? "A"
      : id.toUpperCase().includes("B")
        ? "B"
        : "C";

  const loadFlaggedRecords = async () => {
    setIsLoadingFlagged(true);
    const { data, error } = await supabase
      .from("flagged")
      .select("*")
      .eq("status", "flagged")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to load flagged records:", error);
      toast({
        title: "Error",
        description: "Failed to load flagged records",
        variant: "destructive",
      });
    } else {
      setFlaggedRecords(data || []);
    }
    setIsLoadingFlagged(false);
  };

  const handleResolveFlag = async (
    record: FlaggedRecord,
    resolution: "accepted" | "denied",
  ) => {
    try {
      if (resolution === "accepted") {
        const studentEntry = roster.find(
          (r) => r.student_id === record.student_id,
        );
        const cohort = studentEntry
          ? studentEntry.cohort
          : inferCohort(record.student_id);
        // Assume the session was at noon on the local date to ensure UTC mapping matches date
        const sessionTimestamp = new Date(
          `${record.session_date}T12:00:00Z`,
        ).toISOString();

        const { error: insertError } = await supabase
          .from("present_students")
          .insert([
            {
              student_id: record.student_id,
              cohort,
              timestamp: sessionTimestamp,
            },
          ]);
        if (insertError) throw insertError;
      }

      const { error: updateError } = await supabase
        .from("flagged")
        .update({ status: resolution })
        .eq("id", record.id);

      if (updateError) throw updateError;

      toast({
        title: "Success",
        description: `Record marked as ${resolution}.`,
      });
      await loadFlaggedRecords();
    } catch (error) {
      console.error("Error resolving flag:", error);
      toast({
        title: "Error",
        description: "Failed to resolve flag.",
        variant: "destructive",
      });
    }
  };

  const handleSetPin = () => {
    if (newPin.length < 3) {
      toast({
        title: "Invalid PIN",
        description: "PIN must be at least 3 characters long.",
        variant: "destructive",
      });
      return;
    }
    onSetPin(newPin);
    setNewPin("");
    toast({
      title: "PIN Updated",
      description: "The attendance PIN has been updated successfully.",
    });
  };

  const handleSetTimeLimit = () => {
    const minutes = parseInt(newTimeLimit);
    if (isNaN(minutes) || minutes < 1) {
      toast({
        title: "Invalid Time",
        description: "Please enter a valid number of minutes (minimum 1).",
        variant: "destructive",
      });
      return;
    }
    onSetTimeLimit(minutes * 60);
    setNewTimeLimit("");
    toast({
      title: "Time Limit Updated",
      description: `Attendance window set to ${minutes} minutes.`,
    });
  };

  // Only count students who are actually on the roster, and never count the same
  // student twice. This guarantees "present" can never exceed total enrolled even
  // if the attendance table contains duplicates or records for removed students.
  const validPresentStudents = Array.from(
    new Map(
      presentStudents
        .filter((s) => rosterIds.has(s.id))
        .map((s) => [s.id, s]),
    ).values(),
  );

  const filteredPresentStudents =
    selectedCohort === "all"
      ? validPresentStudents
      : validPresentStudents.filter(
        (student) => student.cohort === selectedCohort.toUpperCase(),
      );

  const presentStudentIds = validPresentStudents.map((s) => s.id);
  const absentStudents = allStudents.filter(
    (id) => !presentStudentIds.includes(id),
  );
  const filteredAbsentStudents =
    selectedCohort === "all"
      ? absentStudents
      : absentStudents.filter((id) => {
        const rosterEntry = roster.find((r) => r.student_id === id);
        const cohort = rosterEntry ? rosterEntry.cohort : inferCohort(id);
        return cohort === selectedCohort.toUpperCase();
      });

  const cohortAPresent = validPresentStudents.filter(
    (s) => s.cohort === "A",
  ).length;
  const cohortBPresent = validPresentStudents.filter(
    (s) => s.cohort === "B",
  ).length;
  const cohortCPresent = validPresentStudents.filter(
    (s) => s.cohort === "C",
  ).length;
  const cohortATotal = roster.filter((r) => r.cohort === "A").length;
  const cohortBTotal = roster.filter((r) => r.cohort === "B").length;
  const cohortCTotal = roster.filter((r) => r.cohort === "C").length;

  // Load cancelled sessions and class dates
  useEffect(() => {
    (async () => {
      const { data: cancelledData, error: cancelledError } = await supabase
        .from("cancelled_sessions")
        .select("date, cohort, is_cancelled")
        .eq("is_cancelled", true);
      if (cancelledError && cancelledError.code !== "PGRST116") {
        console.error("Failed to load cancelled sessions:", cancelledError);
      } else if (cancelledData) {
        setCancelledSessions(
          cancelledData.map((row: any) => ({
            date: row.date,
            cohort: row.cohort,
            is_cancelled: row.is_cancelled,
          })),
        );
      }

      // Load class schedule
      const { data: scheduleData, error: scheduleError } = await supabase
        .from("class_schedule")
        .select("cohort, day_of_week")
        .order("cohort, day_of_week");
      if (scheduleError && scheduleError.code !== "PGRST116") {
        console.error("Failed to load class schedule:", scheduleError);
      } else if (scheduleData) {
        setClassSchedule(
          scheduleData.map((row: any) => ({
            cohort: row.cohort,
            day_of_week: row.day_of_week,
          })),
        );
      }

      // Load actual class dates
      const { data: classDatesData, error: classDatesError } = await supabase
        .from("class_schedule")
        .select("day_of_week, cohort");
      if (classDatesError && classDatesError.code !== "PGRST116") {
        console.error("Failed to load class dates:", classDatesError);
      } else if (classDatesData) {
        const datesMap = new Map<string, boolean>();
        classDatesData.forEach((row: any) => {
          const key = `${row.date}-${row.cohort}`;
          datesMap.set(key, true);
        });
        setClassDates(datesMap);
      }
    })();
  }, []);

  // Helper function to check if a date is a class day
  const isClassDay = (date: Date, cohort: "A" | "B" | "C"): boolean => {
    // Only Mon/Wed/Fri count as class days
    if (!isValidClassDay(date)) {
      return false;
    }

    const dateStr = date.toISOString().split("T")[0];
    const key = `${dateStr}-${cohort}`;

    // First check explicit class_dates table
    if (classDates.has(key)) {
      return true;
    }

    // Then check if it matches the schedule
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const scheduleMatches = classSchedule.some(
      (s) => s.cohort === cohort && s.day_of_week === dayOfWeek,
    );

    // Also check if there was attendance on this date (implies it was a class day)
    if (scheduleMatches) {
      // If it matches the schedule, we can assume it's a class day
      // unless explicitly cancelled
      const isCancelled = cancelledSessions.some(
        (s) => s.date === dateStr && s.cohort === cohort && s.is_cancelled,
      );
      return !isCancelled;
    }

    return false;
  };

  // Add student to roster
  const handleAddStudent = async () => {
    if (!addStudentId.trim()) {
      toast({
        title: "Student ID Required",
        description: "Please enter a student ID.",
        variant: "destructive",
      });
      return;
    }
    if (!addStudentCohort) {
      toast({
        title: "Cohort Required",
        description: "Please select a cohort for the student.",
        variant: "destructive",
      });
      return;
    }

    // Check if student already exists
    const existing = roster.find(
      (r) => r.student_id.toLowerCase() === addStudentId.trim().toLowerCase(),
    );
    if (existing) {
      toast({
        title: "Student Already Exists",
        description: `Student ${addStudentId.trim()} is already in the roster (Cohort ${existing.cohort}).`,
        variant: "destructive",
      });
      return;
    }

    const newStudent = {
      student_id: addStudentId.trim(),
      cohort: addStudentCohort as "A" | "B" | "C",
      name: addStudentName.trim() || null,
    };

    const { error } = await supabase.from("students").insert(newStudent);

    if (error) {
      console.error("Failed to add student:", error);
      toast({
        title: "Error",
        description: "Failed to add student to roster.",
        variant: "destructive",
      });
      return;
    }

    // Roster will be updated automatically via realtime subscription in Index.tsx

    toast({
      title: "Student Added",
      description: `${newStudent.student_id}${newStudent.name ? ` (${newStudent.name})` : ""} added to Cohort ${newStudent.cohort}.`,
    });

    // Reset form
    setAddStudentId("");
    setAddStudentName("");
    setAddStudentCohort("");
    setShowAddStudentDialog(false);
  };

  // Remove student from roster
  const handleRemoveStudent = async () => {
    if (!studentToRemove) {
      toast({
        title: "No Student Selected",
        description: "Please select a student to remove.",
        variant: "destructive",
      });
      return;
    }

    const { error } = await supabase
      .from("students")
      .delete()
      .eq("student_id", studentToRemove.student_id);

    if (error) {
      console.error("Failed to remove student:", error);
      toast({
        title: "Error",
        description: "Failed to remove student from roster.",
        variant: "destructive",
      });
      return;
    }

    // Roster will be updated automatically via realtime subscription in Index.tsx

    toast({
      title: "Student Removed",
      description: `${studentToRemove.student_id}${studentToRemove.name ? ` (${studentToRemove.name})` : ""} has been removed from the roster.`,
    });

    setStudentToRemove(null);
    setRemoveSearchQuery("");
    setShowRemoveStudentDialog(false);
  };

  // Filtered roster for the remove dialog search
  // Compute Monday of the week containing a given date (local time)
  const getMonday = (date: Date): Date => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay(); // 0=Sun … 6=Sat
    const diff = day === 0 ? -6 : 1 - day; // shift to Monday
    d.setDate(d.getDate() + diff);
    return d;
  };

  // Load weekly absences for the week containing the selected date
  const loadWeeklyAbsences = async (date: Date) => {
    setIsLoadingWeeklyAbsences(true);
    setWeeklyAbsences([]);

    try {
      const monday = getMonday(date);
      const saturday = new Date(monday);
      saturday.setDate(saturday.getDate() + 5); // Saturday (exclusive upper bound for the query)
      const todayStr = new Date().toISOString().split("T")[0];
      // Valid class days in this week (Mon=1, Wed=3, Fri=5)
      const classDaysInWeek: Date[] = [];

      for (let d = new Date(monday); d < saturday; d.setDate(d.getDate() + 1)) {
        if (!isValidClassDay(d)) continue;

        const dateStr = d.toISOString().split("T")[0];

        // Only include days up to today
        if (dateStr <= todayStr && d >= SEMESTER_START) {
          classDaysInWeek.push(new Date(d));
        }
      }

      if (classDaysInWeek.length === 0) {
        setIsLoadingWeeklyAbsences(false);
        return;
      }

      // Format dates as YYYY-MM-DD in local time (avoids UTC shift)
      const toDateStr = (d: Date): string => {
        return d.toISOString().split("T")[0];
      };

      const classDayStrings = classDaysInWeek.map(toDateStr);

      const mondayStr = toDateStr(monday);
      const saturdayStr = toDateStr(saturday);

      // Get attendance records for the week
      const { data: attendanceData, error: attendanceError } = await supabase
        .from("present_students")
        .select("student_id, cohort, timestamp")
        .gte("timestamp", mondayStr + "T00:00:00")
        .lt("timestamp", saturdayStr + "T00:00:00");

      if (attendanceError) {
        console.error("Failed to load weekly attendance:", attendanceError);
        setIsLoadingWeeklyAbsences(false);
        return;
      }

      // Get cancelled sessions for the week
      const { data: cancelledData } = await supabase
        .from("cancelled_sessions")
        .select("date, cohort, is_cancelled")
        .gte("date", classDayStrings[0])
        .lte("date", classDayStrings[classDayStrings.length - 1])
        .eq("is_cancelled", true);

      const cancelledSet = new Set<string>();
      if (cancelledData) {
        cancelledData.forEach((row: any) => {
          cancelledSet.add(row.date);
        });
      }

      // Build a set of present student+date combos
      const presentSet = new Set<string>();
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const d = new Date(record.timestamp);
          const recordDate = toDateStr(d);
          presentSet.add(`${record.student_id}-${recordDate}`);
        });
      }

      // For each student in the roster, check each class day
      const absenceMap = new Map<
        string,
        {
          student_id: string;
          cohort: "A" | "B" | "C";
          name?: string;
          absentDays: string[];
        }
      >();

      roster.forEach((student) => {
        classDayStrings.forEach((dateStr) => {
          if (cancelledSet.has(dateStr)) return; // ignore any cancelled session
          const presentKey = `${student.student_id}-${dateStr}`;
          if (!presentSet.has(presentKey)) {
            if (!absenceMap.has(student.student_id)) {
              absenceMap.set(student.student_id, {
                student_id: student.student_id,
                cohort: student.cohort as "A" | "B" | "C",
                name: student.name,
                absentDays: [],
              });
            }
            absenceMap.get(student.student_id)!.absentDays.push(dateStr);
          }
        });
      });

      // Convert to array and compute frequency, sort by frequency descending
      const result: WeeklyAbsence[] = Array.from(absenceMap.values()).map(
        (entry) => ({
          ...entry,
          frequency: entry.absentDays.length,
        }),
      );
      result.sort((a, b) => b.frequency - a.frequency);

      setWeeklyAbsences(result);
    } catch (error) {
      console.error("Error loading weekly absences:", error);
    } finally {
      setIsLoadingWeeklyAbsences(false);
    }
  };

  const filteredWeeklyAbsences =
    weeklyAbsenceCohortFilter === "all"
      ? weeklyAbsences
      : weeklyAbsences.filter(
        (a) => a.cohort === weeklyAbsenceCohortFilter.toUpperCase(),
      );

  const filteredRosterForRemoval = removeSearchQuery.trim()
    ? roster.filter(
      (r) =>
        r.student_id
          .toLowerCase()
          .includes(removeSearchQuery.toLowerCase()) ||
        (r.name &&
          r.name.toLowerCase().includes(removeSearchQuery.toLowerCase())),
    )
    : roster;

  const handleMarkAttendanceManually = async (
    studentId: string,
    cohort: string,
  ) => {
    const result = await onMarkAttendance(studentId, cohort);
    if (result.success) {
      toast({
        title: "Attendance Marked",
        description: `Marked ${studentId} as present (Cohort ${cohort})`,
      });
    } else {
      toast({
        title: "Error",
        description: result.error || "Failed to mark attendance",
        variant: "destructive",
      });
    }
  };

  const loadAbsenceHistory = async (date?: Date) => {
    setIsLoadingHistory(true);
    try {
      let startDate: Date;
      let endDate: Date;

      if (date) {
        // Load for specific date
        startDate = new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            0,
            0,
            0,
          ),
        );
        endDate = new Date(
          Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate() + 1,
            0,
            0,
            0,
          ),
        );
      } else {
        // Load from semester start
        endDate = new Date();
        startDate = new Date(SEMESTER_START);
      }

      // Get all attendance records for the date range
      const { data: attendanceData, error: attendanceError } = await supabase
        .from("present_students")
        .select("student_id, cohort, timestamp")
        .gte("timestamp", startDate.toISOString())
        .lt("timestamp", endDate.toISOString());

      if (attendanceError) {
        console.error("Failed to load attendance:", attendanceError);
        return;
      }

      // Get cancelled sessions for the date range
      const { data: cancelledData, error: cancelledError } = await supabase
        .from("cancelled_sessions")
        .select("date, cohort, is_cancelled")
        .gte("date", startDate.toISOString().split("T")[0])
        .lte("date", endDate.toISOString().split("T")[0])
        .eq("is_cancelled", true);

      if (cancelledError && cancelledError.code !== "PGRST116") {
        console.error("Failed to load cancelled sessions:", cancelledError);
      }

      const cancelledSessionsMap = new Map<string, boolean>();
      if (cancelledData) {
        cancelledData.forEach((session: any) => {
          const key = session.date;
          cancelledSessionsMap.set(key, true);
        });
      }

      // Get all students
      const allStudentIds = roster.map((r) => r.student_id);

      // Group attendance by date
      const attendanceByDate = new Map<string, Set<string>>();
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp)
            .toISOString()
            .split("T")[0];
          if (!attendanceByDate.has(recordDate)) {
            attendanceByDate.set(recordDate, new Set());
          }
          attendanceByDate.get(recordDate)!.add(record.student_id);
        });
      }

      // Get class dates for the range
      const { data: classDatesData, error: classDatesError } = await supabase
        .from("class_dates")
        .select("date, cohort")
        .gte("date", startDate.toISOString().split("T")[0])
        .lte("date", endDate.toISOString().split("T")[0]);

      const classDatesMap = new Map<string, boolean>();
      if (classDatesData) {
        classDatesData.forEach((row: any) => {
          // Only count Mon/Wed/Fri
          const d = new Date(row.date + "T00:00:00");
          if (!isValidClassDay(d)) return;
          const key = `${row.date}-${row.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check attendance records to infer class days (if someone was present, it was a class day)
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const d = new Date(record.timestamp);
          if (!isValidClassDay(d)) return;
          const recordDate = d.toISOString().split("T")[0];
          const key = `${recordDate}-${record.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check if dates match the schedule
      const currentDateCheck = new Date(startDate);
      while (currentDateCheck < endDate) {
        // Skip non Mon/Wed/Fri
        if (!isValidClassDay(currentDateCheck)) {
          currentDateCheck.setDate(currentDateCheck.getDate() + 1);
          continue;
        }
        const dateStr = currentDateCheck.toISOString().split("T")[0];
        const dayOfWeek = currentDateCheck.getDay();

        classSchedule.forEach((schedule) => {
          if (schedule.day_of_week === dayOfWeek) {
            const key = `${dateStr}-${schedule.cohort}`;
            // Only add if not already in map and not cancelled
            if (!classDatesMap.has(key)) {
              const wasCancelled = cancelledSessionsMap.get(key) || false;
              if (!wasCancelled) {
                classDatesMap.set(key, true);
              }
            }
          }
        });

        currentDateCheck.setDate(currentDateCheck.getDate() + 1);
      }

      // Find absences - only on Mon/Wed/Fri when classes actually occurred
      const absences: AbsenceHistory[] = [];
      const currentDate = new Date(startDate);

      while (currentDate < endDate) {
        // Skip non Mon/Wed/Fri
        if (!isValidClassDay(currentDate)) {
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        const dateStr = currentDate.toISOString().split("T")[0];
        const presentOnDate = attendanceByDate.get(dateStr) || new Set();

        // Check each student
        allStudentIds.forEach((studentId) => {
          const studentRoster = roster.find((r) => r.student_id === studentId);
          const cohort = studentRoster?.cohort || inferCohort(studentId);
          const classDateKey = `${dateStr}-${cohort}`;

          // Only check absences on days when classes actually occurred
          const isClassDate = classDatesMap.has(classDateKey);

          // Check if class was cancelled for this cohort on this date
          const wasCancelled = cancelledSessionsMap.get(dateStr) || false;

          if (isClassDate && !presentOnDate.has(studentId) && !wasCancelled) {
            absences.push({
              date: dateStr,
              student_id: studentId,
              cohort: cohort,
              was_class_cancelled: false,
            });
          }
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      setAbsenceHistory(absences);
    } catch (error) {
      console.error("Error loading absence history:", error);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const generateClassDates = async (
    startDate: Date,
    endDate: Date,
    cohorts: ("A" | "B" | "C")[],
  ) => {
    try {
      const datesToInsert: Array<{ date: string; cohort: "A" | "B" | "C" }> =
        [];
      const currentDate = new Date(startDate);

      while (currentDate <= endDate) {
        // Skip non Mon/Wed/Fri
        if (!isValidClassDay(currentDate)) {
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const dateStr = currentDate.toISOString().split("T")[0];

        cohorts.forEach((cohort) => {
          // Check if this day matches the schedule
          const scheduleMatches = classSchedule.some(
            (s) => s.cohort === cohort && s.day_of_week === dayOfWeek,
          );

          if (scheduleMatches) {
            // Check if already cancelled - if so, don't add
            const isCancelled = cancelledSessions.some(
              (s) =>
                s.date === dateStr && s.cohort === cohort && s.is_cancelled,
            );

            if (!isCancelled) {
              datesToInsert.push({ date: dateStr, cohort });
            }
          }
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      if (datesToInsert.length > 0) {
        const { error } = await supabase
          .from("class_dates")
          .upsert(datesToInsert, {
            onConflict: "date,cohort",
            ignoreDuplicates: true,
          });

        if (error) {
          console.error("Failed to generate class dates:", error);
          toast({
            title: "Error",
            description: "Failed to generate class dates",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Class Dates Generated",
            description: `Generated ${datesToInsert.length} class dates based on schedule.`,
          });

          // Update local state
          const newDatesMap = new Map(classDates);
          datesToInsert.forEach(({ date, cohort }) => {
            const key = `${date}-${cohort}`;
            newDatesMap.set(key, true);
          });
          setClassDates(newDatesMap);
        }
      }
    } catch (error) {
      console.error("Error generating class dates:", error);
    }
  };

  const handleSaveSchedule = async (
    cohort: "A" | "B" | "C",
    daysOfWeek: number[],
  ) => {
    try {
      // Delete existing schedule for this cohort
      const { error: deleteError } = await supabase
        .from("class_schedule")
        .delete()
        .eq("cohort", cohort);

      if (deleteError) {
        console.error("Failed to delete old schedule:", deleteError);
      }

      // Insert new schedule
      const scheduleEntries = daysOfWeek.map((day) => ({
        cohort,
        day_of_week: day,
      }));

      const { error: insertError } = await supabase
        .from("class_schedule")
        .insert(scheduleEntries);

      if (insertError) {
        console.error("Failed to save schedule:", insertError);
        toast({
          title: "Error",
          description: "Failed to save class schedule",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Schedule Saved",
          description: `Class schedule for Cohort ${cohort} has been updated.`,
        });

        // Update local state
        const newSchedule = classSchedule.filter((s) => s.cohort !== cohort);
        scheduleEntries.forEach((entry) => {
          newSchedule.push({
            cohort: entry.cohort,
            day_of_week: entry.day_of_week,
          });
        });
        setClassSchedule(newSchedule);
      }
    } catch (error) {
      console.error("Error saving schedule:", error);
    }
  };

  const handleCancelClass = async () => {
    if (!cancelDate || !cancelCohort) {
      toast({
        title: "Error",
        description: "Please select both date and cohort",
        variant: "destructive",
      });
      return;
    }

    const dateStr = cancelDate.toISOString().split("T")[0];

    // Upsert cancelled session
    const { error } = await supabase.from("cancelled_sessions").upsert(
      {
        date: dateStr,
        cohort: cancelCohort,
        is_cancelled: true,
      },
      { onConflict: "date,cohort" },
    );

    if (error) {
      console.error("Failed to cancel class:", error);
      toast({
        title: "Error",
        description: "Failed to mark class as cancelled",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Class Cancelled",
        description: `Cohort ${cancelCohort} class cancelled for ${dateStr}`,
      });
      setCancelledSessions((prev) => [
        ...prev,
        { date: dateStr, cohort: cancelCohort, is_cancelled: true },
      ]);
      setShowCancelDialog(false);
      setCancelDate(undefined);
      setCancelCohort("");
    }
  };

  const searchStudent = async (query: string) => {
    if (!query.trim()) {
      setStudentAbsenceHistory([]);
      return;
    }

    setIsLoadingStudentHistory(true);
    try {
      // Search for student by ID or name (case-insensitive partial match)
      const searchLower = query.toLowerCase().trim();
      const matchingStudents = roster.filter(
        (r) =>
          r.student_id.toLowerCase().includes(searchLower) ||
          (r.name && r.name.toLowerCase().includes(searchLower)),
      );

      if (matchingStudents.length === 0) {
        setStudentAbsenceHistory([]);
        toast({
          title: "No Results",
          description: "No student found matching your search.",
          variant: "default",
        });
        setIsLoadingStudentHistory(false);
        return;
      }

      // If multiple matches, take the first one (or show all)
      // For now, let's show all matches
      const studentIds = matchingStudents.map((s) => s.student_id);

      // Get all attendance records for these students
      const { data: attendanceData, error: attendanceError } = await supabase
        .from("present_students")
        .select("student_id, cohort, timestamp")
        .in("student_id", studentIds)
        .order("timestamp", { ascending: false });

      if (attendanceError) {
        console.error("Failed to load attendance:", attendanceError);
        setIsLoadingStudentHistory(false);
        return;
      }

      // Get cancelled sessions for all dates
      const { data: cancelledData, error: cancelledError } = await supabase
        .from("cancelled_sessions")
        .select("date, cohort, is_cancelled")
        .eq("is_cancelled", true);

      if (cancelledError && cancelledError.code !== "PGRST116") {
        console.error("Failed to load cancelled sessions:", cancelledError);
      }

      const cancelledSessionsMap = new Map<string, boolean>();
      if (cancelledData) {
        cancelledData.forEach((session: any) => {
          const key = session.date;
          cancelledSessionsMap.set(key, true);
        });
      }

      // Group attendance by student and date
      const attendanceByStudentAndDate = new Map<string, Set<string>>();
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp)
            .toISOString()
            .split("T")[0];
          const key = `${record.student_id}-${recordDate}`;
          if (!attendanceByStudentAndDate.has(record.student_id)) {
            attendanceByStudentAndDate.set(record.student_id, new Set());
          }
          attendanceByStudentAndDate.get(record.student_id)!.add(recordDate);
        });
      }

      // Get class dates for the range (from semester start)
      const endDate = new Date();
      const startDate = new Date(SEMESTER_START);

      const { data: classDatesData, error: classDatesError } = await supabase
        .from("class_dates")
        .select("date, cohort")
        .gte("date", startDate.toISOString().split("T")[0])
        .lte("date", endDate.toISOString().split("T")[0]);

      const classDatesMap = new Map<string, boolean>();
      if (classDatesData) {
        classDatesData.forEach((row: any) => {
          // Only count Mon/Wed/Fri
          const d = new Date(row.date + "T00:00:00");
          if (!isValidClassDay(d)) return;
          const key = `${row.date}-${row.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check attendance records to infer class days (if someone was present, it was a class day)
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const d = new Date(record.timestamp);
          if (!isValidClassDay(d)) return;
          const recordDate = d.toISOString().split("T")[0];
          const key = `${recordDate}-${record.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check if dates match the schedule
      const currentDateCheck = new Date(startDate);
      while (currentDateCheck < endDate) {
        // Skip non Mon/Wed/Fri
        if (!isValidClassDay(currentDateCheck)) {
          currentDateCheck.setDate(currentDateCheck.getDate() + 1);
          continue;
        }
        const dateStr = currentDateCheck.toISOString().split("T")[0];
        const dayOfWeek = currentDateCheck.getDay();

        classSchedule.forEach((schedule) => {
          if (schedule.day_of_week === dayOfWeek) {
            const key = `${dateStr}-${schedule.cohort}`;
            // Only add if not already in map and not cancelled
            if (!classDatesMap.has(key)) {
              const wasCancelled = cancelledSessionsMap.get(key) || false;
              if (!wasCancelled) {
                classDatesMap.set(key, true);
              }
            }
          }
        });

        currentDateCheck.setDate(currentDateCheck.getDate() + 1);
      }

      // Find absences - only on Mon/Wed/Fri when classes actually occurred
      const absences: AbsenceHistory[] = [];
      const currentDate = new Date(startDate);

      while (currentDate < endDate) {
        // Skip non Mon/Wed/Fri
        if (!isValidClassDay(currentDate)) {
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }
        const dateStr = currentDate.toISOString().split("T")[0];

        // Check each matching student
        matchingStudents.forEach((student) => {
          const presentOnDate =
            attendanceByStudentAndDate.get(student.student_id)?.has(dateStr) ||
            false;
          const classDateKey = `${dateStr}-${student.cohort}`;
          const isClassDate = classDatesMap.has(classDateKey);
          const wasCancelled = cancelledSessionsMap.get(dateStr) || false;

          if (isClassDate && !presentOnDate && !wasCancelled) {
            absences.push({
              date: dateStr,
              student_id: student.student_id,
              cohort: student.cohort,
              was_class_cancelled: false,
            });
          }
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      // Sort by date descending
      absences.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
      setStudentAbsenceHistory(absences);
    } catch (error) {
      console.error("Error searching student:", error);
      toast({
        title: "Error",
        description: "Failed to search student",
        variant: "destructive",
      });
    } finally {
      setIsLoadingStudentHistory(false);
    }
  };

  useEffect(() => {
    if (showHistoryDialog) {
      loadAbsenceHistory();
    }
  }, [showHistoryDialog, roster]);

  // Debounce search query
  useEffect(() => {
    if (!showSearchDialog || !searchQuery.trim()) {
      setStudentAbsenceHistory([]);
      return;
    }

    const timeoutId = setTimeout(() => {
      searchStudent(searchQuery);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, showSearchDialog, roster]);

  const isAttendanceSection = activeSection === "attendance";
  const isAnalyticsSection = activeSection === "analytics";
  const isStudentsSection = activeSection === "students";
  const isSessionsSection = activeSection === "sessions";
  const sectionTitle =
    activeSection === "analytics"
      ? "Attendance Analytics"
      : activeSection === "students"
        ? "Student Management"
        : activeSection === "sessions"
          ? "Class Session Management"
          : "TA Dashboard";
  const sectionDescription =
    activeSection === "analytics"
      ? "Review attendance trends, absences, and flagged records"
      : activeSection === "students"
        ? "Search the roster and manage student records"
        : activeSection === "sessions"
          ? "Manage attendance windows, cancelled classes, and schedules"
          : "Manage live attendance and monitor student participation";

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-gradient-to-r from-primary to-accent rounded-lg">
              <Shield className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{sectionTitle}</h1>
              <p className="text-muted-foreground">
                {sectionDescription}
              </p>
            </div>
          </div>
          <Button onClick={onLogout} variant="outline">
            Logout
          </Button>
        </div>

        {isAnalyticsSection && (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <Card className="border-2 shadow-soft">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-2">
                    <UserCheck className="h-5 w-5 text-success" />
                    <div>
                      <p className="text-2xl font-bold text-success">
                        {validPresentStudents.length}
                      </p>
                      <p className="text-sm text-muted-foreground">Present</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 shadow-soft">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-2">
                    <UserX className="h-5 w-5 text-destructive" />
                    <div>
                      <p className="text-2xl font-bold text-destructive">
                        {absentStudents.length}
                      </p>
                      <p className="text-sm text-muted-foreground">Absent</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 shadow-soft">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-2">
                    <Users className="h-5 w-5 text-primary" />
                    <div>
                      <p className="text-2xl font-bold">
                        {cohortAPresent}/{cohortATotal}
                      </p>
                      <p className="text-sm text-muted-foreground">Cohort A</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 shadow-soft">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-2">
                    <Users className="h-5 w-5 text-accent" />
                    <div>
                      <p className="text-2xl font-bold">
                        {cohortBPresent}/{cohortBTotal}
                      </p>
                      <p className="text-sm text-muted-foreground">Cohort B</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 shadow-soft">
                <CardContent className="pt-6">
                  <div className="flex items-center space-x-2">
                    <Users className="h-5 w-5 text-accent" />
                    <div>
                      <p className="text-2xl font-bold">
                        {cohortCPresent}/{cohortCTotal}
                      </p>
                      <p className="text-sm text-muted-foreground">Cohort C</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}

        {/* Action Buttons */}
        {(isAnalyticsSection || isStudentsSection || isSessionsSection) && (
          <div className="flex gap-4 flex-wrap">
            {isAnalyticsSection && (
              <>
                <Button
                  onClick={() => setShowHistoryDialog(true)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <History className="h-4 w-4" />
                  View Absence History
                </Button>
                <Button
                  onClick={() => {
                    setShowWeeklyAbsenceDialog(true);
                    setWeeklyAbsenceDate(undefined);
                    setWeeklyAbsences([]);
                    setWeeklyAbsenceCohortFilter("all");
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <CalendarDays className="h-4 w-4" />
                  Weekly Absences
                </Button>
                <Button
                  onClick={() => {
                    setShowFlaggedDialog(true);
                    loadFlaggedRecords();
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Flag className="h-4 w-4" />
                  Review Flags
                </Button>
              </>
            )}
            {isStudentsSection && (
              <>
                <Button
                  onClick={() => {
                    setShowSearchDialog(true);
                    setSearchQuery("");
                    setStudentAbsenceHistory([]);
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Search className="h-4 w-4" />
                  Search Student
                </Button>
                <Button
                  onClick={() => {
                    setShowAddStudentDialog(true);
                    setAddStudentId("");
                    setAddStudentName("");
                    setAddStudentCohort("");
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <UserPlus className="h-4 w-4" />
                  Add Student
                </Button>
                <Button
                  onClick={() => {
                    setShowRemoveStudentDialog(true);
                    setRemoveSearchQuery("");
                    setStudentToRemove(null);
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <UserMinus className="h-4 w-4" />
                  Remove Student
                </Button>
              </>
            )}
            {isSessionsSection && (
              <>
                <Button
                  onClick={() => setShowCancelDialog(true)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <XCircle className="h-4 w-4" />
                  Cancel Class
                </Button>
                <Button
                  onClick={() => {
                    setShowScheduleDialog(true);
                    setScheduleCohort("");
                    setSelectedDays([]);
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Settings className="h-4 w-4" />
                  Class Schedule
                </Button>
              </>
            )}
          </div>
        )}

        {/* Controls and Student Lists */}
        {(isAttendanceSection || isSessionsSection || isStudentsSection) && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Controls */}
            {(isAttendanceSection || isSessionsSection) && (
              <Card className="border-2 shadow-medium">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Settings className="h-5 w-5" />
                    Attendance Controls
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Current PIN</label>
                    <div className="flex items-center space-x-2">
                      <Input
                        value={currentPin}
                        readOnly
                        className="font-mono text-lg text-center"
                      />
                      <Badge variant={isTimeUp ? "destructive" : "default"}>
                        {isTimeUp ? "Closed" : "Active"}
                      </Badge>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Set New PIN</label>
                    <div className="flex space-x-2">
                      <Input
                        placeholder="Enter new PIN"
                        value={newPin}
                        onChange={(e) => setNewPin(e.target.value)}
                      />
                      <Button onClick={handleSetPin} size="sm">
                        Set
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Time Limit (minutes)
                    </label>
                    <div className="flex space-x-2">
                      <Input
                        type="number"
                        placeholder="Minutes"
                        value={newTimeLimit}
                        onChange={(e) => setNewTimeLimit(e.target.value)}
                      />
                      <Button onClick={handleSetTimeLimit} size="sm">
                        <Timer className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={onResetAttendance}
                    variant="destructive"
                    className="w-full"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Reset Attendance
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Student Lists */}
            {(isAttendanceSection || isStudentsSection) && (
              <div
                className={cn(
                  isStudentsSection ? "lg:col-span-3" : "lg:col-span-2",
                )}
              >
                <Card className="border-2 shadow-medium">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <Users className="h-5 w-5" />
                        Student Status
                      </CardTitle>
                      <Select
                        value={selectedCohort}
                        onValueChange={setSelectedCohort}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Cohorts</SelectItem>
                          <SelectItem value="a">Cohort A</SelectItem>
                          <SelectItem value="b">Cohort B</SelectItem>
                          <SelectItem value="c">Cohort C</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Tabs defaultValue="absent" className="w-full">
                      <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger
                          value="present"
                          className="flex items-center gap-2"
                        >
                          <UserCheck className="h-4 w-4" />
                          Present ({filteredPresentStudents.length})
                        </TabsTrigger>
                        <TabsTrigger
                          value="absent"
                          className="flex items-center gap-2"
                        >
                          <UserX className="h-4 w-4" />
                          Absent ({filteredAbsentStudents.length})
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="present" className="mt-4">
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {filteredPresentStudents.length === 0 ? (
                            <p className="text-center text-muted-foreground py-8">
                              No students marked present yet
                            </p>
                          ) : (
                            filteredPresentStudents.map((student) => (
                              <div
                                key={student.id}
                                className="flex items-center justify-between p-2 bg-success/10 border border-success/20 rounded-lg"
                              >
                                {/* Left Side: ID and Name */}
                                <div className="flex flex-col">
                                  <div className="flex items-center space-x-2">
                                    <span className="font-medium">
                                      {student.id}
                                    </span>
                                  </div>
                                  <span className="text-sm text-muted-foreground mt-1">
                                    {roster.find((r) => r.student_id === student.id)
                                      ?.name || "Unknown Student"}
                                  </span>
                                </div>

                                {/* Right Side: Cohort and Timestamp stacked vertically */}
                                <div className="flex flex-col items-end space-y-1 ml-4">
                                  <Badge variant="outline" className="text-xs">
                                    Cohort {student.cohort}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                                    {student.timestamp.toLocaleTimeString()}
                                  </span>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </TabsContent>

                      <TabsContent value="absent" className="mt-4">
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                          {filteredAbsentStudents.length === 0 ? (
                            <p className="text-center text-muted-foreground py-8">
                              All students are present!
                            </p>
                          ) : (
                            filteredAbsentStudents.map((studentId) => {
                              const rosterEntry = roster.find(
                                (r) => r.student_id === studentId,
                              );
                              const cohort = rosterEntry
                                ? rosterEntry.cohort
                                : inferCohort(studentId);
                              const studentName = rosterEntry?.name;
                              return (
                                <div
                                  key={studentId}
                                  className="flex items-center justify-between p-2 bg-destructive/10 border border-destructive/20 rounded-lg"
                                >
                                  <div className="flex flex-col">
                                    <div className="flex items-center space-x-2">
                                      <span className="font-medium">
                                        {studentId}
                                      </span>
                                      <Badge variant="outline" className="text-xs">
                                        Cohort {cohort}
                                      </Badge>
                                    </div>
                                    <span className="text-sm text-muted-foreground mt-1">
                                      {studentName}
                                    </span>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      handleMarkAttendanceManually(
                                        studentId,
                                        cohort,
                                      )
                                    }
                                    className="h-8 text-xs"
                                  >
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    Mark Present
                                  </Button>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Absence History</DialogTitle>
            <DialogDescription>
              View students who missed class on specific days. Select a date to
              filter, or view all absences since January 26.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[240px] justify-start text-left font-normal",
                      !historyDate && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {historyDate
                      ? format(historyDate, "PPP")
                      : "Filter by date (optional)"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={historyDate}
                    onSelect={(date) => {
                      setHistoryDate(date);
                      if (date) {
                        loadAbsenceHistory(date);
                      } else {
                        loadAbsenceHistory();
                      }
                    }}
                    initialFocus
                  />
                  {historyDate && (
                    <div className="p-3 border-t">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          setHistoryDate(undefined);
                          loadAbsenceHistory();
                        }}
                      >
                        Clear Filter
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            {isLoadingHistory ? (
              <p className="text-center text-muted-foreground py-8">
                Loading history...
              </p>
            ) : absenceHistory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No absences found for the selected period.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2 font-semibold text-sm border-b pb-2">
                  <div>Date</div>
                  <div>Student ID</div>
                  <div>Cohort</div>
                  <div>Status</div>
                </div>
                {absenceHistory.map((absence, index) => {
                  const student = roster.find(
                    (r) => r.student_id === absence.student_id,
                  );
                  return (
                    <div
                      key={`${absence.date}-${absence.student_id}-${index}`}
                      className="grid grid-cols-4 gap-2 p-2 bg-muted/50 rounded-lg text-sm"
                    >
                      <div>
                        {format(new Date(absence.date), "MMM dd, yyyy")}
                      </div>
                      <div className="font-medium">{absence.student_id}</div>
                      <div>
                        <Badge variant="outline">Cohort {absence.cohort}</Badge>
                      </div>
                      <div>
                        {absence.was_class_cancelled ? (
                          <Badge variant="secondary">Class Cancelled</Badge>
                        ) : (
                          <Badge variant="destructive">Absent</Badge>
                        )}
                      </div>
                      {student?.name && (
                        <div className="col-span-4 text-xs text-muted-foreground mt-1">
                          {student.name}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setShowHistoryDialog(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Flagged Records Dialog */}
      <Dialog open={showFlaggedDialog} onOpenChange={setShowFlaggedDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Flagged Attendance Records</DialogTitle>
            <DialogDescription>
              Review attendance records flagged by students.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            {isLoadingFlagged ? (
              <p className="text-center text-muted-foreground py-8">
                Loading flagged records...
              </p>
            ) : flaggedRecords.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No flagged records to review.
              </p>
            ) : (
              <div className="space-y-3">
                {flaggedRecords.map((record) => {
                  const student = roster.find(
                    (r) => r.student_id === record.student_id,
                  );
                  return (
                    <div
                      key={record.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-muted/50 rounded-lg border gap-4"
                    >
                      <div>
                        <p className="font-semibold">
                          {student?.name
                            ? `${student.name} (${record.student_id})`
                            : record.student_id}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Disputed Date:{" "}
                          {format(new Date(record.session_date), "MMM d, yyyy")}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Flagged on:{" "}
                          {format(
                            new Date(record.created_at),
                            "MMM d, yyyy h:mm a",
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="default"
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => handleResolveFlag(record, "accepted")}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleResolveFlag(record, "denied")}
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          Deny
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => setShowFlaggedDialog(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Class Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Class</DialogTitle>
            <DialogDescription>
              Mark a class as cancelled for a specific cohort on a specific
              date. Students from that cohort won't be marked as absent on
              cancelled days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !cancelDate && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {cancelDate ? format(cancelDate, "PPP") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={cancelDate}
                    onSelect={setCancelDate}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Cohort</label>
              <Select
                value={cancelCohort}
                onValueChange={(value) =>
                  setCancelCohort(value as "A" | "B" | "C")
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select cohort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Cohort A</SelectItem>
                  <SelectItem value="B">Cohort B</SelectItem>
                  <SelectItem value="C">Cohort C</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleCancelClass}>Mark as Cancelled</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Search Student Dialog */}
      <Dialog open={showSearchDialog} onOpenChange={setShowSearchDialog}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Search Student Absence History</DialogTitle>
            <DialogDescription>
              Search for a student by name or ID to view all classes they
              missed. Enter part of their name or ID.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Input
                placeholder="Enter student name or ID..."
                value={searchQuery}
                onChange={(e) => {
                  const query = e.target.value;
                  setSearchQuery(query);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    searchStudent(searchQuery);
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={() => searchStudent(searchQuery)}
                variant="default"
              >
                <Search className="h-4 w-4 mr-2" />
                Search
              </Button>
            </div>

            {isLoadingStudentHistory ? (
              <p className="text-center text-muted-foreground py-8">
                Searching...
              </p>
            ) : studentAbsenceHistory.length === 0 && searchQuery ? (
              <p className="text-center text-muted-foreground py-8">
                No absences found for this student.
              </p>
            ) : studentAbsenceHistory.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium">
                    {studentAbsenceHistory.length}{" "}
                    {studentAbsenceHistory.length === 1
                      ? "absence"
                      : "absences"}{" "}
                    found
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-2 font-semibold text-sm border-b pb-2">
                  <div>Date</div>
                  <div>Student ID</div>
                  <div>Cohort</div>
                  <div>Status</div>
                </div>
                {studentAbsenceHistory.map((absence, index) => {
                  const student = roster.find(
                    (r) => r.student_id === absence.student_id,
                  );
                  return (
                    <div
                      key={`${absence.date}-${absence.student_id}-${index}`}
                      className="grid grid-cols-4 gap-2 p-2 bg-muted/50 rounded-lg text-sm"
                    >
                      <div>
                        {format(new Date(absence.date), "MMM dd, yyyy")}
                      </div>
                      <div className="font-medium">{absence.student_id}</div>
                      <div>
                        <Badge variant="outline">Cohort {absence.cohort}</Badge>
                      </div>
                      <div>
                        {absence.was_class_cancelled ? (
                          <Badge variant="secondary">Class Cancelled</Badge>
                        ) : (
                          <Badge variant="destructive">Absent</Badge>
                        )}
                      </div>
                      {student?.name && (
                        <div className="col-span-4 text-xs text-muted-foreground mt-1">
                          {student.name}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">
                Enter a name or ID to search.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowSearchDialog(false);
                setSearchQuery("");
                setStudentAbsenceHistory([]);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Class Schedule Dialog */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configure Class Schedule</DialogTitle>
            <DialogDescription>
              Set which days of the week classes occur for each cohort.
              Attendance will only be tracked on these days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Cohort</label>
              <Select
                value={scheduleCohort}
                onValueChange={(value) => {
                  setScheduleCohort(value as "A" | "B" | "C");
                  // Load existing schedule for this cohort
                  const existingSchedule = classSchedule.filter(
                    (s) => s.cohort === value,
                  );
                  setSelectedDays(existingSchedule.map((s) => s.day_of_week));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select cohort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Cohort A</SelectItem>
                  <SelectItem value="B">Cohort B</SelectItem>
                  <SelectItem value="C">Cohort C</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scheduleCohort && (
              <div className="space-y-3">
                <label className="text-sm font-medium">
                  Select Days of Week (3 days)
                </label>
                <div className="space-y-2">
                  {[
                    { value: 1, label: "Monday" },
                    { value: 2, label: "Tuesday" },
                    { value: 3, label: "Wednesday" },
                    { value: 4, label: "Thursday" },
                    { value: 5, label: "Friday" },
                    { value: 6, label: "Saturday" },
                    { value: 0, label: "Sunday" },
                  ].map((day) => (
                    <div
                      key={day.value}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={`day-${day.value}`}
                        checked={selectedDays.includes(day.value)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            if (selectedDays.length < 3) {
                              setSelectedDays([...selectedDays, day.value]);
                            } else {
                              toast({
                                title: "Maximum Days",
                                description:
                                  "Classes only occur 3 times per week. Please unselect a day first.",
                                variant: "default",
                              });
                            }
                          } else {
                            setSelectedDays(
                              selectedDays.filter((d) => d !== day.value),
                            );
                          }
                        }}
                      />
                      <label
                        htmlFor={`day-${day.value}`}
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                      >
                        {day.label}
                      </label>
                    </div>
                  ))}
                </div>

                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => {
                      if (!scheduleCohort || selectedDays.length === 0) {
                        toast({
                          title: "Error",
                          description:
                            "Please select a cohort and at least one day",
                          variant: "destructive",
                        });
                        return;
                      }
                      handleSaveSchedule(scheduleCohort, selectedDays);
                    }}
                    className="flex-1"
                  >
                    Save Schedule
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!scheduleCohort) {
                        toast({
                          title: "Error",
                          description: "Please select a cohort first",
                          variant: "destructive",
                        });
                        return;
                      }

                      // Generate class dates for next 3 months
                      const startDate = new Date();
                      const endDate = new Date();
                      endDate.setMonth(endDate.getMonth() + 3);

                      await generateClassDates(startDate, endDate, [
                        scheduleCohort as "A" | "B" | "C",
                      ]);
                    }}
                    className="flex-1"
                  >
                    Generate Class Dates (Next 3 Months)
                  </Button>
                </div>
              </div>
            )}

            {classSchedule.length > 0 && (
              <div className="pt-4 border-t">
                <p className="text-sm font-medium mb-2">Current Schedule:</p>
                <div className="space-y-1">
                  {["A", "B"].map((cohort) => {
                    const cohortSchedule = classSchedule.filter(
                      (s) => s.cohort === cohort,
                    );
                    if (cohortSchedule.length === 0) return null;

                    const dayNames = [
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ];
                    const days = cohortSchedule
                      .map((s) => dayNames[s.day_of_week])
                      .join(", ");

                    return (
                      <div key={cohort} className="text-sm">
                        <span className="font-medium">Cohort {cohort}:</span>{" "}
                        {days}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowScheduleDialog(false);
                setScheduleCohort("");
                setSelectedDays([]);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Student Dialog */}
      <Dialog
        open={showAddStudentDialog}
        onOpenChange={setShowAddStudentDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Student</DialogTitle>
            <DialogDescription>
              Add a new student to the roster. Enter their ID, optional name,
              and select their cohort.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Student ID *</label>
              <Input
                placeholder="Enter student ID"
                value={addStudentId}
                onChange={(e) => setAddStudentId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Name (optional)</label>
              <Input
                placeholder="Enter student name"
                value={addStudentName}
                onChange={(e) => setAddStudentName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Cohort *</label>
              <Select
                value={addStudentCohort}
                onValueChange={(value) =>
                  setAddStudentCohort(value as "A" | "B" | "C")
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select cohort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Cohort A</SelectItem>
                  <SelectItem value="B">Cohort B</SelectItem>
                  <SelectItem value="C">Cohort C</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowAddStudentDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleAddStudent}>Add Student</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Student Dialog */}
      <Dialog
        open={showRemoveStudentDialog}
        onOpenChange={setShowRemoveStudentDialog}
      >
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Remove Student</DialogTitle>
            <DialogDescription>
              Search for a student by name or ID and remove them from the
              roster. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Search Student</label>
              <Input
                placeholder="Search by student ID or name..."
                value={removeSearchQuery}
                onChange={(e) => {
                  setRemoveSearchQuery(e.target.value);
                  setStudentToRemove(null);
                }}
              />
            </div>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {filteredRosterForRemoval.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  No students found.
                </p>
              ) : (
                filteredRosterForRemoval.map((student) => (
                  <div
                    key={student.student_id}
                    className={cn(
                      "flex items-center justify-between p-2 rounded-lg cursor-pointer border transition-colors",
                      studentToRemove?.student_id === student.student_id
                        ? "bg-destructive/10 border-destructive/40"
                        : "bg-muted/50 border-transparent hover:bg-muted",
                    )}
                    onClick={() =>
                      setStudentToRemove({
                        student_id: student.student_id,
                        cohort: student.cohort as "A" | "B" | "C",
                        name: student.name,
                      })
                    }
                  >
                    <div className="flex flex-col">
                      <div className="flex items-center space-x-2">
                        <span className="font-medium">
                          {student.student_id}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          Cohort {student.cohort}
                        </Badge>
                      </div>
                      {student.name && (
                        <span className="text-sm text-muted-foreground mt-1">
                          {student.name}
                        </span>
                      )}
                    </div>
                    {studentToRemove?.student_id === student.student_id && (
                      <Badge variant="destructive" className="text-xs">
                        Selected
                      </Badge>
                    )}
                  </div>
                ))
              )}
            </div>

            {studentToRemove && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive">
                  Are you sure you want to remove{" "}
                  <strong>{studentToRemove.student_id}</strong>
                  {studentToRemove.name
                    ? ` (${studentToRemove.name})`
                    : ""}{" "}
                  from the roster? This cannot be undone.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowRemoveStudentDialog(false);
                setRemoveSearchQuery("");
                setStudentToRemove(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemoveStudent}
              disabled={!studentToRemove}
            >
              <UserMinus className="h-4 w-4 mr-2" />
              Remove Student
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Weekly Absences Dialog */}
      <Dialog
        open={showWeeklyAbsenceDialog}
        onOpenChange={setShowWeeklyAbsenceDialog}
      >
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Weekly Absences</DialogTitle>
            <DialogDescription>
              Pick any date to see who was absent that week (Tue/Wed/Thu only).
              Students are sorted by number of absences.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[240px] justify-start text-left font-normal",
                      !weeklyAbsenceDate && "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {weeklyAbsenceDate
                      ? format(weeklyAbsenceDate, "PPP")
                      : "Select a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={weeklyAbsenceDate}
                    onSelect={(date) => {
                      setWeeklyAbsenceDate(date);
                      if (date) {
                        loadWeeklyAbsences(date);
                      }
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>

              <Select
                value={weeklyAbsenceCohortFilter}
                onValueChange={setWeeklyAbsenceCohortFilter}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cohorts</SelectItem>
                  <SelectItem value="a">Cohort A</SelectItem>
                  <SelectItem value="b">Cohort B</SelectItem>
                  <SelectItem value="c">Cohort C</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {weeklyAbsenceDate && (
              <div className="text-sm text-muted-foreground">
                Showing week of{" "}
                <strong>
                  {format(getMonday(weeklyAbsenceDate), "MMM dd")}
                </strong>{" "}
                –{" "}
                <strong>
                  {format(
                    (() => {
                      const fri = getMonday(weeklyAbsenceDate);
                      fri.setDate(fri.getDate() + 4);
                      return fri;
                    })(),
                    "MMM dd, yyyy",
                  )}
                </strong>
              </div>
            )}

            {isLoadingWeeklyAbsences ? (
              <p className="text-center text-muted-foreground py-8">Loading…</p>
            ) : !weeklyAbsenceDate ? (
              <p className="text-center text-muted-foreground py-8">
                Pick a date to view weekly absences.
              </p>
            ) : filteredWeeklyAbsences.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No absences found for this week. 🎉
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_80px_80px_1fr] gap-2 font-semibold text-sm border-b pb-2">
                  <div>Student</div>
                  <div>Cohort</div>
                  <div className="text-center">Missed</div>
                  <div>Absent Days</div>
                </div>
                {filteredWeeklyAbsences.map((absence) => (
                  <div
                    key={absence.student_id}
                    className="grid grid-cols-[1fr_80px_80px_1fr] gap-2 p-2 bg-muted/50 rounded-lg text-sm items-center"
                  >
                    <div>
                      <span className="font-medium">{absence.student_id}</span>
                      {absence.name && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          {absence.name}
                        </span>
                      )}
                    </div>
                    <div>
                      <Badge variant="outline">Cohort {absence.cohort}</Badge>
                    </div>
                    <div className="text-center">
                      <Badge
                        variant={
                          absence.frequency >= 3
                            ? "destructive"
                            : absence.frequency === 2
                              ? "default"
                              : "secondary"
                        }
                      >
                        {absence.frequency}/3
                      </Badge>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {absence.absentDays.map((d) => {
                        const dayDate = new Date(d + "T00:00:00");
                        const dayName = [
                          "Sun",
                          "Mon",
                          "Tue",
                          "Wed",
                          "Thu",
                          "Fri",
                          "Sat",
                        ][dayDate.getDay()];
                        return (
                          <Badge key={d} variant="outline" className="text-xs">
                            {dayName} {format(dayDate, "MMM dd")}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="pt-2 border-t text-sm text-muted-foreground">
                  Total: {filteredWeeklyAbsences.length} student
                  {filteredWeeklyAbsences.length !== 1 ? "s" : ""} with absences
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowWeeklyAbsenceDialog(false);
                setWeeklyAbsenceDate(undefined);
                setWeeklyAbsences([]);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TADashboard;
