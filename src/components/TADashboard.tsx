import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { 
  Settings, 
  Users, 
  Clock, 
  UserCheck, 
  UserX, 
  RefreshCw,
  Timer,
  Shield
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
}

const TADashboard = ({ 
  presentStudents, 
  currentPin, 
  timeLimit, 
  isTimeUp,
  onSetPin, 
  onSetTimeLimit, 
  onResetAttendance,
  onLogout 
}: TADashboardProps) => {
  const [newPin, setNewPin] = useState("");
  const [newTimeLimit, setNewTimeLimit] = useState("");
  const [selectedCohort, setSelectedCohort] = useState("all");
  const { toast } = useToast();
  const [roster, setRoster] = useState<Array<{ student_id: string; cohort: 'B' | 'C' }>>([]);
  const [isLoadingRoster, setIsLoadingRoster] = useState(false);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      setIsLoadingRoster(true);
      const { data, error } = await supabase
        .from('students')
        .select('student_id, cohort')
        .order('student_id', { ascending: true });
      if (error) {
        console.error('Failed to load students roster:', error);
      }
      if (isMounted && data) {
        const normalized = data.map((row: any) => ({ student_id: String(row.student_id), cohort: (String(row.cohort).toUpperCase() === 'C' ? 'C' : 'B') as 'B' | 'C' }));
        setRoster(normalized);
      }
      if (isMounted) setIsLoadingRoster(false);
    })();
    return () => { isMounted = false; };
  }, []);

  const allStudents = roster.map(r => r.student_id);

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
        const cohort = id.includes('C') ? 'C' : 'B';
        return cohort === selectedCohort.toUpperCase();
      });

  const cohortBPresent = presentStudents.filter(s => s.cohort === 'B').length;
  const cohortCPresent = presentStudents.filter(s => s.cohort === 'C').length;
  const cohortBTotal = roster.filter(r => r.cohort === 'B').length;
  const cohortCTotal = roster.filter(r => r.cohort === 'C').length;

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
                  <p className="text-2xl font-bold">{cohortBPresent}/{cohortBTotal}</p>
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
                  <p className="text-2xl font-bold">{cohortCPresent}/{cohortCTotal}</p>
                  <p className="text-sm text-muted-foreground">Cohort C</p>
                </div>
              </div>
            </CardContent>
          </Card>
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
                      <SelectItem value="b">Cohort B</SelectItem>
                      <SelectItem value="c">Cohort C</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="present" className="w-full">
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
                      ) : (
                      {filteredPresentStudents.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">
                          No students marked present yet
                        </p>
                      ) : (
                        filteredPresentStudents.map((student) => (
                          <div key={student.id} className="flex items-center justify-between p-2 bg-success/10 border border-success/20 rounded-lg">
                            <span className="font-medium">{student.id}</span>
                            <div className="flex items-center space-x-2">
                              <Badge variant="outline" className="text-xs">
                                Cohort {student.cohort}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {student.timestamp.toLocaleTimeString()}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                      )}
                    </div>
                  </TabsContent>
                  
                  <TabsContent value="absent" className="mt-4">
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {isLoadingRoster ? (
                        <p className="text-center text-muted-foreground py-8">Loading roster...</p>
                      ) : (
                      {filteredAbsentStudents.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">
                          All students are present!
                        </p>
                      ) : (
                        filteredAbsentStudents.map((studentId) => {
                          const rosterEntry = roster.find(r => r.student_id === studentId);
                          const cohort = rosterEntry ? rosterEntry.cohort : (studentId.includes('C') ? 'C' : 'B');
                          return (
                            <div key={studentId} className="flex items-center justify-between p-2 bg-destructive/10 border border-destructive/20 rounded-lg">
                              <span className="font-medium">{studentId}</span>
                              <Badge variant="outline" className="text-xs">
                                Cohort {cohort}
                              </Badge>
                            </div>
                          );
                        })
                      )}
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TADashboard;