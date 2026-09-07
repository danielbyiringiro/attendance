import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin from "@/components/StudentLogin";
import TADashboard from "@/components/TADashboard";
import TALogin from "@/components/TALogin";
import StudentDashboard from "@/components/StudentDashboard";
import ClassSwitcher from "@/components/ta/ClassSwitcher";
import { ClassProvider } from "@/lib/classContext";
import {
  BarChart3,
  CalendarDays,
  Clock,
  GraduationCap,
  History,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ensureStaff } from "@/lib/api/staff";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

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

type TATab = "attendance" | "analytics" | "students" | "sessions" | "classes";

// One row per sidebar entry. Previously these were four hand-duplicated
// 14-line SidebarMenuItem blocks, so adding a section meant a fifth copy-paste
// and a fifth chance to wire the wrong tab to the wrong label.
const TA_TABS: ReadonlyArray<{
  id: TATab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "attendance", label: "Attendance", icon: CalendarDays },
  { id: "analytics", label: "Attendance Analytics", icon: BarChart3 },
  { id: "students", label: "Students", icon: Users },
  { id: "sessions", label: "Class Sessions", icon: Clock },
  { id: "classes", label: "Classes", icon: GraduationCap },
];

// Keys used to persist the TA dashboard across page reloads. sessionStorage is
// used (not localStorage) so the session is cleared when the tab/browser closes,
// which keeps attendance data from lingering on shared machines.
// TA authentication is handled by Supabase Auth; we only persist which tab the
// TA last viewed so a reload returns them to the same section.
const TA_TAB_KEY = "ta_active_tab";

const Index = () => {
  const [currentPin, setCurrentPin] = useState("1234");
  const [timeLimit, setTimeLimit] = useState(300); // 5 minutes in seconds
  const [isTimeUp, setIsTimeUp] = useState(true);
  const [presentStudents, setPresentStudents] = useState<Student[]>([]);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [isTA, setIsTA] = useState(false);
  const [showTALogin, setShowTALogin] = useState(false);
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  const [taTab, setTaTab] = useState<TATab>(
    () => (sessionStorage.getItem(TA_TAB_KEY) as TATab) || "attendance",
  );
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

  // Source of truth for TA access: a valid Supabase Auth session. Supabase
  // persists the session across reloads automatically, so refreshing keeps the
  // TA logged in. Any authenticated user is a TA (TA accounts are provisioned
  // in the Supabase dashboard; there is no public signup).
  useEffect(() => {
    // A staff row is what current_staff_id() resolves to, and without one an
    // account cannot create a class. The bootstrap in migration 003 only ran
    // over the accounts that existed then, so anyone provisioned since needs
    // this. Idempotent, and deliberately not awaited: failing to record the
    // staff row must not block signing in.
    const claimStaffRow = () => {
      void ensureStaff().catch((e) => {
        console.error("ensure_staff failed:", e);
      });
    };

    supabase.auth.getSession().then(({ data }) => {
      setIsTA(!!data.session);
      if (data.session) claimStaffRow();
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsTA(!!session);
      if (session) claimStaffRow();
    });

    return () => subscription.unsubscribe();
  }, []);

  // Students mark attendance through a server-side RPC. The PIN is verified
  // inside the database (see sql/secure_pin.sql), so the browser never needs to
  // know the PIN and all rules (window open, time limit, roster, duplicates)
  // are enforced server-side and can't be bypassed from the console.
  const handleStudentMarkAttendance = async (
    studentId: string,
    pin: string,
  ): Promise<{ success: boolean; error?: string; name?: string }> => {
    const { data, error } = await supabase.rpc("mark_attendance", {
      p_student_id: studentId.trim(),
      p_pin: pin,
    });

    if (error) {
      console.error("mark_attendance failed:", error);
      return {
        success: false,
        error: "Something went wrong. Please try again.",
      };
    }

    const result = (data ?? {}) as {
      success?: boolean;
      error?: string;
      name?: string;
    };

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to record attendance. Please try again.",
      };
    }

    return { success: true, name: result.name };
  };

  // TA manual override — marks a student present without a PIN. Only reachable
  // from the authenticated dashboard.
  const handleTAMarkAttendance = async (
    studentId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    if (presentStudents.find((s) => s.id === studentId)) {
      return { success: false, error: "Student is already marked present." };
    }

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
      return { success: false, error: "Student is not on the roster." };
    }

    const { error } = await supabase.from("present_students").insert({
      student_id: studentId,
      cohort: rosterEntry.cohort,
      timestamp: new Date().toISOString(),
    });
    if (error) {
      console.error("Failed to insert attendance:", error);
      return {
        success: false,
        error: "Failed to record attendance. Please try again.",
      };
    }

    return { success: true };
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
      // Don't read the pin column back (anon has no SELECT on it). We already
      // know the value we just wrote.
      .select("id, time_limit_seconds, session_start, is_open")
      .single();

    if (!error && data) {
      setCurrentPin(newPin);
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
      .select("id, time_limit_seconds, session_start, is_open")
      .single();

    if (!error && data) {
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

  // Persist tab selection so a reload returns the TA to the same section.
  const handleSetTaTab = (tab: TATab) => {
    setTaTab(tab);
    sessionStorage.setItem(TA_TAB_KEY, tab);
  };

  const handleTALogin = () => {
    // isTA flips to true via the auth listener below once the session exists.
    setShowTALogin(false);
    handleSetTaTab("attendance");
  };

  const handleTALogout = async () => {
    await supabase.auth.signOut();
    sessionStorage.removeItem(TA_TAB_KEY);
    // Drop sensitive data from memory when leaving the dashboard.
    setPresentStudents([]);
    setRoster([]);
  };

  // Initialize session on first load
  useEffect(() => {
    // Load shared session state (do not create/modify on load)
    (async () => {
      // SECURITY: never select the pin column on the public page. The anon role
      // no longer has read access to it (see sql/secure_pin.sql); the PIN is
      // verified server-side via the mark_attendance RPC.
      const { data: ss, error: ssError } = await supabase
        .from("session_state")
        .select("id, time_limit_seconds, session_start, is_open")
        .eq("id", 1)
        .maybeSingle();

      if (ssError) {
        console.error("Failed to load session_state:", ssError);
      }

      if (ss) {
        setSessionId(ss.id);
        setTimeLimit(ss.time_limit_seconds);
        setSessionStartTime(new Date(ss.session_start));
        setIsOpen(!!ss.is_open);
        // If closed, mark as time up; otherwise compute remaining time
        const elapsed = Math.floor(
          (Date.now() - new Date(ss.session_start).getTime()) / 1000,
        );
        setIsTimeUp(!ss.is_open || elapsed >= ss.time_limit_seconds);
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
              // pin is intentionally absent from this payload for the anon role.
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

    return () => {
      supabase.removeChannel(sessionChannel);
    };
  }, []);

  // Load and subscribe to attendance + roster data ONLY when an authenticated TA
  // is viewing the dashboard. Students never receive this data, so it cannot be
  // read from the browser console on the public check-in page.
  useEffect(() => {
    if (!isTA) return;

    let cancelled = false;

    const loadDashboardData = async () => {
      // Read the current PIN to display it. Only authenticated TAs can SELECT the
      // pin column (RLS + column grant), so students never receive it.
      const { data: pinRow, error: pinError } = await supabase
        .from("session_state")
        .select("pin")
        .eq("id", 1)
        .maybeSingle();
      if (pinError) {
        console.error("Failed to load session PIN:", pinError);
      } else if (pinRow?.pin && !cancelled) {
        setCurrentPin(pinRow.pin);
      }

      // Load today's attendance using a timestamp range (independent of session_date)
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
      } else if (data && !cancelled) {
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
      } else if (rosterData && !cancelled) {
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
    };

    loadDashboardData();

    // Keep the roster in sync in real time while the TA is logged in.
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
              setRoster((prev) => {
                const existing = prev.find(
                  (s) => s.student_id === newStudent.student_id,
                );
                if (existing) {
                  return prev.map((s) =>
                    s.student_id === newStudent.student_id ? newStudent : s,
                  );
                } else {
                  return [...prev, newStudent].sort((a, b) =>
                    a.student_id.localeCompare(b.student_id),
                  );
                }
              });
            }
          } else {
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

    // Reflect new check-ins live in the dashboard as students mark attendance.
    const presentChannel = supabase
      .channel("present_students_changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "present_students" },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const ts = new Date(row.timestamp);
          const todayStr = new Date().toISOString().slice(0, 10);
          // Only surface check-ins for the current day.
          if (ts.toISOString().slice(0, 10) !== todayStr) return;
          setPresentStudents((prev) => {
            if (prev.some((s) => s.id === row.student_id)) return prev;
            return [
              ...prev,
              {
                id: row.student_id,
                cohort: row.cohort,
                timestamp: ts,
                name: "",
              },
            ];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(rosterChannel);
      supabase.removeChannel(presentChannel);
    };
  }, [isTA]);

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
      <ClassProvider>
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="offcanvas">
          <SidebarHeader>
            <div className="px-2 pt-3 pb-1 text-sm font-semibold">TA Dashboard</div>
            <ClassSwitcher />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {TA_TABS.map(({ id, label, icon: Icon }) => (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton
                        asChild
                        isActive={taTab === id}
                        tooltip={label}
                      >
                        <button type="button" onClick={() => handleSetTaTab(id)}>
                          <Icon />
                          <span>{label}</span>
                        </button>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <SidebarInset>
          <div className="flex flex-1 flex-col">
            <SidebarTrigger className="fixed left-4 top-10 z-50" />
            <TADashboard
              activeSection={taTab}
              presentStudents={presentStudents}
              roster={roster}
              currentPin={currentPin}
              timeLimit={timeLimit}
              isTimeUp={isTimeUp}
              onSetPin={handleSetPin}
              onSetTimeLimit={handleSetTimeLimit}
              onResetAttendance={handleResetAttendance}
              onLogout={handleTALogout}
              onMarkAttendance={handleTAMarkAttendance}
            />
          </div>
        </SidebarInset>
      </SidebarProvider>
      </ClassProvider>
    );
  }

  if (showStudentDashboard) {
    return <StudentDashboard onBack={() => setShowStudentDashboard(false)} />;
  }

  return (
    <div className="relative">
      <StudentLogin
        timeLimit={getTimeLeft()}
        isTimeUp={isTimeUp}
        onMarkAttendance={handleStudentMarkAttendance}
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
      {showTALogin && (
        <TALogin
          onLogin={handleTALogin}
          onCancel={() => setShowTALogin(false)}
        />
      )}
    </div>
  );
};

export default Index;
