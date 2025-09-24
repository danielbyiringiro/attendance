import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Users, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface StudentLoginProps {
  currentPin: string;
  timeLimit: number;
  isTimeUp: boolean;
  onMarkAttendance: (studentId: string, cohort: string) => void;
}

const StudentLogin = ({ currentPin, timeLimit, isTimeUp, onMarkAttendance }: StudentLoginProps) => {
  const [studentId, setStudentId] = useState("");
  const [pin, setPin] = useState("");
  const [timeLeft, setTimeLeft] = useState(timeLimit);
  const { toast } = useToast();

  useEffect(() => {
    setTimeLeft(timeLimit);
  }, [timeLimit]);

  useEffect(() => {
    if (timeLeft > 0 && !isTimeUp) {
      const timer = setInterval(() => {
        setTimeLeft(prev => Math.max(0, prev - 1));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [timeLeft, isTimeUp]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isTimeUp || timeLeft === 0) {
      toast({
        title: "Time's Up!",
        description: "The attendance window has closed.",
        variant: "destructive",
      });
      return;
    }

    if (!studentId.trim()) {
      toast({
        title: "Student ID Required",
        description: "Please enter your student ID.",
        variant: "destructive",
      });
      return;
    }

    if (pin !== currentPin) {
      toast({
        title: "Invalid PIN",
        description: "The PIN you entered is incorrect.",
        variant: "destructive",
      });
      return;
    }

    // Determine cohort based on student ID pattern (you can adjust this logic)
    const cohort = studentId.toLowerCase().includes('c') ? 'C' : 'B';
    
    onMarkAttendance(studentId, cohort);
    
    toast({
      title: "Attendance Marked!",
      description: `Welcome, ${studentId}! Your attendance has been recorded.`,
      variant: "default",
    });

    // Clear form
    setStudentId("");
    setPin("");
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isExpired = isTimeUp || timeLeft === 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center mb-4">
            <div className="p-3 bg-gradient-to-r from-primary to-accent rounded-full">
              <Users className="h-8 w-8 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance Check-In</h1>
          <p className="text-muted-foreground">Enter your Student ID and PIN to mark attendance</p>
        </div>

        {/* Time Display */}
        <Card className="border-2 shadow-soft">
          <CardContent className="pt-6">
            <div className="flex items-center justify-center space-x-3">
              <Clock className={`h-5 w-5 ${isExpired ? 'text-destructive' : 'text-primary'}`} />
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Time Remaining</p>
                <p className={`text-2xl font-bold ${isExpired ? 'text-destructive' : 'text-primary'}`}>
                  {isExpired ? "CLOSED" : formatTime(timeLeft)}
                </p>
              </div>
            </div>
            {!isExpired && (
              <div className="mt-4 bg-secondary rounded-full h-2 overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-1000"
                  style={{ width: `${(timeLeft / timeLimit) * 100}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>

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
                  disabled={isExpired}
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
                  disabled={isExpired}
                  className="h-12"
                />
              </div>

              <Button 
                type="submit" 
                className="w-full h-12 bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-all duration-300"
                disabled={isExpired}
              >
                {isExpired ? "Attendance Closed" : "Mark Attendance"}
              </Button>
            </form>

            {isExpired && (
              <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-sm text-destructive text-center">
                  The attendance window has closed. Please contact your TA.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cohort Info */}
        <div className="flex justify-center space-x-2">
          <Badge variant="outline" className="px-3 py-1">Cohort B</Badge>
          <Badge variant="outline" className="px-3 py-1">Cohort C</Badge>
        </div>
      </div>
    </div>
  );
};

export default StudentLogin;