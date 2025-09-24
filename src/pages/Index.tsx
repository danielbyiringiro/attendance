import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin from "@/components/StudentLogin";
import TADashboard from "@/components/TADashboard";
import TALogin from "@/components/TALogin";
import { Settings } from "lucide-react";

interface Student {
  id: string;
  cohort: string;
  timestamp: Date;
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

  const handleMarkAttendance = (studentId: string, cohort: string) => {
    // Check if student already marked attendance
    if (presentStudents.find(s => s.id === studentId)) {
      return;
    }

    const newStudent: Student = {
      id: studentId,
      cohort,
      timestamp: new Date()
    };

    setPresentStudents(prev => [...prev, newStudent]);
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
  }, []);

  const getTimeLeft = () => {
    if (!sessionStartTime) return timeLimit;
    const elapsed = Math.floor((Date.now() - sessionStartTime.getTime()) / 1000);
    return Math.max(0, timeLimit - elapsed);
  };

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
