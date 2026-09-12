import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin, { type MarkResult } from "@/components/StudentLogin";
import ThemeToggle from "@/components/ThemeToggle";
import AccessibilitySettings from "@/components/AccessibilitySettings";
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
  ShieldCheck,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ensureStaff, type StaffIdentity } from "@/lib/api/staff";
import AccountPending from "@/components/AccountPending";
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
  useSidebar,
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
  | "classes"
  | "admin";

// One row per sidebar entry. Previously these were four hand-duplicated
// 14-line SidebarMenuItem blocks, so adding a section meant a fifth copy-paste
// and a fifth chance to wire the wrong tab to the wrong label.
const TA_TABS: ReadonlyArray<{
  id: TATab;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}> = [
  { id: "attendance", label: "Attendance", icon: CalendarDays },
  { id: "analytics", label: "Attendance Analytics", icon: BarChart3 },
  { id: "students", label: "Students", icon: Users },
  { id: "sessions", label: "Class Sessions", icon: Clock },
  { id: "schedule", label: "Schedule", icon: CalendarClock },
  { id: "classes", label: "Classes", icon: GraduationCap },
  // Only rendered for an admin — see the filter where TA_TABS is mapped.
  { id: "admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

// Keys used to persist the TA dashboard across page reloads. sessionStorage is
// used (not localStorage) so the session is cleared when the tab/browser closes,
// which keeps attendance data from lingering on shared machines.
// TA authentication is handled by Supabase Auth; we only persist which tab the
// TA last viewed so a reload returns them to the same section.
const TA_TAB_KEY = "ta_active_tab";

/**
 * The navigation list, as its own component so it can reach the sidebar.
 *
 * On a phone the sidebar is a sheet laid over the page. Choosing a section
 * changed the section underneath and left the sheet sitting on top of it, so
 * the tap appeared to do nothing and you had to dismiss the sheet yourself to
 * see what you had chosen. On a desktop the sidebar sits beside the content and
 * should stay put, which is why this closes only the mobile one.
 *
 * useSidebar reads a context SidebarProvider creates, so this cannot live in
 * Index — Index renders the provider and is therefore outside it.
 */
const TANav = ({
  tabs,
  active,
  onSelect,
}: {
  tabs: typeof TA_TABS;
  active: TATab;
  onSelect: (tab: TATab) => void;
}) => {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {tabs.map(({ id, label, icon: Icon }) => (
        <SidebarMenuItem key={id}>
          <SidebarMenuButton asChild isActive={active === id} tooltip={label}>
            <button
              type="button"
              onClick={() => {
                onSelect(id);
                if (isMobile) setOpenMobile(false);
              }}
            >
              <Icon />
              <span>{label}</span>
            </button>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
};

const Index = () => {
  // Informational only — see the effect below.
  const [openCount, setOpenCount] = useState(0);
  // A session is no longer the same thing as being a TA. Since migration 020
  // an account can exist, be signed in, and still be waiting for an admin —
  // `isTA = !!session` would let a pending account straight into the dashboard.
  const [isTA, setIsTA] = useState(false);
  const [identity, setIdentity] = useState<StaffIdentity | null>(null);
  const [isResolvingIdentity, setIsResolvingIdentity] = useState(false);
  const [showTALogin, setShowTALogin] = useState(false);
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  const [taTab, setTaTab] = useState<TATab>(
    () => (sessionStorage.getItem(TA_TAB_KEY) as TATab) || "attendance",
  );

  // Who is signed in. Supabase persists the session across reloads, so
  // refreshing keeps the TA logged in. Any authenticated user is a TA — TA
  // accounts are provisioned in the Supabase dashboard, there is no public
  // signup.
  useEffect(() => {
    // A staff row is what current_staff_id() resolves to, and without one an
    // account cannot create a class. The bootstrap in migration 003 only ran
    // over the accounts that existed then, so anyone provisioned since needs
    // this. Idempotent, and deliberately not awaited: failing to record the
    // staff row must not block signing in.
    // A staff row is what current_staff_id() resolves to, and since 020 it also
    // carries the approval that decides whether the account can do anything.
    // Awaited now, unlike before: the answer determines which screen renders.
    const resolve = async () => {
      setIsResolvingIdentity(true);
      try {
        setIdentity(await ensureStaff());
      } catch (e) {
        console.error("ensure_staff failed:", e);
        // Failing to resolve must not silently promote somebody: treat it as
        // not yet approved rather than assuming the best.
        setIdentity(null);
      } finally {
        setIsResolvingIdentity(false);
      }
    };

    supabase.auth.getSession().then(({ data }) => {
      setIsTA(!!data.session);
      if (data.session) void resolve();
      else setIdentity(null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsTA(!!session);
      if (session) void resolve();
      else setIdentity(null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Students mark attendance through a server-side RPC. The PIN is verified
  // inside the database, so the browser never needs to know it and every rule
  // — which session the PIN belongs to, whether its window is open, whether
  // the student is enrolled in that cohort — is enforced where it cannot be
  // bypassed from the console.
  const handleStudentMarkAttendance = async (
    studentId: string,
    pin: string,
  ): Promise<MarkResult> => {
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

    const result = (data ?? {}) as MarkResult;

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to record attendance. Please try again.",
      };
    }

    // class and cohort come back so the confirmation can name which class was
    // marked: the PIN decides that, and a student in two courses cannot
    // otherwise tell.
    return {
      success: true,
      name: result.name,
      class: result.class,
      // Rebuilt field by field rather than spread, so anything the RPC adds
      // has to be named here too — this one was added by migration 025.
      class_code: result.class_code,
      cohort: result.cohort,
      state: result.state,
    };
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

  // How many check-in windows are open anywhere, for the status line on the
  // public page. Polled rather than subscribed: it reads an RPC that
  // deliberately exposes only a count and a closing time, and there is no
  // table behind it to watch.
  //
  // It is not a gate. A single countdown made sense when the installation had
  // one class; with several it is wrong in both directions — it locks out a
  // student whose own class IS open because another one is not, and it invites
  // a student whose class is NOT open to type into a form counting down
  // somebody else's window. mark_attendance decides.
  useEffect(() => {
    if (isTA) return;
    let cancelled = false;

    const check = async () => {
      try {
        const summary = await getOpenSessionSummary();
        if (!cancelled) setOpenCount(summary.open_count);
      } catch (e) {
        // A failed check reports nothing open rather than inventing a number.
        // It is a hint either way — the form is not gated on it.
        console.error("Could not check for open sessions:", e);
        if (!cancelled) setOpenCount(0);
      }
    };

    void check();
    const poll = setInterval(check, 20_000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [isTA]);

  const handleTALogout = async () => {
    await supabase.auth.signOut();
    setIdentity(null);
    sessionStorage.removeItem(TA_TAB_KEY);
    // The roster and today's attendance live in TADashboard now and unmount
    // with it, so there is nothing left to clear here.
  };


  // Signed in, but the account is not approved. It is not an error state and
  // must not read like one.
  if (isTA && identity && identity.status !== "approved") {
    return <AccountPending identity={identity} onSignOut={handleTALogout} />;
  }

  if (isTA && (isResolvingIdentity || !identity)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30">
        <p className="text-sm text-muted-foreground">Checking your account…</p>
      </div>
    );
  }

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
                <TANav
                  tabs={TA_TABS.filter(
                    (t) => !t.adminOnly || identity?.is_admin,
                  )}
                  active={taTab}
                  onSelect={handleSetTaTab}
                />
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
        openCount={openCount}
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

      {/* Theme and TA access */}
      <div className="fixed right-4 top-4 flex items-center gap-1 opacity-70 transition-opacity hover:opacity-100">
        <AccessibilitySettings />
        <ThemeToggle />
        <Button onClick={() => setShowTALogin(true)} variant="ghost" size="sm">
          <Settings className="h-4 w-4" />
        </Button>
      </div>

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
