import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, LogOut, MailX, ShieldX } from "lucide-react";
import type { StaffIdentity } from "@/lib/api/staff";
import ThemeToggle from "@/components/ThemeToggle";
import AccessibilitySettings from "@/components/AccessibilitySettings";

interface AccountPendingProps {
  identity: StaffIdentity;
  onSignOut: () => void;
}

/**
 * What somebody sees when they have an account but it does not work yet.
 *
 * Three different situations, and they deserve different words. Waiting is not
 * a failure and should not read like one; being turned down should say so
 * plainly rather than leaving somebody refreshing; and an address outside the
 * accepted domains is nobody's mistake but the person's, which they can only
 * fix if they are told what the domains are.
 */
const AccountPending = ({ identity, onSignOut }: AccountPendingProps) => {
  const copy = {
    pending: {
      icon: Clock,
      tone: "text-primary",
      ring: "border-primary/30 bg-primary/5",
      title: "Waiting for approval",
      body: "Your account exists. An admin has to approve it before you can see any classes — you will not get an email, so check back later or ask them directly.",
    },
    rejected: {
      icon: ShieldX,
      tone: "text-destructive",
      ring: "border-destructive/30 bg-destructive/5",
      title: "Access declined",
      body: "An admin has declined this account. If you think that is a mistake, speak to them — they can approve it later without you signing up again.",
    },
    domain_not_allowed: {
      icon: MailX,
      tone: "text-warning",
      ring: "border-warning/40 bg-warning/10",
      title: "That email is not accepted here",
      body: "This installation only accepts accounts from certain email domains, and yours is not one of them. Sign out and try again with your institutional address.",
    },
    approved: {
      icon: Clock,
      tone: "text-primary",
      ring: "border-primary/30 bg-primary/5",
      title: "Setting up…",
      body: "One moment.",
    },
  }[identity.status];

  const Icon = copy.icon;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex justify-end">
          <AccessibilitySettings />
          <ThemeToggle />
        </div>

        <Card className={`border-2 shadow-medium ${copy.ring}`}>
          <CardContent className="space-y-4 pt-6 text-center">
            <Icon className={`mx-auto h-10 w-10 ${copy.tone}`} />

            <div className="space-y-1">
              <h1 className="text-xl font-bold">{copy.title}</h1>
              {identity.email && (
                <p className="text-sm text-muted-foreground">
                  {identity.email}
                </p>
              )}
            </div>

            <p className="text-sm text-muted-foreground">{copy.body}</p>

            {identity.decision_note && (
              <p className="rounded-md border bg-card px-3 py-2 text-left text-sm">
                <span className="text-muted-foreground">Note from the admin: </span>
                {identity.decision_note}
              </p>
            )}

            <Button variant="outline" className="w-full" onClick={onSignOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AccountPending;
