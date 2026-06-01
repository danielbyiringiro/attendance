import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import Index from "./pages/Index";
import Analytics from "./pages/Analytics";
import NotFound from "./pages/NotFound";
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
import { BarChart3, CalendarDays } from "lucide-react";
import { useState } from "react";

const queryClient = new QueryClient();

const AppShell = () => {
  const location = useLocation();
  const [isAdmin, setIsAdmin] = useState(false);

  const isAttendanceActive =
    location.pathname === "/" || location.pathname.startsWith("/attendance");
  const isAnalyticsActive = location.pathname.startsWith("/analytics");

  const title = isAnalyticsActive ? "Attendance Analytics" : "Attendance";

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader>
          <div className="px-2 py-1 text-sm font-semibold">Attendance Manager</div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isAttendanceActive} tooltip="Attendance">
                    <NavLink to="/attendance" end>
                      <CalendarDays />
                      <span>Attendance</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {isAdmin && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isAnalyticsActive}
                      tooltip="Attendance Analytics"
                    >
                      <NavLink to="/analytics" end>
                        <BarChart3 />
                        <span>Attendance Analytics</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b bg-background px-4">
          {isAdmin && <SidebarTrigger />}
          <div className="text-sm font-medium">{title}</div>
        </header>

        <div className="flex flex-1 flex-col">
          <Routes>
            <Route path="/" element={<Navigate to="/attendance" replace />} />
            <Route path="/attendance" element={<Index onAdminChange={setIsAdmin} />} />
            <Route
              path="/analytics"
              element={
                isAdmin ? <Analytics /> : <Navigate to="/attendance" replace />
              }
            />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
