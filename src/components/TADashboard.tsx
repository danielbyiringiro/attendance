import { useCallback, useEffect, useMemo, useState } from "react";
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
  CalendarCheck,
  Flag,
  Copy,
  ChevronDown,
  ChevronRight,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import AttendanceExportDialog from "@/components/AttendanceExportDialog";
import AbsenceHistoryDialog from "@/components/ta/AbsenceHistoryDialog";
import Classes from "@/components/ta/sections/Classes";
import Schedule from "@/components/ta/sections/Schedule";
import Sessions from "@/components/ta/sections/Sessions";
import SessionActions from "@/components/ta/SessionActions";
import SessionRosterDialog from "@/components/ta/SessionRosterDialog";
import ThemeToggle from "@/components/ThemeToggle";
import StudentRoster from "@/components/ta/StudentRoster";
import { useActiveClass } from "@/lib/classContext";
import {
  dropEnrolment,
  listEnrolments,
  upsertEnrolments,
} from "@/lib/api/enrolment";
import {
  attendanceLog,
  isAbsentState,
  isPresentState,
  setAttendanceState,
  type AttendanceLog,
} from "@/lib/api/attendance";
import { listTodaySessions } from "@/lib/api/sessions";
import type { SessionRow } from "@/lib/api/types";
import {
  addDays,
  fromDateStr,
  mondayOf,
  toDateStr,
  todayStr,
  weekKeyOf,
} from "@/lib/dates";

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
  activeSection?:
    | "attendance"
    | "analytics"
    | "students"
    | "sessions"
    | "schedule"
    | "classes";
  onLogout: () => void;
}

interface WeeklyAbsence {
  student_id: string;
  cohort: string;
  name?: string;
  absentDays: string[]; // YYYY-MM-DD dates they were absent
  frequency: number;
}

interface WeekReport {
  weekNumber: number;
  startStr: string; // Monday (YYYY-MM-DD)
  rangeLabel: string; // e.g. "Jan 27 – Jan 29"
  absences: WeeklyAbsence[]; // sorted by frequency desc
}

interface FlaggedRecord {
  id: string;
  student_id: string;
  session_date: string;
  status: string;
  created_at: string;
  /** Added by migration 016. A flag belongs to one class. */
  class_id: string | null;
  session_id: string | null;
}

const TADashboard = ({
  activeSection = "attendance",
  onLogout,
}: TADashboardProps) => {
  const [selectedCohort, setSelectedCohort] = useState("all");
  const { toast } = useToast();

  // The roster is the active class's enrolments, not every student in the
  // database. It used to arrive as a prop from Index.tsx, which selected the
  // whole `students` table — so every screen below showed the same people
  // regardless of which class was picked in the sidebar.
  const { activeClass, activeClassId, cohorts } = useActiveClass();
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [isRosterLoading, setIsRosterLoading] = useState(false);

  // Today's sessions and who is marked present at them.
  //
  // This arrived as a prop from Index.tsx, read out of present_students for
  // "today" across every class at once. It is now the attendance recorded
  // against this class's sessions today — which is the same thing the roster,
  // the analytics and the exporter count.
  const [todaySessions, setTodaySessions] = useState<SessionRow[]>([]);
  // Which session's roster is open — "who is missing" is the question a TA has
  // mid-class, and the count alone does not answer it.
  const [rosterFor, setRosterFor] = useState<SessionRow | null>(null);
  const [presentStudents, setPresentStudents] = useState<Student[]>([]);

  const loadToday = useCallback(async () => {
    if (!activeClassId) {
      setTodaySessions([]);
      setPresentStudents([]);
      return;
    }
    try {
      const sessions = await listTodaySessions(activeClassId);
      setTodaySessions(sessions);

      const today = todayStr();
      const log = await attendanceLog(activeClassId, { from: today, to: today });
      setPresentStudents(
        log.marks
          .filter((m) => isPresentState(m.state))
          .map((m) => ({
            id: m.student_id,
            cohort: m.cohort_label,
            timestamp: m.marked_at ? new Date(m.marked_at) : new Date(),
          })),
      );
    } catch (e) {
      console.error("Could not load today's sessions:", e);
      setTodaySessions([]);
      setPresentStudents([]);
    }
  }, [activeClassId]);

  useEffect(() => {
    void loadToday();
  }, [loadToday]);

  const loadRoster = useCallback(async () => {
    if (!activeClassId) {
      setRoster([]);
      return;
    }
    setIsRosterLoading(true);
    try {
      const rows = await listEnrolments(activeClassId);
      setRoster(
        rows.map((r) => ({
          student_id: r.student_id,
          cohort: r.cohort_label,
          name: r.name ?? undefined,
        })),
      );
    } catch (e) {
      console.error("Failed to load the roster:", e);
      toast({
        title: "Could not load the roster",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setRoster([]);
    } finally {
      setIsRosterLoading(false);
    }
  }, [activeClassId, toast]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const cohortIdByLabel = new Map(cohorts.map((c) => [c.label, c.id]));
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  // "day" answers "who missed this session"; "student" answers "who is missing
  // too many", which is a different question and needs the whole term.

  // Weekly absence search state
  const [showWeeklyAbsenceDialog, setShowWeeklyAbsenceDialog] = useState(false);
  const [weeklyAbsenceDate, setWeeklyAbsenceDate] = useState<Date | undefined>(
    undefined,
  );
  const [weeklyAbsences, setWeeklyAbsences] = useState<WeeklyAbsence[]>([]);
  const [isLoadingWeeklyAbsences, setIsLoadingWeeklyAbsences] = useState(false);
  const [weeklyAbsenceCohortFilter, setWeeklyAbsenceCohortFilter] =
    useState("all");

  // Weekly report (week-by-week, copy-paste rows for the spreadsheet)
  const [weeklyReport, setWeeklyReport] = useState<WeekReport[]>([]);
  const [isBuildingReport, setIsBuildingReport] = useState(false);
  // Lecturer (instructor) + FI are configured per cohort.
  const [reportPairs, setReportPairs] = useState<
    Record<string, { instructor: string; fi: string }>
  >({
    A: { instructor: "", fi: "" },
    B: { instructor: "", fi: "" },
    C: { instructor: "", fi: "" },
  });
  const [expandedWeeks, setExpandedWeeks] = useState<Set<number>>(new Set());

  // Add/Remove student state
  const [showAddStudentDialog, setShowAddStudentDialog] = useState(false);
  const [addStudentId, setAddStudentId] = useState("");
  const [addStudentName, setAddStudentName] = useState("");
  // A cohort label of the active class, not one of three fixed letters.
  const [addStudentCohort, setAddStudentCohort] = useState("");
  const [showRemoveStudentDialog, setShowRemoveStudentDialog] = useState(false);
  const [removeSearchQuery, setRemoveSearchQuery] = useState("");
  const [studentToRemove, setStudentToRemove] = useState<{
    student_id: string;
    cohort: "A" | "B" | "C";
    name?: string;
  } | null>(null);

  // Attendance CSV export (date range + cohort/student scope).
  const [showExportDialog, setShowExportDialog] = useState(false);

  const [showFlaggedDialog, setShowFlaggedDialog] = useState(false);
  const [flaggedRecords, setFlaggedRecords] = useState<FlaggedRecord[]>([]);
  const [isLoadingFlagged, setIsLoadingFlagged] = useState(false);

  // Excused absence ("absent with permission") state
  const [showExcusedDialog, setShowExcusedDialog] = useState(false);
  const [excusedSearchQuery, setExcusedSearchQuery] = useState("");
  const [excusedStudent, setExcusedStudent] = useState<{
    student_id: string;
    cohort: "A" | "B" | "C" | string;
    name?: string;
  } | null>(null);
  const [excusedStartDate, setExcusedStartDate] = useState<Date | undefined>(
    undefined,
  );
  const [excusedEndDate, setExcusedEndDate] = useState<Date | undefined>(
    undefined,
  );
  const [excusedReason, setExcusedReason] = useState("");
  const [isSavingExcused, setIsSavingExcused] = useState(false);

  const allStudents = roster.map((r) => r.student_id);
  const rosterIds = new Set(allStudents);
  /**
   * Which cohort a student is in, from their enrolment.
   *
   * This replaces inferCohort, which guessed by looking for the letters A, B
   * or C anywhere in the student ID — so it put every ID containing an "A"
   * into cohort A and everyone else into C. It was only ever reachable when
   * the roster lookup failed, and the roster is now the class's enrolments,
   * where the cohort is a fact rather than a guess.
   */
  const cohortOf = (studentId: string): string =>
    roster.find((r) => r.student_id === studentId)?.cohort ?? "";


  // Only this class's disputes.
  //
  // This selected every flagged row in the database. RLS on `flagged` did not
  // exist until migration 016, so one class's disputes appeared in another's —
  // and because the student's NAME is looked up in the roster of the class
  // being viewed, it came back empty while their ID rendered anyway. A TA saw
  // a bare student number belonging to a class that was not theirs.
  const loadFlaggedRecords = async () => {
    if (!activeClassId) {
      setFlaggedRecords([]);
      return;
    }
    setIsLoadingFlagged(true);
    const { data, error } = await supabase
      .from("flagged")
      .select("*")
      .eq("class_id", activeClassId)
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
      // Accepting a flag marks the student present at the session they say they
      // attended. This used to insert a present_students row timestamped noon
      // UTC "to ensure UTC mapping matches date" — a fudge that existed because
      // the day a check-in belonged to was inferred from its timestamp. The
      // session owns its date now, so the mark attaches to the session.
      if (resolution === "accepted") {
        if (!activeClassId) throw new Error("No class selected.");
        const log = await attendanceLog(activeClassId, {
          from: record.session_date,
          to: record.session_date,
          cohortId: cohortIdByLabel.get(cohortOf(record.student_id)),
        });
        const session = log.sessions.find((sn) => sn.status !== "cancelled");
        if (!session) {
          throw new Error(
            `No session on ${record.session_date} for that student's cohort.`,
          );
        }
        await setAttendanceState(
          session.session_id,
          record.student_id,
          "present",
        );
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

  // Only count students who are actually on the roster, and never count the same
  // student twice. This guarantees "present" can never exceed total enrolled even
  // if the attendance table contains duplicates or records for removed students.
  const validPresentStudents = Array.from(
    new Map(
      presentStudents.filter((s) => rosterIds.has(s.id)).map((s) => [s.id, s]),
    ).values(),
  );

  const filteredPresentStudents =
    selectedCohort === "all"
      ? validPresentStudents
      : validPresentStudents.filter(
          (student) => student.cohort === selectedCohort,
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
          const cohort = rosterEntry ? rosterEntry.cohort : cohortOf(id);
          return cohort === selectedCohort;
        });

  // One tally per cohort the class actually has. These were three hardcoded
  // A/B/C pairs, which is why a class with four cohorts could not be counted.
  const cohortTallies = cohorts.map((co) => ({
    id: co.id,
    label: co.label,
    present: validPresentStudents.filter((s) => s.cohort === co.label).length,
    total: roster.filter((r) => r.cohort === co.label).length,
  }));

  // Per-cohort report settings (lecturer + FI), for the active class.
  //
  // report_settings had `cohort` as its PRIMARY KEY, so two classes could
  // never both have a Cohort A — they shared one row and overwrote each
  // other's instructor names. cohort_report_settings, which migration 005
  // built and nothing has read until now, is keyed by cohort_id.
  useEffect(() => {
    if (!activeClassId) return;
    (async () => {
      const { data, error } = await supabase
        .from("cohort_report_settings")
        .select("cohort_id, instructor_name, fi_name, cohorts(label)")
        .eq("class_id", activeClassId);
      if (error) {
        console.error("Failed to load report settings:", error);
        return;
      }
      setReportPairs(
        Object.fromEntries(
          ((data ?? []) as unknown as Array<{
            instructor_name: string;
            fi_name: string;
            cohorts: { label: string } | null;
          }>)
            .filter((row) => row.cohorts !== null)
            .map((row) => [
              row.cohorts!.label,
              {
                instructor: row.instructor_name || "",
                fi: row.fi_name || "",
              },
            ]),
        ),
      );
    })();
  }, [activeClassId]);

  // Enrol a student in the active class.
  //
  // This used to INSERT into `students`, which is the global person registry:
  // adding someone to one class made them appear in every class, and a student
  // taking two courses collided on the primary key. It now goes through
  // upsert_enrolments, which reuses an existing student row and only creates
  // the enrolment.
  const handleAddStudent = async () => {
    if (!activeClassId) {
      toast({
        title: "No class selected",
        description: "Choose a class in the sidebar first.",
        variant: "destructive",
      });
      return;
    }
    if (!addStudentId.trim()) {
      toast({
        title: "Student ID Required",
        description: "Please enter a student ID.",
        variant: "destructive",
      });
      return;
    }
    const cohortId = cohortIdByLabel.get(addStudentCohort);
    if (!cohortId) {
      toast({
        title: "Cohort Required",
        description: "Please select a cohort for the student.",
        variant: "destructive",
      });
      return;
    }

    const existing = roster.find(
      (r) => r.student_id.toLowerCase() === addStudentId.trim().toLowerCase(),
    );
    if (existing) {
      toast({
        title: "Student Already Exists",
        description: `Student ${addStudentId.trim()} is already in this class (Cohort ${existing.cohort}).`,
        variant: "destructive",
      });
      return;
    }

    try {
      const result = await upsertEnrolments(cohortId, [
        {
          student_id: addStudentId.trim(),
          name: addStudentName.trim() || null,
        },
      ]);

      if (result.invalid.length > 0) {
        toast({
          title: "Not added",
          description: result.invalid[0].reason,
          variant: "destructive",
        });
        return;
      }

      await loadRoster();
      toast({
        title: "Student Added",
        description:
          result.reused_students > 0
            ? `${addStudentId.trim()} was already known to the system and is now enrolled in Cohort ${addStudentCohort}.`
            : `${addStudentId.trim()}${addStudentName.trim() ? ` (${addStudentName.trim()})` : ""} added to Cohort ${addStudentCohort}.`,
      });
    } catch (e) {
      console.error("Failed to add student:", e);
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : "Failed to add student.",
        variant: "destructive",
      });
      return;
    }

    setAddStudentId("");
    setAddStudentName("");
    setAddStudentCohort("");
    setShowAddStudentDialog(false);
  };

  // Take a student off this class's roster.
  //
  // A drop, not a delete: the student row is global and their past attendance
  // has to survive. Deleting the `students` row, as this did before, removed
  // them from every other class too.
  const handleRemoveStudent = async () => {
    if (!activeClassId || !studentToRemove) {
      toast({
        title: "No Student Selected",
        description: "Please select a student to remove.",
        variant: "destructive",
      });
      return;
    }

    try {
      await dropEnrolment(activeClassId, studentToRemove.student_id);
    } catch (e) {
      console.error("Failed to remove student:", e);
      toast({
        title: "Error",
        description:
          e instanceof Error ? e.message : "Failed to remove student.",
        variant: "destructive",
      });
      return;
    }

    await loadRoster();
    toast({
      title: "Student Removed",
      description: `${studentToRemove.student_id}${studentToRemove.name ? ` (${studentToRemove.name})` : ""} is no longer on this class's roster. Their record of past sessions is kept.`,
    });

    setStudentToRemove(null);
    setRemoveSearchQuery("");
    setShowRemoveStudentDialog(false);
  };

  // Excuse a student from the sessions their cohort actually has in a range.
  //
  // This used to expand the range with the Tue/Wed/Thu rule and write a row per
  // date into excused_absences, which meant excusing someone for days their
  // cohort never met, and missing any session the rule did not predict. It now
  // sets state on the sessions that exist. The database trigger logs each
  // change to attendance_corrections.
  const handleAddExcused = async () => {
    if (!activeClassId) return;
    if (!excusedStudent) {
      toast({
        title: "No Student Selected",
        description: "Please select a student first.",
        variant: "destructive",
      });
      return;
    }
    if (!excusedStartDate || !excusedEndDate) {
      toast({
        title: "Dates Required",
        description: "Please choose both a start and end date.",
        variant: "destructive",
      });
      return;
    }
    if (excusedEndDate < excusedStartDate) {
      toast({
        title: "Invalid Range",
        description: "The end date can't be before the start date.",
        variant: "destructive",
      });
      return;
    }

    setIsSavingExcused(true);
    try {
      const cohortId = cohortIdByLabel.get(
        roster.find((r) => r.student_id === excusedStudent.student_id)?.cohort ??
          "",
      );
      const log = await attendanceLog(activeClassId, {
        from: toDateStr(excusedStartDate),
        to: toDateStr(excusedEndDate),
        cohortId,
      });

      const sessions = log.sessions.filter((sn) => sn.status !== "cancelled");
      if (sessions.length === 0) {
        toast({
          title: "No Sessions",
          description:
            "That range contains no sessions for this student's cohort.",
          variant: "destructive",
        });
        return;
      }

      for (const sn of sessions) {
        await setAttendanceState(
          sn.session_id,
          excusedStudent.student_id,
          "excused",
        );
      }

      toast({
        title: "Excused Absence Saved",
        description: `${excusedStudent.student_id}${excusedStudent.name ? ` (${excusedStudent.name})` : ""} excused for ${sessions.length} session${sessions.length > 1 ? "s" : ""}.`,
      });

      setShowExcusedDialog(false);
      setExcusedStudent(null);
      setExcusedSearchQuery("");
      setExcusedStartDate(undefined);
      setExcusedEndDate(undefined);
      setExcusedReason("");
    } catch (e) {
      console.error("Failed to save excused absence:", e);
      toast({
        title: "Error",
        description:
          e instanceof Error ? e.message : "Failed to save the excused absence.",
        variant: "destructive",
      });
    } finally {
      setIsSavingExcused(false);
    }
  };

  // Absences in the week containing `date`, read rather than reconstructed.
  //
  // This used to walk Monday to Friday, ask a hardcoded Tue/Wed/Thu rule
  // whether each day was a class day, then treat any student without a
  // check-in as absent. Which days ran is now a fact about the cohort's
  // sessions, and so is who missed them.
  const loadWeeklyAbsences = async (date: Date) => {
    if (!activeClassId) return;
    setIsLoadingWeeklyAbsences(true);
    setWeeklyAbsences([]);
    try {
      const monday = mondayOf(date);
      const log = await attendanceLog(activeClassId, {
        from: toDateStr(monday),
        to: toDateStr(addDays(monday, 4)),
      });

      const byStudent = new Map<string, WeeklyAbsence>();
      log.marks.filter((m) => isAbsentState(m.state)).forEach((m) => {
        const entry = byStudent.get(m.student_id);
        if (entry) {
          entry.absentDays.push(m.session_date);
          entry.frequency += 1;
          return;
        }
        byStudent.set(m.student_id, {
          student_id: m.student_id,
          cohort: m.cohort_label,
          name: roster.find((r) => r.student_id === m.student_id)?.name,
          absentDays: [m.session_date],
          frequency: 1,
        });
      });

      setWeeklyAbsences(
        [...byStudent.values()].sort((a, b) => b.frequency - a.frequency),
      );
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
          (a) => a.cohort === weeklyAbsenceCohortFilter,
        );

  // Build the full week-by-week report from the semester start through today.
  // One fetch, computed client-side per week (excludes cancelled + excused days).
  // The week-by-week report, grouped off the sessions that actually ran.
  //
  // The previous version stepped through the term a day at a time applying a
  // fixed Tue/Wed/Thu rule, and treated a cancellation as cancelling that day
  // for every cohort — cancelled_sessions has a cohort column it ignored. A
  // session belongs to one cohort, so grouping its marks cannot make that
  // mistake.
  const buildWeeklyReport = async () => {
    if (!activeClassId) return;
    setIsBuildingReport(true);
    setWeeklyReport([]);
    try {
      const log = await attendanceLog(activeClassId, { to: todayStr() });

      // Which weeks ran at all, so a week with sessions but no absences still
      // appears — an empty week is a result, not a gap.
      const weeks = new Map<string, Set<string>>();
      log.sessions
        .filter((sn) => sn.status !== "cancelled")
        .forEach((sn) => {
          const key = weekKeyOf(sn.session_date);
          const days = weeks.get(key);
          if (days) days.add(sn.session_date);
          else weeks.set(key, new Set([sn.session_date]));
        });

      const absencesByWeek = new Map<string, Map<string, WeeklyAbsence>>();
      log.marks.filter((m) => isAbsentState(m.state)).forEach((m) => {
        const key = weekKeyOf(m.session_date);
        let forWeek = absencesByWeek.get(key);
        if (!forWeek) {
          forWeek = new Map();
          absencesByWeek.set(key, forWeek);
        }
        const entry = forWeek.get(m.student_id);
        if (entry) {
          entry.absentDays.push(m.session_date);
          entry.frequency += 1;
          return;
        }
        forWeek.set(m.student_id, {
          student_id: m.student_id,
          cohort: m.cohort_label,
          name: roster.find((r) => r.student_id === m.student_id)?.name,
          absentDays: [m.session_date],
          frequency: 1,
        });
      });

      const report: WeekReport[] = [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, dayStrings], index) => {
          const days = [...dayStrings].sort();
          const first = fromDateStr(days[0]);
          const last = fromDateStr(days[days.length - 1]);
          return {
            weekNumber: index + 1,
            startStr: weekStart,
            rangeLabel:
              days.length === 1
                ? format(first, "MMM dd")
                : `${format(first, "MMM dd")} – ${format(last, "MMM dd")}`,
            absences: [...(absencesByWeek.get(weekStart)?.values() ?? [])].sort(
              (a, b) => b.frequency - a.frequency,
            ),
          };
        });

      setWeeklyReport(report);
    } catch (error) {
      console.error("Error building weekly report:", error);
    } finally {
      setIsBuildingReport(false);
    }
  };

  // Last 4 characters of the student ID = year group.
  const yearGroupOf = (studentId: string) => studentId.slice(-4);

  // Build the tab-separated block for a week (pastes into Excel columns
  // Student's Name → Feedback). Respects the cohort filter.
  const buildWeekTSV = (week: WeekReport) => {
    const rows = week.absences.filter(
      (a) =>
        // Only students absent twice or thrice are reported.
        a.frequency >= 2 &&
        (weeklyAbsenceCohortFilter === "all" ||
          a.cohort === weeklyAbsenceCohortFilter),
    );
    return rows
      .map((a) => {
        const pair = reportPairs[a.cohort] || { instructor: "", fi: "" };
        // Feedback only for students absent twice or thrice in the week.
        const feedback =
          a.frequency >= 2 ? `Was absent for ${a.frequency} days` : "";
        return [
          a.name || a.student_id,
          yearGroupOf(a.student_id),
          a.cohort,
          pair.instructor,
          pair.fi,
          feedback,
        ].join("\t");
      })
      .join("\n");
  };

  const handleCopyWeek = async (week: WeekReport) => {
    const tsv = buildWeekTSV(week);
    if (!tsv) {
      toast({
        title: "Nothing to copy",
        description: `No absences for Week ${week.weekNumber}.`,
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(tsv);
      toast({
        title: "Copied",
        description: `Week ${week.weekNumber} rows copied — paste into the Student's Name column.`,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  };

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

  /**
   * Mark a student present, by hand, at today's session for their cohort.
   *
   * This used to insert straight into present_students — the legacy table —
   * so pressing Mark produced a success toast and changed nothing anyone could
   * see: the roster, the analytics and the exporter all count
   * attendance_records. It writes a real record now, and the correction
   * trigger logs it when it replaces an existing state.
   */
  const handleMarkAttendanceManually = async (
    studentId: string,
    cohort: string,
  ) => {
    const cohortId = cohortIdByLabel.get(cohort);
    const session = todaySessions.find(
      (sn) => sn.cohort_id === cohortId && sn.status !== "cancelled",
    );

    if (!session) {
      toast({
        title: "No session today",
        description: `Cohort ${cohort} has no session today to mark them at. Create one under Schedule, or open the right day under Class Sessions.`,
        variant: "destructive",
      });
      return;
    }

    try {
      await setAttendanceState(session.id, studentId, "present");
      toast({
        title: "Marked present",
        description: `${studentId} is present at today's cohort ${cohort} session.`,
      });
      await loadToday();
    } catch (e) {
      toast({
        title: "Could not mark them present",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    }
  };

  // Absences across the class, or on one day.
  //
  // Was ~190 lines that rebuilt the term day by day from four tables, guessing
  // which days were class days from a fixed weekday rule plus "somebody checked
  // in, so it must have happened". An absence is a stored row now, so this
  // filters rather than infers. searchStudent below was a copy of that same
  // loop, 140 of 180 lines identical, and had already drifted from it.
  const isAttendanceSection = activeSection === "attendance";
  const isAnalyticsSection = activeSection === "analytics";
  const isStudentsSection = activeSection === "students";
  const isSessionsSection = activeSection === "sessions";
  const isScheduleSection = activeSection === "schedule";
  const isClassesSection = activeSection === "classes";
  // A lookup rather than a five-deep ternary: adding a section to the nested
  // version meant threading a branch into two of them and leaving a dead arm
  // behind, which is exactly what happened.
  const SECTION_COPY: Record<string, { title: string; description: string }> = {
    classes: {
      title: "Classes",
      description: "Create a class, set its cohorts, and choose who can manage it",
    },
    sessions: {
      title: "Class Sessions",
      description: "Open, close, move or cancel a session",
    },
    schedule: {
      title: "Schedule",
      description: "Set when each cohort meets",
    },
    analytics: {
      title: "Attendance Analytics",
      description: "Review attendance trends, absences, and flagged records",
    },
    students: {
      title: "Student Management",
      description: "Search the roster and manage student records",
    },
    attendance: {
      title: "TA Dashboard",
      description: "Manage live attendance and monitor student participation",
    },
  };
  const { title: sectionTitle, description: sectionDescription } =
    SECTION_COPY[activeSection] ?? SECTION_COPY.attendance;

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
                {activeClass && (
                  <span className="ml-2 opacity-70">· {activeClass.name}</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button onClick={onLogout} variant="outline">
              Logout
            </Button>
          </div>
        </div>

        {/* Every count below is of one class's roster, so say when there isn't
            one and when it is still arriving — an empty roster otherwise reads
            as a class where everybody is absent. */}
        {!isClassesSection && !isScheduleSection && !isSessionsSection && !activeClass && (
          <Card className="border-2 border-dashed">
            <CardContent className="pt-6 text-center">
              <p className="font-medium">No class selected</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose one in the sidebar, or create one under Classes.
              </p>
            </CardContent>
          </Card>
        )}
        {!isClassesSection && !isScheduleSection && !isSessionsSection && activeClass && isRosterLoading && (
          <p className="text-sm text-muted-foreground">Loading the roster…</p>
        )}

        {/* Classes and Class Sessions replace the body rather than sitting
            beside it: everything below is scoped to one class, and these are
            the screens that choose and shape that class. */}
        {isClassesSection && <Classes />}
        {isSessionsSection && <Sessions />}
        {isScheduleSection && <Schedule />}

        {isAnalyticsSection && (
          <>
            {/* Stats Overview */}
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
            >
              <Card className="border-2 border-success/30 bg-success/5 shadow-soft">
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

              <Card className="border-2 border-destructive/30 bg-destructive/5 shadow-soft">
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

              {cohortTallies.map((c) => (
                <Card key={c.id} className="border-2 border-primary/25 bg-gradient-card shadow-soft">
                  <CardContent className="pt-6">
                    <div className="flex items-center space-x-2">
                      <Users className="h-5 w-5 text-primary" />
                      <div>
                        <p className="text-2xl font-bold">
                          {c.present}/{c.total}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Cohort {c.label}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Per-student standing. Was reachable only by opening a dialog,
                typing a name and pressing a button, which could not show you
                the class. */}
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="text-base">Students</CardTitle>
              </CardHeader>
              <CardContent>
                {activeClass && (
                  <StudentRoster
                    classId={activeClass.id}
                    cohorts={cohorts}
                    roster={roster}
                    presentIds={new Set(validPresentStudents.map((p) => p.id))}
                    minAttendancePercentage={
                      activeClass.min_attendance_percentage
                    }
                  />
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* Action Buttons */}
        {(isAnalyticsSection || isStudentsSection) && (
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
                    setWeeklyAbsenceCohortFilter("all");
                    buildWeeklyReport();
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
                <Button
                  onClick={() => setShowExportDialog(true)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <Download className="h-4 w-4" />
                  Export Attendance
                </Button>
              </>
            )}
            {isStudentsSection && (
              <>
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
                <Button
                  onClick={() => {
                    setShowExcusedDialog(true);
                    setExcusedSearchQuery("");
                    setExcusedStudent(null);
                    setExcusedStartDate(undefined);
                    setExcusedEndDate(undefined);
                    setExcusedReason("");
                  }}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <CalendarCheck className="h-4 w-4" />
                  Excused Absence
                </Button>
              </>
            )}
          </div>
        )}

        {/* Students: the whole class, filtered as you type. */}
        {isStudentsSection && activeClass && (
          <Card className="border-2 shadow-medium">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                {roster.length} student{roster.length === 1 ? "" : "s"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StudentRoster
                classId={activeClass.id}
                cohorts={cohorts}
                roster={roster}
                presentIds={new Set(validPresentStudents.map((p) => p.id))}
                onMarkPresent={handleMarkAttendanceManually}
                minAttendancePercentage={activeClass.min_attendance_percentage}
              />
            </CardContent>
          </Card>
        )}

        {/* Controls and today's lists */}
        {isAttendanceSection && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Today's sessions: the PIN each one actually issued, and the
                one button that applies. This was a single PIN box backed by
                the session_state singleton — one PIN, one timer, for the whole
                installation — with no relationship to the per-session PIN
                open_session hands out and mark_attendance resolves. */}
            {isAttendanceSection && (
              <Card className="border-2 shadow-medium">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="flex items-center gap-2">
                    <Timer className="h-5 w-5" />
                    Today
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={loadToday}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {todaySessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No session today for this class. Schedule sets which days
                      it meets; Class Sessions has every other day.
                    </p>
                  ) : (
                    todaySessions.map((sn) => {
                      const label =
                        cohorts.find((c) => c.id === sn.cohort_id)?.label ?? "?";
                      const here = validPresentStudents.filter(
                        (p) => p.cohort === label,
                      ).length;
                      const enrolled = roster.filter(
                        (r) => r.cohort === label,
                      ).length;

                      return (
                        <div
                          key={sn.id}
                          className={`space-y-2 rounded-lg p-3 transition-colors ${
                            sn.status === "open"
                              ? "border-2 border-success/40 bg-success/5 shadow-soft"
                              : "border bg-card"
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">Cohort {label}</Badge>
                            <Badge
                              variant={
                                sn.status === "open" ? "default" : "secondary"
                              }
                            >
                              {sn.status}
                            </Badge>
                            <button
                              type="button"
                              className="ml-auto rounded px-1.5 py-0.5 text-sm tabular-nums text-muted-foreground underline-offset-2 hover:bg-muted hover:underline"
                              title="Who is here, and who is not"
                              onClick={() => setRosterFor(sn)}
                            >
                              {here}/{enrolled} here
                            </button>
                          </div>

                          {sn.status === "open" && sn.pin && (
                            <>
                              <p className="rounded-lg bg-gradient-primary py-2 text-center font-mono text-3xl font-bold tracking-[0.3em] text-primary-foreground shadow-soft">
                                {sn.pin}
                              </p>
                              <p className="text-center text-xs text-muted-foreground">
                                Check-in closes {sn.auto_close_minutes} minutes
                                after it opened.
                              </p>
                            </>
                          )}

                          {sn.status === "closed" && (
                            <p className="text-xs text-muted-foreground">
                              Closed — anyone who did not mark is recorded
                              absent. Reopening does not undo that; their state
                              changes when they check in.
                            </p>
                          )}

                          {sn.status === "cancelled" && (
                            <p className="text-xs text-muted-foreground">
                              Cancelled
                              {sn.cancellation_reason
                                ? ` — ${sn.cancellation_reason}`
                                : "."}
                            </p>
                          )}

                          <SessionActions
                            session={sn}
                            onChanged={loadToday}
                            full
                          />
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            )}

            {/* Today's present and absent */}
            <div className="lg:col-span-2">
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
                          {cohorts.map((co) => (
                            <SelectItem key={co.id} value={co.label}>
                              Cohort {co.label}
                            </SelectItem>
                          ))}
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
                                    {roster.find(
                                      (r) => r.student_id === student.id,
                                    )?.name || "Unknown Student"}
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
                                : cohortOf(studentId);
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
                                      <Badge
                                        variant="outline"
                                        className="text-xs"
                                      >
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
          </div>
        )}
      </div>

      <SessionRosterDialog
        session={rosterFor}
        cohortLabel={
          cohorts.find((c) => c.id === rosterFor?.cohort_id)?.label ?? ""
        }
        onOpenChange={(o) => !o && setRosterFor(null)}
        onChanged={loadToday}
      />

      <AbsenceHistoryDialog
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
        classId={activeClassId}
        classCode={activeClass?.code}
        roster={roster}
      />

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
                          {!student && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              — no longer on this roster
                            </span>
                          )}
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
                  {cohorts.map((co) => (
                    <SelectItem key={co.id} value={co.label}>
                      Cohort {co.label}
                    </SelectItem>
                  ))}
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

      {/* Attendance Export Dialog */}
      <AttendanceExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        roster={roster}
      />

      {/* Excused Absence Dialog */}
      <Dialog open={showExcusedDialog} onOpenChange={setShowExcusedDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Excused Absence</DialogTitle>
            <DialogDescription>
              Mark a student "absent with permission" for a range of class days.
              Excused days are not counted as absences.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Student</label>
              <Input
                placeholder="Search by student ID or name..."
                value={excusedSearchQuery}
                onChange={(e) => {
                  setExcusedSearchQuery(e.target.value);
                  setExcusedStudent(null);
                }}
              />
            </div>

            <div className="space-y-2 max-h-40 overflow-y-auto">
              {(excusedSearchQuery.trim()
                ? roster.filter(
                    (r) =>
                      r.student_id
                        .toLowerCase()
                        .includes(excusedSearchQuery.toLowerCase()) ||
                      (r.name &&
                        r.name
                          .toLowerCase()
                          .includes(excusedSearchQuery.toLowerCase())),
                  )
                : roster
              ).length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  No students found.
                </p>
              ) : (
                (excusedSearchQuery.trim()
                  ? roster.filter(
                      (r) =>
                        r.student_id
                          .toLowerCase()
                          .includes(excusedSearchQuery.toLowerCase()) ||
                        (r.name &&
                          r.name
                            .toLowerCase()
                            .includes(excusedSearchQuery.toLowerCase())),
                    )
                  : roster
                ).map((student) => (
                  <div
                    key={student.student_id}
                    className={cn(
                      "flex items-center justify-between p-2 rounded-lg cursor-pointer border transition-colors",
                      excusedStudent?.student_id === student.student_id
                        ? "bg-primary/10 border-primary/40"
                        : "bg-muted/50 border-transparent hover:bg-muted",
                    )}
                    onClick={() =>
                      setExcusedStudent({
                        student_id: student.student_id,
                        cohort: student.cohort,
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
                    {excusedStudent?.student_id === student.student_id && (
                      <Badge className="text-xs">Selected</Badge>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">Start date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !excusedStartDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {excusedStartDate
                        ? format(excusedStartDate, "PP")
                        : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={excusedStartDate}
                      onSelect={(date) => {
                        setExcusedStartDate(date);
                        if (
                          date &&
                          (!excusedEndDate || excusedEndDate < date)
                        ) {
                          setExcusedEndDate(date);
                        }
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">End date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !excusedEndDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {excusedEndDate
                        ? format(excusedEndDate, "PP")
                        : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={excusedEndDate}
                      onSelect={setExcusedEndDate}
                      disabled={(date) =>
                        excusedStartDate ? date < excusedStartDate : false
                      }
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Reason (optional)</label>
              <Input
                placeholder="e.g. medical, family emergency"
                value={excusedReason}
                onChange={(e) => setExcusedReason(e.target.value)}
              />
            </div>

            {excusedStudent && excusedStartDate && excusedEndDate && (
              <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm text-muted-foreground">
                Excusing <strong>{excusedStudent.student_id}</strong>
                {excusedStudent.name
                  ? ` (${excusedStudent.name})`
                  : ""} from {format(excusedStartDate, "PP")} to{" "}
                {format(excusedEndDate, "PP")} (class days only).
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowExcusedDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddExcused}
              disabled={
                isSavingExcused ||
                !excusedStudent ||
                !excusedStartDate ||
                !excusedEndDate
              }
            >
              <CalendarCheck className="h-4 w-4 mr-2" />
              {isSavingExcused ? "Saving..." : "Save Excused"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Weekly Absences Dialog */}
      <Dialog
        open={showWeeklyAbsenceDialog}
        onOpenChange={setShowWeeklyAbsenceDialog}
      >
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Weekly Absences</DialogTitle>
            <DialogDescription>
              Each week from the semester start. Copy a week's block and paste
              it into the spreadsheet under the Student's Name column — it fills
              Student's Name, Year Group, Cohort, Instructor, FI and Feedback
              (days absent).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* The lecturer and FI names this report pastes are set under
                Classes, next to who can manage the class. They change about
                once a term, and a settings form in the middle of a report is
                a hard place to find them when they are wrong. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Select
                value={weeklyAbsenceCohortFilter}
                onValueChange={setWeeklyAbsenceCohortFilter}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cohorts</SelectItem>
                  {cohorts.map((co) => (
                    <SelectItem key={co.id} value={co.label}>
                      Cohort {co.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <p className="text-xs text-muted-foreground">
                Lecturer and FI come from Classes → the people icon.
              </p>
            </div>

            {isBuildingReport ? (
              <p className="text-center text-muted-foreground py-8">
                Building report…
              </p>
            ) : weeklyReport.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No class weeks found yet.
              </p>
            ) : (
              <div className="space-y-3">
                {/* Most recent week first */}
                {[...weeklyReport].reverse().map((week) => {
                  const tsv = buildWeekTSV(week);
                  const count = tsv ? tsv.split("\n").length : 0;
                  const open = expandedWeeks.has(week.weekNumber);
                  return (
                    <div key={week.weekNumber} className="rounded-lg border">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedWeeks((prev) => {
                            const next = new Set(prev);
                            if (next.has(week.weekNumber)) {
                              next.delete(week.weekNumber);
                            } else {
                              next.add(week.weekNumber);
                            }
                            return next;
                          })
                        }
                        className="w-full flex items-center justify-between gap-2 p-3"
                      >
                        <div className="flex items-center gap-2 text-sm text-left">
                          {open ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="font-semibold">
                            Week {week.weekNumber}
                          </span>
                          <span className="text-muted-foreground">
                            {week.rangeLabel}
                          </span>
                          <span className="text-muted-foreground">
                            · {count} absentee{count !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </button>
                      {open && (
                        <div className="p-3 border-t space-y-2">
                          {count === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              No absences (twice or more) this week. 🎉
                            </p>
                          ) : (
                            <>
                              <div className="flex justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleCopyWeek(week)}
                                  className="flex items-center gap-2"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                  Copy
                                </Button>
                              </div>
                              <textarea
                                readOnly
                                value={tsv}
                                onFocus={(e) => e.currentTarget.select()}
                                className="w-full h-28 font-mono text-xs p-2 rounded-md border bg-background resize-y whitespace-pre"
                              />
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button onClick={() => setShowWeeklyAbsenceDialog(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TADashboard;
