import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import StudentLogin, { type MarkResult } from "@/components/StudentLogin";
import ThemeToggle from "@/components/ThemeToggle";
import AccessibilitySettings from "@/components/AccessibilitySettings";
import TADashboard from "@/components/TADashboard";
import TALogin from "@/components/TALogin";
import StudentDashboard from "@/components/StudentDashboard";
import PausedNotice from "@/components/PausedNotice";
import {
  PauseWarningDialog,
  PauseWarningStrip,
} from "@/components/PauseWarning";
import { useServiceState } from "@/lib/useServiceState";
import ClassSwitcher from "@/components/ta/ClassSwitcher";
import {
  restoreNavigation,
  type ClassTab,
  type TATab,
} from "@/lib/taNavigation";
import { ClassProvider } from "@/lib/classContext";
import {
  BarChart3,
  CalendarDays,
  CircleHelp,
  GraduationCap,
  History,
  ShieldCheck,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ensureStaff, type StaffIdentity } from "@/lib/api/staff";
import { getHelp } from "@/lib/api/help";
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
  // Sessions, Weekly pattern and Settings for the chosen class. The list of
  // every class is not a sidebar item: it opens from the class switcher.
  { id: "class", label: "Class", icon: GraduationCap },
  // 049. Last before Admin, and available to everyone: it is where the videos
  // live permanently and where announcements are read. A first-run modal alone
  // would be a video seen once and never found again.
  { id: "help", label: "Help", icon: CircleHelp },
  // Only rendered for an admin — see the filter where TA_TABS is mapped.
  { id: "admin", label: "Admin", icon: ShieldCheck, adminOnly: true },
];

// Keys used to persist the TA dashboard across page reloads. sessionStorage is
// used (not localStorage) so the session is cleared when the tab/browser closes,
// which keeps attendance data from lingering on shared machines.
// TA authentication is handled by Supabase Auth; we only persist which tab the
// TA last viewed so a reload returns them to the same section.
const TA_TAB_KEY = "ta_active_tab";
// Which tab of the Class page, kept beside it for the same reason.
const CLASS_TAB_KEY = "ta_class_tab";

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
  unreadHelp = 0,
  frozen = false,
  onSelect,
}: {
  tabs: typeof TA_TABS;
  active: TATab;
  /** 049: announcements this account has not read. 0 shows nothing. */
  unreadHelp?: number;
  /**
   * 055: the app is paused. Every section but Admin is inert, because none of
   * them can do anything — and leaving them live makes a deliberate pause look
   * like a broken app.
   */
  frozen?: boolean;
  onSelect: (tab: TATab) => void;
}) => {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {tabs.map(({ id, label, icon: Icon }) => {
        const blocked = frozen && id !== "admin";
        return (
        <SidebarMenuItem key={id}>
          <SidebarMenuButton
            asChild
            isActive={active === id}
            tooltip={blocked ? `${label} — paused` : label}
          >
            <button
              type="button"
              disabled={blocked}
              className={blocked ? "cursor-not-allowed opacity-40" : undefined}
              onClick={() => {
                if (blocked) return;
                onSelect(id);
                if (isMobile) setOpenMobile(false);
              }}
            >
              <Icon />
              <span>{label}</span>
              {/* The count, not just a dot: "3 things you have not read" is
                  worth knowing before deciding whether to look now. */}
              {id === "help" && unreadHelp > 0 && (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                  {unreadHelp}
                </span>
              )}
            </button>
          </SidebarMenuButton>
        </SidebarMenuItem>
        );
      })}
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
  // 055. Asked here rather than inside StudentLogin: the notice replaces that
  // whole screen, and a hook has to run before the early returns below.
  const service = useServiceState();
  const [identity, setIdentity] = useState<StaffIdentity | null>(null);
  const [isResolvingIdentity, setIsResolvingIdentity] = useState(false);
  /*
   * Why the account could not be checked, when it could not.
   *
   * Before this, a failed or hung lookup left `identity` null, and the render
   * treats a signed-in user with no identity as still loading. So any failure
   * of ensure_staff showed "Checking your account…" forever, with nothing on
   * screen to say it had failed, nothing to retry and no way to sign out.
   */
  const [identityError, setIdentityError] = useState<string | null>(null);
  /*
   * 049: announcements this account has not read, for the sidebar.
   *
   * Fetched once when the dashboard appears rather than polled: an
   * announcement is not urgent, and a number that only moves on a reload is
   * both honest and free. Help clears it as soon as it is opened.
   */
  const [unreadHelp, setUnreadHelp] = useState(0);

  // Only once the account is actually in, because get_help answers for whoever
  // is asking and a pending account has nothing to be told yet. A failure is
  // swallowed: an unread badge is the least important thing on this screen, and
  // nobody should get an error toast because a count could not be fetched.
  useEffect(() => {
    if (!isTA || identity?.status !== "approved") return;
    let live = true;
    getHelp()
      .then((help) => {
        if (live) setUnreadHelp(help.unread);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isTA, identity?.status]);
  const [showTALogin, setShowTALogin] = useState(false);
  const [showStudentDashboard, setShowStudentDashboard] = useState(false);
  // Through restoreNavigation, which also moves a tab remembered from before
  // Classes, Schedule and Class Sessions became one Class page.
  const [restored] = useState(() =>
    restoreNavigation(
      sessionStorage.getItem(TA_TAB_KEY),
      sessionStorage.getItem(CLASS_TAB_KEY),
    ),
  );
  const [taTab, setTaTab] = useState<TATab>(restored.tab);
  const [classTab, setClassTab] = useState<ClassTab>(restored.classTab);

  // Who is signed in. Supabase persists the session across reloads, so
  // refreshing keeps the TA logged in. Any authenticated user is a TA — TA
  // accounts are provisioned in the Supabase dashboard, there is no public
  // signup.
  /*
   * Who is signed in, and whether they may use the dashboard.
   *
   * A lookup that fails, or does not come back, now ends in an error the user
   * can see and act on instead of an endless "Checking your account…". Fifteen
   * seconds is far longer than ensure_staff ever takes when it works, so
   * reaching it means something is wrong rather than slow.
   */
  const resolveIdentity = useCallback(async () => {
    setIsResolvingIdentity(true);
    setIdentityError(null);
    try {
      const identity = await new Promise<StaffIdentity>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The account check did not respond.")),
          15_000,
        );
        ensureStaff().then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      setIdentity(identity);
    } catch (e) {
      console.error("ensure_staff failed:", e);
      // Still never promotes anybody: no identity means no dashboard. What
      // changed is that the reason is shown rather than a spinner.
      setIdentity(null);
      setIdentityError(e instanceof Error ? e.message : "Unexpected error.");
    } finally {
      setIsResolvingIdentity(false);
    }
  }, []);

  useEffect(() => {
    // A staff row is what current_staff_id() resolves to, and without one an
    // account cannot create a class. The bootstrap in migration 003 only ran
    // over the accounts that existed then, so anyone provisioned since needs
    // this. Idempotent, and deliberately not awaited: failing to record the
    // staff row must not block signing in.
    // A staff row is what current_staff_id() resolves to, and since 020 it also
    // carries the approval that decides whether the account can do anything.
    // Awaited now, unlike before: the answer determines which screen renders.
    supabase.auth.getSession().then(({ data }) => {
      setIsTA(!!data.session);
      if (data.session) void resolveIdentity();
      else setIdentity(null);
    });

    /*
     * Only a real sign-in or sign-out changes who this is.
     *
     * The listener used to re-run the lookup on every event, including the
     * INITIAL_SESSION that getSession above already handles — so every load
     * fired ensure_staff twice — and TOKEN_REFRESHED, which a deployed tab
     * with an older session hits on load and a fresh localhost session does
     * not.
     *
     * And the lookup is deferred out of the callback with setTimeout. The
     * callback runs while the auth client is still processing the change, and
     * calling back into Supabase from inside it can wait on that same work;
     * stepping out of the callback first removes the question entirely.
     */
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setIsTA(!!session);
      if (!session) {
        setIdentity(null);
        setIdentityError(null);
        return;
      }
      if (event === "SIGNED_IN") {
        setTimeout(() => void resolveIdentity(), 0);
      }
    });

    return () => subscription.unsubscribe();
  }, [resolveIdentity]);

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
  const handleSetTaTab = (tab: TATab, nextClassTab?: ClassTab) => {
    setTaTab(tab);
    sessionStorage.setItem(TA_TAB_KEY, tab);
    if (nextClassTab) {
      setClassTab(nextClassTab);
      sessionStorage.setItem(CLASS_TAB_KEY, nextClassTab);
    }
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
    sessionStorage.removeItem(CLASS_TAB_KEY);
    // The roster and today's attendance live in TADashboard now and unmount
    // with it, so there is nothing left to clear here.
  };


  // Signed in, but the account is not approved. It is not an error state and
  // must not read like one.
  if (isTA && identity && identity.status !== "approved") {
    return <AccountPending identity={identity} onSignOut={handleTALogout} />;
  }

  if (isTA && identityError && !isResolvingIdentity) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-6">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-lg font-semibold">
            Could not check your account
          </p>
          <p className="text-sm text-muted-foreground">{identityError}</p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => void resolveIdentity()}>Try again</Button>
            <Button variant="outline" onClick={handleTALogout}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
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
            <ClassSwitcher onOpenAllClasses={() => handleSetTaTab("classes")} />
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
                  unreadHelp={unreadHelp}
                  frozen={service.paused}
                  onSelect={handleSetTaTab}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <SidebarInset>
          <div className="flex flex-1 flex-col">
            <SidebarTrigger className="fixed left-4 top-10 z-50" />
            <TADashboard
              activeSection={taTab}
              classTab={classTab}
              isAdmin={identity?.is_admin ?? false}
              onNavigate={handleSetTaTab}
              onHelpRead={() => setUnreadHelp(0)}
              onLogout={handleTALogout}
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

  // 055. In place of the check-in box, not beside it: a form that cannot work
  // invites twenty attempts and a queue at the front of the room. Their own
  // history stays reachable above — reading a record changes nothing.
  if (service.paused) {
    return <PausedNotice message={service.message} endsAt={service.ends_at} />;
  }

  return (
    <div className="relative">
      {/* 056. A pause that is coming, not one that has arrived: the check-in
          box still works, and saying so early is the whole point. */}
      {service.state === "scheduled" && (
        <div className="mx-auto max-w-md px-4 pt-4">
          <PauseWarningStrip service={service} />
        </div>
      )}
      <PauseWarningDialog service={service} />

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
        {/* 050: labelled. An unmarked gear in the corner of a student's page
            is an invitation to find out what it does, and what it did was put
            them in the approval queue. */}
        <Button
          onClick={() => setShowTALogin(true)}
          variant="ghost"
          size="sm"
          title="Staff sign in — students do not need an account"
          aria-label="Staff sign in"
        >
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
