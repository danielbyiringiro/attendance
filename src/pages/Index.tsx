import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin from "@/components/StudentLogin";
import TADashboard from "@/components/TADashboard";
import TALogin from "@/components/TALogin";
import { Settings } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Student {
  id: string;
  cohort: string;
  timestamp: Date;
  sessionDate?: string; // YYYY-MM-DD
}

const Index = () => {
  const [currentPin, setCurrentPin] = useState("1234");
  const [timeLimit, setTimeLimit] = useState(300); // 5 minutes in seconds
  const [isTimeUp, setIsTimeUp] = useState(false);
  const [presentStudents, setPresentStudents] = useState<Student[]>([]);
  const [isTA, setIsTA] = useState(false);
  const [showTALogin, setShowTALogin] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);

  // Timer management
  useEffect(() => {
    if (sessionStartTime && !isTimeUp) {
      const timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime.getTime()) / 1000);
        if (elapsed >= timeLimit) {
          setIsTimeUp(true);
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [sessionStartTime, timeLimit, isTimeUp]);

  const handleMarkAttendance = async (studentId: string, cohort: string) => {
    // Check if student already marked attendance locally
    if (presentStudents.find(s => s.id === studentId)) {
      return;
    }

    const newStudent: Student = {
      id: studentId,
      cohort,
      timestamp: new Date(),
      sessionDate: new Date().toISOString().slice(0, 10),
    };

    // Optimistic update
    setPresentStudents(prev => [...prev, newStudent]);

    // Persist to Supabase
    const { error } = await supabase.from('present_students').insert({
      student_id: studentId,
      cohort,
      timestamp: newStudent.timestamp.toISOString(),
    });
    if (error) {
      // Rollback optimistic update if desired, but for now just log
      // setPresentStudents(prev => prev.filter(s => s.id !== studentId));
      console.error('Failed to insert attendance:', error);
    }
  };

  const handleSetPin = (newPin: string) => {
    setCurrentPin(newPin);
    // Reset timer when PIN changes
    setSessionStartTime(new Date());
    setIsTimeUp(false);
  };

  const handleSetTimeLimit = (seconds: number) => {
    setTimeLimit(seconds);
    // Reset timer when time limit changes
    setSessionStartTime(new Date());
    setIsTimeUp(false);
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
    if (!sessionStartTime) {
      setSessionStartTime(new Date());
    }

    // Load today's attendance from Supabase using timestamp range (independent of session_date)
    (async () => {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));

      const { data, error } = await supabase
        .from('present_students')
        .select('student_id, cohort, timestamp')
        .gte('timestamp', start.toISOString())
        .lt('timestamp', end.toISOString())
        .order('timestamp', { ascending: true });
      if (error) {
        console.error('Failed to load attendance:', error);
        return;
      }
      if (data) {
        const restored: Student[] = data.map((row: any) => ({ id: row.student_id, cohort: row.cohort, timestamp: new Date(row.timestamp) }));
        setPresentStudents(restored);
      }
    })();
  }, []);

  const getTimeLeft = () => {
    if (!sessionStartTime) return timeLimit;
    const elapsed = Math.floor((Date.now() - sessionStartTime.getTime()) / 1000);
    return Math.max(0, timeLimit - elapsed);
  };

  // No localStorage persistence now that Supabase is connected

  if (isTA) {
    return (
      <TADashboard
        presentStudents={presentStudents}
        currentPin={currentPin}
        timeLimit={timeLimit}
        isTimeUp={isTimeUp}
        onSetPin={handleSetPin}
        onSetTimeLimit={handleSetTimeLimit}
        onResetAttendance={handleResetAttendance}
        onLogout={handleTALogout}
      />
    );
  }

  return (
    <div className="relative">
      <StudentLogin
        currentPin={currentPin}
        timeLimit={getTimeLeft()}
        isTimeUp={isTimeUp}
        onMarkAttendance={handleMarkAttendance}
      />
      
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
      {showTALogin && (
        <TALogin onLogin={handleTALogin} />
      )}
    </div>
  );
};

export default Index;
