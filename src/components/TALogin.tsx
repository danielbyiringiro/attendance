import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabase";
import { listAllowedDomains } from "@/lib/api/staff";
import Logo from "@/components/Logo";

interface TALoginProps {
  onLogin: () => void;
  onCancel?: () => void;
}

type Mode = "signin" | "signup";

/**
 * Sign in, or ask for an account.
 *
 * Accounts used to be created by hand in the Supabase dashboard. Anyone may now
 * request one, but requesting is not the same as getting: migration 020 makes a
 * new account `pending` and an admin decides. The screen after this one says so.
 */
const TALogin = ({ onLogin, onCancel }: TALoginProps) => {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const { toast } = useToast();

  // Read before anyone types, so the rule is visible rather than discovered by
  // being refused. Readable to anon: it is not a secret which institution this
  // installation belongs to.
  useEffect(() => {
    if (mode !== "signup") return;
    listAllowedDomains()
      .then((rows) => setDomains(rows.map((r) => r.domain)))
      .catch(() => setDomains([]));
  }, [mode]);

  const domainOf = (address: string) =>
    address.trim().toLowerCase().split("@")[1] ?? "";

  const domainLooksWrong =
    mode === "signup" &&
    domains.length > 0 &&
    email.includes("@") &&
    !domains.includes(domainOf(email));

  const handleSignIn = async () => {
    // Credentials are verified by Supabase Auth, not in the browser. The
    // resulting session is what unlocks TA-only data via RLS.
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      toast({
        title: "Access denied",
        description: error.message || "Invalid email or password.",
        variant: "destructive",
      });
      setPassword("");
      return;
    }

    // Deliberately no "welcome" toast: whether this account can do anything is
    // decided after ensure_staff runs, and congratulating somebody who is about
    // to be told they are waiting for approval reads badly.
    onLogin();
  };

  const handleSignUp = async () => {
    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "Use at least 8 characters.",
        variant: "destructive",
      });
      return;
    }

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Read back by migration 021's ensure_staff rather than passed from
        // here: with email confirmation on there is no session yet, and the
        // browser that eventually runs ensure_staff is a different one that
        // never saw this form.
        data: { display_name: displayName.trim() || null },
        // Where the confirmation link comes back to. Without this Supabase
        // uses the project's Site URL, which is one value for every
        // deployment — so a link mailed from a preview build, or from
        // localhost during development, lands on production instead.
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) {
      toast({
        title: "Could not create the account",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Account requested",
      description:
        "If your email needs confirming, check your inbox. An admin then has to approve you before you can use the dashboard.",
    });
    onLogin();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast({
        title: "Email and password needed",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === "signin") await handleSignIn();
      else await handleSignUp();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md border-2 shadow-medium">
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <Logo className="h-14 w-14 shadow-soft" />
          </div>
          <CardTitle className="text-2xl">
            {mode === "signin" ? "TA Access" : "Request an account"}
          </CardTitle>
          <p className="text-muted-foreground">
            {mode === "signin"
              ? "Sign in with your TA account to access the dashboard"
              : "Create an account, then an admin approves it"}
          </p>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Your name</label>
                <Input
                  placeholder="So the admin knows who is asking"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  className="h-12"
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input
                type="email"
                placeholder={
                  mode === "signup" && domains.length > 0
                    ? `you@${domains[0]}`
                    : "you@example.com"
                }
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className={`h-12 ${domainLooksWrong ? "border-destructive" : ""}`}
              />
              {mode === "signup" && domains.length > 0 && (
                <p
                  className={`text-xs ${domainLooksWrong ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {domainLooksWrong
                    ? `Accounts are only accepted for ${domains.join(", ")}.`
                    : `Accepted: ${domains.join(", ")}`}
                </p>
              )}
              {mode === "signup" && domains.length === 0 && (
                <p className="text-xs text-warning">
                  No email domains are accepted yet, so an account cannot be
                  approved. Ask an admin to add yours.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder={
                    mode === "signup"
                      ? "At least 8 characters"
                      : "Enter your password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  className="h-12 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transform text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={isSubmitting || (mode === "signup" && domainLooksWrong)}
              className="h-12 w-full bg-gradient-primary text-primary-foreground shadow-soft transition-opacity hover:opacity-90"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {mode === "signin" ? "Signing in…" : "Creating…"}
                </>
              ) : mode === "signin" ? (
                "Access Dashboard"
              ) : (
                "Request account"
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setPassword("");
              }}
            >
              {mode === "signin"
                ? "No account? Request one"
                : "Already have an account? Sign in"}
            </Button>

            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={onCancel}
              >
                Cancel
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default TALogin;
