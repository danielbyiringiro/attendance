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
  CalendarClock,
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
import { getOpenSessionSummary } from "@/lib/api/sessions";
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

type TATab =
  | "attendance"
  | "analytics"
  | "students"
  | "sessions"
  | "schedule"
  | "classes";

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
  { id: "schedule", label: "Schedule", icon: CalendarClock },
  { id: "classes", label: "Classes", icon: GraduationCap },
];

// Keys used to persist the TA dashboard across page reloads. sessionStorage is
// used (not localStorage) so the session is cleared when the tab/browser closes,
// which keeps attendance data from lingering on shared machines.
// TA authentication is handled by Supabase Auth; we only persist which tab the
// TA last viewed so a reload returns them to the same section.
const TA_TAB_KEY = "ta_active_tab";

const Index = () => {
  // The public countdown, from get_open_session_summary. There is no shared
  // PIN and no shared timer any more: each session carries its own, and the
  // logged-out page is told only that a window is open and when it shuts.
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [isTimeUp, setIsTimeUp] = useState(true);
  const [isTA, setIsTA] = useState(false);
  const [showTALogin, setShowTALogin] = useState(false);
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  const [taTab, setTaTab] = useState<TATab>(
    () => (sessionStorage.getItem(TA_TAB_KEY) as TATab) || "attendance",
  );

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

  // The pre-login countdown. Polled rather than subscribed: it reads an RPC
  // that deliberately exposes only a count and a closing time, and there is no
  // table behind it to watch. Twenty seconds is well inside the shortest
  // sign-up window anyone would set.
  useEffect(() => {
    if (isTA) return;
    let cancelled = false;

    const check = async () => {
      try {
        const summary = await getOpenSessionSummary();
        if (cancelled) return;
        const closesAt = summary.closes_at
          ? new Date(summary.closes_at).getTime()
          : 0;
        const left = closesAt
          ? Math.max(0, Math.floor((closesAt - Date.now()) / 1000))
          : 0;
        setSecondsLeft(left);
        setIsTimeUp(summary.open_count === 0 || left === 0);
      } catch (e) {
        // A failed check must not claim a window is open.
        console.error("Could not check for open sessions:", e);
        if (!cancelled) setIsTimeUp(true);
      }
    };

    void check();
    const poll = setInterval(check, 20_000);
    // Tick the displayed number down between polls so it does not sit still.
    const tick = setInterval(
      () =>
        setSecondsLeft((n) => {
          if (n <= 1) {
            setIsTimeUp(true);
            return 0;
          }
          return n - 1;
        }),
      1000,
    );

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [isTA]);

  const handleTALogout = async () => {
    await supabase.auth.signOut();
    sessionStorage.removeItem(TA_TAB_KEY);
    // The roster and today's attendance live in TADashboard now and unmount
    // with it, so there is nothing left to clear here.
  };


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
            <TADashboard activeSection={taTab} onLogout={handleTALogout} />
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
        timeLimit={secondsLeft}
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
