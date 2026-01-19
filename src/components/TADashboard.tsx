import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/lib/supabase";
import { 
  Settings, 
  Users, 
  Clock, 
  UserCheck, 
  UserX, 
  RefreshCw,
  Timer,
  Shield,
  History,
  CheckCircle2,
  XCircle,
  Calendar as CalendarIcon,
  Search
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface Student {
  id: string;
  cohort: string;
  timestamp: Date;
}

interface TADashboardProps {
  presentStudents: Student[];
  currentPin: string;
  timeLimit: number;
  isTimeUp: boolean;
  onSetPin: (pin: string) => void;
  onSetTimeLimit: (seconds: number) => void;
  onResetAttendance: () => void;
  onLogout: () => void;
  onMarkAttendance: (studentId: string, cohort: string) => Promise<void>;
}

interface AbsenceHistory {
  date: string;
  student_id: string;
  cohort: string;
  was_class_cancelled: boolean;
}

interface ClassSession {
  date: string;
  cohort: 'A' | 'B';
  is_cancelled: boolean;
}

interface ClassSchedule {
  cohort: 'A' | 'B';
  day_of_week: number; // 0 = Sunday, 1 = Monday, etc.
}

interface ClassDate {
  date: string;
  cohort: 'A' | 'B';
}

const TADashboard = ({ 
  presentStudents, 
  currentPin, 
  timeLimit, 
  isTimeUp,
  onSetPin, 
  onSetTimeLimit, 
  onResetAttendance,
  onLogout,
  onMarkAttendance 
}: TADashboardProps) => {
  const [newPin, setNewPin] = useState("");
  const [newTimeLimit, setNewTimeLimit] = useState("");
  const [selectedCohort, setSelectedCohort] = useState("all");
  const { toast } = useToast();
  const [roster, setRoster] = useState<Array<{ student_id: string; cohort: 'A' | 'B'; name?: string }>>([]);
  const [isLoadingRoster, setIsLoadingRoster] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [absenceHistory, setAbsenceHistory] = useState<AbsenceHistory[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyDate, setHistoryDate] = useState<Date | undefined>(undefined);
  const [cancelledSessions, setCancelledSessions] = useState<ClassSession[]>([]);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelDate, setCancelDate] = useState<Date | undefined>(undefined);
  const [cancelCohort, setCancelCohort] = useState<'A' | 'B' | ''>('');
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [studentAbsenceHistory, setStudentAbsenceHistory] = useState<AbsenceHistory[]>([]);
  const [isLoadingStudentHistory, setIsLoadingStudentHistory] = useState(false);
  const [classDates, setClassDates] = useState<Map<string, boolean>>(new Map()); // key: "YYYY-MM-DD-cohort"
  const [classSchedule, setClassSchedule] = useState<ClassSchedule[]>([]);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleCohort, setScheduleCohort] = useState<'A' | 'B' | ''>('');
  const [selectedDays, setSelectedDays] = useState<number[]>([]);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      setIsLoadingRoster(true);
      const { data, error } = await supabase
        .from('students')
        .select('student_id, cohort, name')
        .order('student_id', { ascending: true });
      if (error) {
        console.error('Failed to load students roster:', error);
      }
      if (isMounted && data) {
        const normalized = data.map((row: any) => {
          const normalizedCohort = String(row.cohort).toUpperCase();
          const cohort = normalizedCohort === 'B' ? 'B' : 'A';
          return { 
            student_id: String(row.student_id), 
            cohort: cohort as 'A' | 'B',
            name: row.name || undefined
          };
        });
        setRoster(normalized);
      }
      if (isMounted) setIsLoadingRoster(false);
    })();
    return () => { isMounted = false; };
  }, []);

  const allStudents = roster.map(r => r.student_id);
  const inferCohort = (id: string): 'A' | 'B' => (id.toUpperCase().includes('A') ? 'A' : 'B');

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

  const filteredPresentStudents = selectedCohort === "all" 
    ? presentStudents 
    : presentStudents.filter(student => student.cohort === selectedCohort.toUpperCase());

  const presentStudentIds = presentStudents.map(s => s.id);
  const absentStudents = allStudents.filter(id => !presentStudentIds.includes(id));
  const filteredAbsentStudents = selectedCohort === "all"
    ? absentStudents
    : absentStudents.filter(id => {
        const rosterEntry = roster.find(r => r.student_id === id);
        const cohort = rosterEntry ? rosterEntry.cohort : inferCohort(id);
        return cohort === selectedCohort.toUpperCase();
      });

  const cohortAPresent = presentStudents.filter(s => s.cohort === 'A').length;
  const cohortBPresent = presentStudents.filter(s => s.cohort === 'B').length;
  const cohortATotal = roster.filter(r => r.cohort === 'A').length;
  const cohortBTotal = roster.filter(r => r.cohort === 'B').length;

  // Load cancelled sessions and class dates
  useEffect(() => {
    (async () => {
      const { data: cancelledData, error: cancelledError } = await supabase
        .from('cancelled_sessions')
        .select('date, cohort, is_cancelled')
        .eq('is_cancelled', true);
      if (cancelledError && cancelledError.code !== 'PGRST116') {
        console.error('Failed to load cancelled sessions:', cancelledError);
      } else if (cancelledData) {
        setCancelledSessions(cancelledData.map((row: any) => ({
          date: row.date,
          cohort: row.cohort,
          is_cancelled: row.is_cancelled
        })));
      }

      // Load class schedule
      const { data: scheduleData, error: scheduleError } = await supabase
        .from('class_schedule')
        .select('cohort, day_of_week')
        .order('cohort, day_of_week');
      if (scheduleError && scheduleError.code !== 'PGRST116') {
        console.error('Failed to load class schedule:', scheduleError);
      } else if (scheduleData) {
        setClassSchedule(scheduleData.map((row: any) => ({
          cohort: row.cohort,
          day_of_week: row.day_of_week
        })));
      }

      // Load actual class dates
      const { data: classDatesData, error: classDatesError } = await supabase
        .from('class_dates')
        .select('date, cohort');
      if (classDatesError && classDatesError.code !== 'PGRST116') {
        console.error('Failed to load class dates:', classDatesError);
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
  const isClassDay = (date: Date, cohort: 'A' | 'B'): boolean => {
    const dateStr = date.toISOString().split('T')[0];
    const key = `${dateStr}-${cohort}`;
    
    // First check explicit class_dates table
    if (classDates.has(key)) {
      return true;
    }
    
    // Then check if it matches the schedule
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const scheduleMatches = classSchedule.some(s => 
      s.cohort === cohort && s.day_of_week === dayOfWeek
    );
    
    // Also check if there was attendance on this date (implies it was a class day)
    if (scheduleMatches) {
      // If it matches the schedule, we can assume it's a class day
      // unless explicitly cancelled
      const cancelledKey = `${dateStr}-${cohort}`;
      const isCancelled = cancelledSessions.some(s => 
        s.date === dateStr && s.cohort === cohort && s.is_cancelled
      );
      return !isCancelled;
    }
    
    return false;
  };

  const handleMarkAttendanceManually = async (studentId: string, cohort: string) => {
    try {
      await onMarkAttendance(studentId, cohort);
      toast({
        title: "Attendance Marked",
        description: `Marked ${studentId} as present (Cohort ${cohort})`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to mark attendance",
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
        startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
        endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0));
      } else {
        // Load last 30 days
        endDate = new Date();
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
      }

      // Get all attendance records for the date range
      const { data: attendanceData, error: attendanceError } = await supabase
        .from('present_students')
        .select('student_id, cohort, timestamp')
        .gte('timestamp', startDate.toISOString())
        .lt('timestamp', endDate.toISOString());

      if (attendanceError) {
        console.error('Failed to load attendance:', attendanceError);
        return;
      }

      // Get cancelled sessions for the date range
      const { data: cancelledData, error: cancelledError } = await supabase
        .from('cancelled_sessions')
        .select('date, cohort, is_cancelled')
        .gte('date', startDate.toISOString().split('T')[0])
        .lte('date', endDate.toISOString().split('T')[0])
        .eq('is_cancelled', true);

      if (cancelledError && cancelledError.code !== 'PGRST116') {
        console.error('Failed to load cancelled sessions:', cancelledError);
      }

      const cancelledSessionsMap = new Map<string, boolean>();
      if (cancelledData) {
        cancelledData.forEach((session: any) => {
          const key = `${session.date}-${session.cohort}`;
          cancelledSessionsMap.set(key, true);
        });
      }

      // Get all students
      const allStudentIds = roster.map(r => r.student_id);

      // Group attendance by date
      const attendanceByDate = new Map<string, Set<string>>();
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp).toISOString().split('T')[0];
          if (!attendanceByDate.has(recordDate)) {
            attendanceByDate.set(recordDate, new Set());
          }
          attendanceByDate.get(recordDate)!.add(record.student_id);
        });
      }

      // Get class dates for the range
      const { data: classDatesData, error: classDatesError } = await supabase
        .from('class_dates')
        .select('date, cohort')
        .gte('date', startDate.toISOString().split('T')[0])
        .lte('date', endDate.toISOString().split('T')[0]);
      
      const classDatesMap = new Map<string, boolean>();
      if (classDatesData) {
        classDatesData.forEach((row: any) => {
          const key = `${row.date}-${row.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check attendance records to infer class days (if someone was present, it was a class day)
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp).toISOString().split('T')[0];
          const key = `${recordDate}-${record.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check if dates match the schedule
      const currentDateCheck = new Date(startDate);
      while (currentDateCheck < endDate) {
        const dateStr = currentDateCheck.toISOString().split('T')[0];
        const dayOfWeek = currentDateCheck.getDay();
        
        classSchedule.forEach(schedule => {
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

      // Find absences - only on days when classes actually occurred
      const absences: AbsenceHistory[] = [];
      const currentDate = new Date(startDate);

      while (currentDate < endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const presentOnDate = attendanceByDate.get(dateStr) || new Set();

        // Check each student
        allStudentIds.forEach((studentId) => {
          const studentRoster = roster.find(r => r.student_id === studentId);
          const cohort = studentRoster?.cohort || inferCohort(studentId);
          const classDateKey = `${dateStr}-${cohort}`;

          // Only check absences on days when classes actually occurred
          const isClassDate = classDatesMap.has(classDateKey);
          
          // Check if class was cancelled for this cohort on this date
          const wasCancelled = cancelledSessionsMap.get(classDateKey) || false;

          if (isClassDate && !presentOnDate.has(studentId) && !wasCancelled) {
            absences.push({
              date: dateStr,
              student_id: studentId,
              cohort: cohort,
              was_class_cancelled: false
            });
          }
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      setAbsenceHistory(absences);
    } catch (error) {
      console.error('Error loading absence history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const generateClassDates = async (startDate: Date, endDate: Date, cohorts: ('A' | 'B')[]) => {
    try {
      const datesToInsert: Array<{ date: string; cohort: 'A' | 'B' }> = [];
      const currentDate = new Date(startDate);

      while (currentDate <= endDate) {
        const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const dateStr = currentDate.toISOString().split('T')[0];

        cohorts.forEach(cohort => {
          // Check if this day matches the schedule
          const scheduleMatches = classSchedule.some(s => 
            s.cohort === cohort && s.day_of_week === dayOfWeek
          );

          if (scheduleMatches) {
            // Check if already cancelled - if so, don't add
            const isCancelled = cancelledSessions.some(s => 
              s.date === dateStr && s.cohort === cohort && s.is_cancelled
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
          .from('class_dates')
          .upsert(datesToInsert, { onConflict: 'date,cohort', ignoreDuplicates: true });

        if (error) {
          console.error('Failed to generate class dates:', error);
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
      console.error('Error generating class dates:', error);
    }
  };

  const handleSaveSchedule = async (cohort: 'A' | 'B', daysOfWeek: number[]) => {
    try {
      // Delete existing schedule for this cohort
      const { error: deleteError } = await supabase
        .from('class_schedule')
        .delete()
        .eq('cohort', cohort);

      if (deleteError) {
        console.error('Failed to delete old schedule:', deleteError);
      }

      // Insert new schedule
      const scheduleEntries = daysOfWeek.map(day => ({
        cohort,
        day_of_week: day
      }));

      const { error: insertError } = await supabase
        .from('class_schedule')
        .insert(scheduleEntries);

      if (insertError) {
        console.error('Failed to save schedule:', insertError);
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
        const newSchedule = classSchedule.filter(s => s.cohort !== cohort);
        scheduleEntries.forEach(entry => {
          newSchedule.push({ cohort: entry.cohort, day_of_week: entry.day_of_week });
        });
        setClassSchedule(newSchedule);
      }
    } catch (error) {
      console.error('Error saving schedule:', error);
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

    const dateStr = cancelDate.toISOString().split('T')[0];

    // Upsert cancelled session
    const { error } = await supabase
      .from('cancelled_sessions')
      .upsert({
        date: dateStr,
        cohort: cancelCohort,
        is_cancelled: true
      }, { onConflict: 'date,cohort' });

    if (error) {
      console.error('Failed to cancel class:', error);
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
      setCancelledSessions(prev => [...prev, { date: dateStr, cohort: cancelCohort, is_cancelled: true }]);
      setShowCancelDialog(false);
      setCancelDate(undefined);
      setCancelCohort('');
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
      const matchingStudents = roster.filter(r => 
        r.student_id.toLowerCase().includes(searchLower) ||
        (r.name && r.name.toLowerCase().includes(searchLower))
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
      const studentIds = matchingStudents.map(s => s.student_id);

      // Get all attendance records for these students
      const { data: attendanceData, error: attendanceError } = await supabase
        .from('present_students')
        .select('student_id, cohort, timestamp')
        .in('student_id', studentIds)
        .order('timestamp', { ascending: false });

      if (attendanceError) {
        console.error('Failed to load attendance:', attendanceError);
        setIsLoadingStudentHistory(false);
        return;
      }

      // Get cancelled sessions for all dates
      const { data: cancelledData, error: cancelledError } = await supabase
        .from('cancelled_sessions')
        .select('date, cohort, is_cancelled')
        .eq('is_cancelled', true);

      if (cancelledError && cancelledError.code !== 'PGRST116') {
        console.error('Failed to load cancelled sessions:', cancelledError);
      }

      const cancelledSessionsMap = new Map<string, boolean>();
      if (cancelledData) {
        cancelledData.forEach((session: any) => {
          const key = `${session.date}-${session.cohort}`;
          cancelledSessionsMap.set(key, true);
        });
      }

      // Group attendance by student and date
      const attendanceByStudentAndDate = new Map<string, Set<string>>();
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp).toISOString().split('T')[0];
          const key = `${record.student_id}-${recordDate}`;
          if (!attendanceByStudentAndDate.has(record.student_id)) {
            attendanceByStudentAndDate.set(record.student_id, new Set());
          }
          attendanceByStudentAndDate.get(record.student_id)!.add(recordDate);
        });
      }

      // Get class dates for the range (last 90 days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 90);

      const { data: classDatesData, error: classDatesError } = await supabase
        .from('class_dates')
        .select('date, cohort')
        .gte('date', startDate.toISOString().split('T')[0])
        .lte('date', endDate.toISOString().split('T')[0]);
      
      const classDatesMap = new Map<string, boolean>();
      if (classDatesData) {
        classDatesData.forEach((row: any) => {
          const key = `${row.date}-${row.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check attendance records to infer class days (if someone was present, it was a class day)
      if (attendanceData) {
        attendanceData.forEach((record: any) => {
          const recordDate = new Date(record.timestamp).toISOString().split('T')[0];
          const key = `${recordDate}-${record.cohort}`;
          classDatesMap.set(key, true);
        });
      }

      // Also check if dates match the schedule
      const currentDateCheck = new Date(startDate);
      while (currentDateCheck < endDate) {
        const dateStr = currentDateCheck.toISOString().split('T')[0];
        const dayOfWeek = currentDateCheck.getDay();
        
        classSchedule.forEach(schedule => {
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

      // Find absences - only on days when classes actually occurred
      const absences: AbsenceHistory[] = [];
      const currentDate = new Date(startDate);

      while (currentDate < endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        
        // Check each matching student
        matchingStudents.forEach((student) => {
          const presentOnDate = attendanceByStudentAndDate.get(student.student_id)?.has(dateStr) || false;
          const classDateKey = `${dateStr}-${student.cohort}`;
          const isClassDate = classDatesMap.has(classDateKey);
          const wasCancelled = cancelledSessionsMap.get(classDateKey) || false;

          if (isClassDate && !presentOnDate && !wasCancelled) {
            absences.push({
              date: dateStr,
              student_id: student.student_id,
              cohort: student.cohort,
              was_class_cancelled: false
            });
          }
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }

      // Sort by date descending
      absences.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setStudentAbsenceHistory(absences);
    } catch (error) {
      console.error('Error searching student:', error);
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
              <h1 className="text-2xl font-bold">TA Dashboard</h1>
              <p className="text-muted-foreground">Manage attendance and monitor student participation</p>
            </div>
          </div>
          <Button onClick={onLogout} variant="outline">
            Logout
          </Button>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-2 shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <UserCheck className="h-5 w-5 text-success" />
                <div>
                  <p className="text-2xl font-bold text-success">{presentStudents.length}</p>
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
                  <p className="text-2xl font-bold text-destructive">{absentStudents.length}</p>
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
                  <p className="text-2xl font-bold">{cohortAPresent}/{cohortATotal}</p>
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
                  <p className="text-2xl font-bold">{cohortBPresent}/{cohortBTotal}</p>
                  <p className="text-sm text-muted-foreground">Cohort B</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4 flex-wrap">
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
              setScheduleCohort('');
              setSelectedDays([]);
            }}
            variant="outline"
            className="flex items-center gap-2"
          >
            <Settings className="h-4 w-4" />
            Class Schedule
          </Button>
        </div>

        {/* Controls and Student Lists */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Controls */}
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
                <label className="text-sm font-medium">Time Limit (minutes)</label>
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

          {/* Student Lists */}
          <div className="lg:col-span-2">
            <Card className="border-2 shadow-medium">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    Student Status
                  </CardTitle>
                  <Select value={selectedCohort} onValueChange={setSelectedCohort}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Cohorts</SelectItem>
                    <SelectItem value="a">Cohort A</SelectItem>
                    <SelectItem value="b">Cohort B</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="absent" className="w-full">
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="present" className="flex items-center gap-2">
                      <UserCheck className="h-4 w-4" />
                      Present ({filteredPresentStudents.length})
                    </TabsTrigger>
                    <TabsTrigger value="absent" className="flex items-center gap-2">
                      <UserX className="h-4 w-4" />
                      Absent ({filteredAbsentStudents.length})
                    </TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="present" className="mt-4">
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {isLoadingRoster ? (
                        <p className="text-center text-muted-foreground py-8">Loading roster...</p>
                      ) : filteredPresentStudents.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">No students marked present yet</p>
                      ) : (
                        filteredPresentStudents.map((student) => (
                          <div key={student.id} className="flex items-center justify-between p-2 bg-success/10 border border-success/20 rounded-lg">
                            <span className="font-medium">{student.id}</span>
                            <div className="flex items-center space-x-2">
                              <Badge variant="outline" className="text-xs">Cohort {student.cohort}</Badge>
                              <span className="text-xs text-muted-foreground">{student.timestamp.toLocaleTimeString()}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </TabsContent>
                  
                  <TabsContent value="absent" className="mt-4">
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {isLoadingRoster ? (
                        <p className="text-center text-muted-foreground py-8">Loading roster...</p>
                      ) : filteredAbsentStudents.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">All students are present!</p>
                      ) : (
                        filteredAbsentStudents.map((studentId) => {
                          const rosterEntry = roster.find(r => r.student_id === studentId);
                          const cohort = rosterEntry ? rosterEntry.cohort : inferCohort(studentId);
                          const studentName = rosterEntry?.name;
                          return (
                            <div key={studentId} className="flex items-center justify-between p-2 bg-destructive/10 border border-destructive/20 rounded-lg">
                              <div className="flex flex-col">
                                <div className="flex items-center space-x-2">
                                  <span className="font-medium">{studentId}</span>
                                  <Badge variant="outline" className="text-xs">Cohort {cohort}</Badge>
                                </div>
                                {studentName && (
                                  <span className="text-sm text-muted-foreground mt-1">{studentName}</span>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleMarkAttendanceManually(studentId, cohort)}
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
      </div>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Absence History</DialogTitle>
            <DialogDescription>
              View students who missed class on specific days. Select a date to filter, or view all absences from the last 30 days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[240px] justify-start text-left font-normal", !historyDate && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {historyDate ? format(historyDate, "PPP") : "Filter by date (optional)"}
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
              <p className="text-center text-muted-foreground py-8">Loading history...</p>
            ) : absenceHistory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No absences found for the selected period.</p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-4 gap-2 font-semibold text-sm border-b pb-2">
                  <div>Date</div>
                  <div>Student ID</div>
                  <div>Cohort</div>
                  <div>Status</div>
                </div>
                {absenceHistory.map((absence, index) => {
                  const student = roster.find(r => r.student_id === absence.student_id);
                  return (
                    <div key={`${absence.date}-${absence.student_id}-${index}`} className="grid grid-cols-4 gap-2 p-2 bg-muted/50 rounded-lg text-sm">
                      <div>{format(new Date(absence.date), "MMM dd, yyyy")}</div>
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

      {/* Cancel Class Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Class</DialogTitle>
            <DialogDescription>
              Mark a class as cancelled for a specific cohort on a specific date. Students from that cohort won't be marked as absent on cancelled days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !cancelDate && "text-muted-foreground")}>
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
              <Select value={cancelCohort} onValueChange={(value) => setCancelCohort(value as 'A' | 'B')}>
                <SelectTrigger>
                  <SelectValue placeholder="Select cohort" />
                </SelectTrigger>
                  <SelectContent>
                  <SelectItem value="A">Cohort A</SelectItem>
                  <SelectItem value="B">Cohort B</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Cancel</Button>
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
              Search for a student by name or ID to view all classes they missed. Enter part of their name or ID.
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
                  if (e.key === 'Enter') {
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
              <p className="text-center text-muted-foreground py-8">Searching...</p>
            ) : studentAbsenceHistory.length === 0 && searchQuery ? (
              <p className="text-center text-muted-foreground py-8">No absences found for this student.</p>
            ) : studentAbsenceHistory.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium">
                    {studentAbsenceHistory.length} {studentAbsenceHistory.length === 1 ? 'absence' : 'absences'} found
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-2 font-semibold text-sm border-b pb-2">
                  <div>Date</div>
                  <div>Student ID</div>
                  <div>Cohort</div>
                  <div>Status</div>
                </div>
                {studentAbsenceHistory.map((absence, index) => {
                  const student = roster.find(r => r.student_id === absence.student_id);
                  return (
                    <div key={`${absence.date}-${absence.student_id}-${index}`} className="grid grid-cols-4 gap-2 p-2 bg-muted/50 rounded-lg text-sm">
                      <div>{format(new Date(absence.date), "MMM dd, yyyy")}</div>
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
              <p className="text-center text-muted-foreground py-8">Enter a name or ID to search.</p>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowSearchDialog(false);
              setSearchQuery("");
              setStudentAbsenceHistory([]);
            }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Class Schedule Dialog */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configure Class Schedule</DialogTitle>
            <DialogDescription>
              Set which days of the week classes occur for each cohort. Attendance will only be tracked on these days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Cohort</label>
              <Select 
                value={scheduleCohort} 
                onValueChange={(value) => {
                  setScheduleCohort(value as 'A' | 'B');
                  // Load existing schedule for this cohort
                  const existingSchedule = classSchedule.filter(s => s.cohort === value);
                  setSelectedDays(existingSchedule.map(s => s.day_of_week));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select cohort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Cohort A</SelectItem>
                  <SelectItem value="B">Cohort B</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scheduleCohort && (
              <div className="space-y-3">
                <label className="text-sm font-medium">Select Days of Week (3 days)</label>
                <div className="space-y-2">
                  {[
                    { value: 1, label: 'Monday' },
                    { value: 2, label: 'Tuesday' },
                    { value: 3, label: 'Wednesday' },
                    { value: 4, label: 'Thursday' },
                    { value: 5, label: 'Friday' },
                    { value: 6, label: 'Saturday' },
                    { value: 0, label: 'Sunday' }
                  ].map(day => (
                    <div key={day.value} className="flex items-center space-x-2">
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
                                description: "Classes only occur 3 times per week. Please unselect a day first.",
                                variant: "default",
                              });
                            }
                          } else {
                            setSelectedDays(selectedDays.filter(d => d !== day.value));
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
                          description: "Please select a cohort and at least one day",
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
                      
                      await generateClassDates(startDate, endDate, [scheduleCohort as 'A' | 'B']);
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
                  {['A', 'B'].map(cohort => {
                    const cohortSchedule = classSchedule.filter(s => s.cohort === cohort);
                    if (cohortSchedule.length === 0) return null;
                    
                    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                    const days = cohortSchedule.map(s => dayNames[s.day_of_week]).join(', ');
                    
                    return (
                      <div key={cohort} className="text-sm">
                        <span className="font-medium">Cohort {cohort}:</span> {days}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowScheduleDialog(false);
              setScheduleCohort('');
              setSelectedDays([]);
            }}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TADashboard;