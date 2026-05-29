import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin from "@/components/StudentLogin";
import TADashboard from "@/components/TADashboard";
import TALogin from "@/components/TALogin";
import StudentDashboard from "@/components/StudentDashboard";
import { Settings, History } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Student {
  id: string;
  cohort: string;
  timestamp: Date;
  name: string;
  sessionDate?: string; // YYYY-MM-DD
}

interface RosterStudent {
  student_id: string;
  cohort: string;
  name?: string;
}

const Index = () => {
  const [currentPin, setCurrentPin] = useState("1234");
  const [timeLimit, setTimeLimit] = useState(300); // 5 minutes in seconds
  const [isTimeUp, setIsTimeUp] = useState(true);
  const [presentStudents, setPresentStudents] = useState<Student[]>([]);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [isTA, setIsTA] = useState(false);
  const [showTALogin, setShowTALogin] = useState(false);
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  // Timer management
  useEffect(() => {
    if (sessionStartTime && isOpen && !isTimeUp) {
      const timer = setInterval(() => {
        const elapsed = Math.floor(
          (Date.now() - sessionStartTime.getTime()) / 1000,
        );
        if (elapsed >= timeLimit) {
          setIsTimeUp(true);
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [sessionStartTime, timeLimit, isTimeUp, isOpen]);

  const handleMarkAttendance = async (
    studentId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    // Check if student already marked attendance locally
    if (presentStudents.find((s) => s.id === studentId)) {
      return {
        success: false,
        error: "You have already marked your attendance.",
      };
    }

    // Verify the student exists in the roster
    const { data: rosterEntry, error: rosterError } = await supabase
      .from("students")
      .select("*")
      .eq("student_id", studentId)
      .maybeSingle();

    if (rosterError) {
      console.error("Failed to verify student:", rosterError);
      return {
        success: false,
        error: "Something went wrong. Please try again.",
      };
    }

    if (!rosterEntry) {
      return {
        success: false,
        error:
          "You are not registered for this course. Please contact your TA.",
      };
    }

    const newStudent: Student = {
      id: studentId,
      cohort: rosterEntry.cohort,
      timestamp: new Date(),
      sessionDate: new Date().toISOString().slice(0, 10),
      name: rosterEntry.name || "",
    };

    // Optimistic update
    // setPresentStudents((prev) => [...prev, newStudent]);

    // Persist to Supabase
    const { error } = await supabase.from("present_students").insert({
      student_id: studentId,
      cohort: rosterEntry.cohort,
      timestamp: newStudent.timestamp.toISOString(),
    });
    if (error) {
      // Rollback optimistic update on failure
      setPresentStudents((prev) => prev.filter((s) => s.id !== studentId));
      console.error("Failed to insert attendance:", error);
      return {
        success: false,
        error: "Failed to record attendance. Please try again.",
      };
    }

    return { success: true, error: rosterEntry.name };
  };

  const handleSetPin = async (newPin: string) => {
    const nowIso = new Date().toISOString();
    // Upsert shared session state
    const { data, error } = await supabase
      .from("session_state")
      .upsert(
        {
          id: 1,
          pin: newPin,
          time_limit_seconds: timeLimit,
          session_start: nowIso,
          is_open: true,
        },
        { onConflict: "id" },
      )
      .select()
      .single();

    if (!error && data) {
      setCurrentPin(data.pin);
      setTimeLimit(data.time_limit_seconds);
      setSessionStartTime(new Date(data.session_start));
      setIsOpen(!!data.is_open);
      setIsTimeUp(false);
      setSessionId(data.id);
    }
  };

  const handleSetTimeLimit = async (seconds: number) => {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("session_state")
      .upsert(
        {
          id: 1,
          pin: currentPin,
          time_limit_seconds: seconds,
          session_start: nowIso,
          is_open: true,
        },
        { onConflict: "id" },
      )
      .select()
      .single();

    if (!error && data) {
      setCurrentPin(data.pin);
      setTimeLimit(data.time_limit_seconds);
      setSessionStartTime(new Date(data.session_start));
      setIsOpen(!!data.is_open);
      setIsTimeUp(false);
      setSessionId(data.id);
    }
  };

  const handleResetAttendance = () => {
    setPresentStudents([]);
    setSessionStartTime(new Date());
    setIsTimeUp(false);
  };

  const handleTALogin = () => {
    setIsTA(true);
    setShowTALogin(false);
  };

  const handleTALogout = () => {
    setIsTA(false);
  };

  // Initialize session on first load
  useEffect(() => {
    // Load shared session state (do not create/modify on load)
    (async () => {
      const { data: ss, error: ssError } = await supabase
        .from("session_state")
        .select("*")
        .eq("id", 1)
        .maybeSingle();

      if (ssError) {
        console.error("Failed to load session_state:", ssError);
      }

      if (ss) {
        setSessionId(ss.id);
        setCurrentPin(ss.pin);
        setTimeLimit(ss.time_limit_seconds);
        setSessionStartTime(new Date(ss.session_start));
        setIsOpen(!!ss.is_open);
        // If closed, mark as time up; otherwise compute remaining time
        const elapsed = Math.floor(
          (Date.now() - new Date(ss.session_start).getTime()) / 1000,
        );
        setIsTimeUp(!ss.is_open || elapsed >= ss.time_limit_seconds);
      }

      // Load today's attendance from Supabase using timestamp range (independent of session_date)
      const now = new Date();
      const start = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          0,
          0,
          0,
        ),
      );
      const end = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + 1,
          0,
          0,
          0,
        ),
      );

      const { data, error } = await supabase
        .from("present_students")
        .select("student_id, cohort, timestamp")
        .gte("timestamp", start.toISOString())
        .lt("timestamp", end.toISOString())
        .order("timestamp", { ascending: true });
      if (error) {
        console.error("Failed to load attendance:", error);
        return;
      }
      if (data) {
        const restored: Student[] = data.map((row) => ({
          id: row.student_id,
          cohort: row.cohort,
          timestamp: new Date(row.timestamp),
          name: "", // Will be filled by roster or left empty
        }));
        setPresentStudents(restored);
      }

      // Load roster from students table
      const { data: rosterData, error: rosterError } = await supabase
        .from("students")
        .select("student_id, cohort, name")
        .order("student_id", { ascending: true });
      if (rosterError) {
        console.error("Failed to load students roster:", rosterError);
      }
      if (rosterData) {
        const normalized: RosterStudent[] = rosterData.map((row) => {
          const normalizedCohort = String(row.cohort).toUpperCase();
          return {
            student_id: String(row.student_id),
            cohort: normalizedCohort,
            name: row.name || undefined,
          };
        });
        setRoster(normalized);
      }
    })();

    const sessionChannel = supabase
      .channel("session_state_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "session_state" },
        (payload) => {
          if (payload.eventType !== "DELETE") {
            const row = payload.new;
            if (row) {
              setCurrentPin(row.pin);
              setTimeLimit(row.time_limit_seconds);
              setSessionStartTime(new Date(row.session_start));
              setIsOpen(!!row.is_open);
              const elapsed = Math.floor(
                (Date.now() - new Date(row.session_start).getTime()) / 1000,
              );
              setIsTimeUp(!row.is_open || elapsed >= row.time_limit_seconds);
            }
          }
        },
      )
      .subscribe();

    // Subscribe to realtime changes on students table to keep roster updated
    const rosterChannel = supabase
      .channel("students_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "students" },
        (payload) => {
          if (payload.eventType !== "DELETE") {
            const row = payload.new;
            if (row) {
              const normalizedCohort = String(row.cohort).toUpperCase();
              const newStudent: RosterStudent = {
                student_id: String(row.student_id),
                cohort: normalizedCohort,
                name: row.name || undefined,
              };
              // Update roster - add or replace student
              setRoster((prev) => {
                const existing = prev.find(
                  (s) => s.student_id === newStudent.student_id,
                );
                if (existing) {
                  // Replace existing student
                  return prev.map((s) =>
                    s.student_id === newStudent.student_id ? newStudent : s,
                  );
                } else {
                  // Add new student and sort
                  return [...prev, newStudent].sort((a, b) =>
                    a.student_id.localeCompare(b.student_id),
                  );
                }
              });
            }
          } else {
            // Handle deletion
            const deletedRow = payload.old;
            if (deletedRow) {
              setRoster((prev) =>
                prev.filter(
                  (s) => s.student_id !== String(deletedRow.student_id),
                ),
              );
            }
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(sessionChannel);
      supabase.removeChannel(rosterChannel);
    };
  }, []);

  const getTimeLeft = () => {
    if (!isOpen || !sessionStartTime) return 0;
    const elapsed = Math.floor(
      (Date.now() - sessionStartTime.getTime()) / 1000,
    );
    return Math.max(0, timeLimit - elapsed);
  };

  // No localStorage persistence now that Supabase is connected

  if (isTA) {
    return (
      <TADashboard
        presentStudents={presentStudents}
        roster={roster}
        currentPin={currentPin}
        timeLimit={timeLimit}
        isTimeUp={isTimeUp}
        onSetPin={handleSetPin}
        onSetTimeLimit={handleSetTimeLimit}
        onResetAttendance={handleResetAttendance}
        onLogout={handleTALogout}
        onMarkAttendance={handleMarkAttendance}
      />
    );
  }

  if (showStudentDashboard) {
    return <StudentDashboard onBack={() => setShowStudentDashboard(false)} />;
  }

  return (
    <div className="relative">
      <StudentLogin
        currentPin={currentPin}
        timeLimit={getTimeLeft()}
        isTimeUp={isTimeUp}
        onMarkAttendance={handleMarkAttendance}
      />

      {/* Student History Button */}
      <Button
        onClick={() => setShowStudentDashboard(true)}
        variant="outline"
        size="sm"
        className="fixed top-4 left-4 opacity-70 hover:opacity-100 transition-opacity"
      >
        <History className="h-4 w-4 mr-2" />
        History
      </Button>

      {/* TA Access Button */}
      <Button
        onClick={() => setShowTALogin(true)}
        variant="ghost"
        size="sm"
        className="fixed top-4 right-4 opacity-70 hover:opacity-100 transition-opacity"
      >
        <Settings className="h-4 w-4" />
      </Button>

      {/* TA Login Modal */}
      {showTALogin && <TALogin onLogin={handleTALogin} />}
    </div>
  );
};

export default Index;
