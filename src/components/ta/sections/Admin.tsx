import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  adminDecideStaff,
  adminDeleteClass,
  adminListClasses,
  adminListClassMembers,
  adminListStaff,
  adminSetAdmin,
  adminSetClassMember,
  adminSetDomain,
  listAllowedDomains,
  type AdminClassRow,
  type ClassMember,
  type StaffAccount,
} from "@/lib/api/staff";

/**
 * Approving accounts, and repairing a class nobody can reach.
 *
 * Everything here goes through the `admin_` RPCs. That is not incidental: RLS
 * on `staff` is shares_a_class_with(), so an admin querying the table directly
 * cannot see somebody who has never been approved — the very people this screen
 * is for. The RPCs are SECURITY DEFINER for exactly that reason.
 *
 * What is deliberately absent: any roster, session or attendance. Migration 008
 * settled that you see a class if you are on it, and 020 did not reopen it.
 * Admin can see that a class exists and who manages it, and can change that.
 */
const Admin = () => {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [classes, setClasses] = useState<AdminClassRow[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [addEmail, setAddEmail] = useState("");
  const [deleting, setDeleting] = useState<AdminClassRow | null>(null);
  /*
   * Both lists grow without bound — every account this installation has ever
   * approved, and every class anybody has ever made. They are the two screens
   * that get longer for ever, and the reason to open Admin at all is usually
   * one row in one of them.
   *
   * Filtered here rather than on the server: admin_list_staff and
   * admin_list_classes each return everything already, so a query per keystroke
   * would be a round trip to re-fetch what is on screen.
   */
  const [accountQuery, setAccountQuery] = useState("");
  const [classQuery, setClassQuery] = useState("");
  const [confirmCode, setConfirmCode] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [staff, cls, doms] = await Promise.all([
        adminListStaff(),
        adminListClasses(),
        listAllowedDomains(),
      ]);
      setAccounts(staff);
      setClasses(cls);
      setDomains(doms.map((d) => d.domain));
    } catch (e) {
      toast({
        title: "Could not load the admin data",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
      await load();
    } catch (e) {
      toast({
        title: "That did not work",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const openMembers = async (c: AdminClassRow) => {
    if (expanded === c.class_id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.class_id);
    setAddEmail("");
    try {
      setMembers(await adminListClassMembers(c.class_id));
    } catch {
      setMembers([]);
    }
  };

  const pending = accounts.filter((a) => a.status === "pending");

  // Waiting accounts are never filtered: they are a queue to work through, and
  // hiding one behind a search term is how somebody waits a fortnight.
  const matchesAccount = (a: StaffAccount) => {
    const q = accountQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      (a.email ?? "").toLowerCase().includes(q) ||
      (a.display_name ?? "").toLowerCase().includes(q)
    );
  };

  const decidedAll = accounts.filter((a) => a.status !== "pending");
  const decided = decidedAll.filter(matchesAccount);

  const matchesClass = (c: AdminClassRow) => {
    const q = classQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      c.code.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q)
    );
  };

  const shownClasses = classes.filter(matchesClass);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Waiting for a decision */}
      <Card className="border-2 border-primary/25 bg-gradient-card shadow-soft">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-5 w-5 text-primary" />
            Waiting for approval
            {pending.length > 0 && (
              <Badge className="ml-1">{pending.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody is waiting. New accounts appear here as soon as somebody
              signs up with an accepted email domain.
            </p>
          ) : (
            pending.map((a) => (
              <div
                key={a.staff_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {a.display_name || a.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.display_name ? `${a.email} · ` : ""}
                    asked {new Date(a.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    disabled={busy === a.staff_id}
                    onClick={() =>
                      run(a.staff_id, async () => {
                        await adminDecideStaff(a.staff_id, true);
                        toast({
                          title: "Approved",
                          description: `${a.email} can now create and manage classes.`,
                        });
                      })
                    }
                  >
                    <Check className="mr-1 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busy === a.staff_id}
                    onClick={() =>
                      run(a.staff_id, async () => {
                        await adminDecideStaff(a.staff_id, false);
                        toast({
                          title: "Declined",
                          description: `${a.email} has been told. You can approve them later.`,
                        });
                      })
                    }
                  >
                    <X className="mr-1 h-4 w-4" />
                    Decline
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Everyone else */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">
            Accounts (
            {accountQuery.trim()
              ? `${decided.length} of ${decidedAll.length}`
              : decidedAll.length}
            )
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="relative pb-2">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={accountQuery}
              placeholder="Filter by name or email"
              onChange={(e) => setAccountQuery(e.target.value)}
            />
          </div>

          {decidedAll.length > 0 && decided.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No account matches that.
            </p>
          )}

          {decided.map((a) => (
            <div
              key={a.staff_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {a.display_name || a.email}
                  {a.is_admin && (
                    <Badge variant="outline" className="text-xs">
                      admin
                    </Badge>
                  )}
                  {a.status === "rejected" && (
                    <Badge variant="destructive" className="text-xs">
                      declined
                    </Badge>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {a.display_name ? `${a.email} · ` : ""}
                  {a.classes} class{a.classes === 1 ? "" : "es"}
                </p>
              </div>

              <div className="flex gap-1">
                {a.status === "rejected" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === a.staff_id}
                    onClick={() =>
                      run(a.staff_id, async () => {
                        await adminDecideStaff(a.staff_id, true);
                        toast({ title: "Approved" });
                      })
                    }
                  >
                    Approve after all
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === a.staff_id}
                    title={
                      a.is_admin
                        ? "Take away admin"
                        : "Let them approve accounts and repair classes"
                    }
                    onClick={() =>
                      run(a.staff_id, async () => {
                        await adminSetAdmin(a.staff_id, !a.is_admin);
                        toast({
                          title: a.is_admin
                            ? "No longer an admin"
                            : "Now an admin",
                        });
                      })
                    }
                  >
                    <ShieldCheck className="mr-1 h-4 w-4" />
                    {a.is_admin ? "Remove admin" : "Make admin"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Who may sign up */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">Email domains</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {domains.length === 0 ? (
              <p className="text-sm text-warning">
                No domains are accepted, so nobody new can sign up.
              </p>
            ) : (
              domains.map((d) => (
                <Badge key={d} variant="outline" className="gap-1 py-1">
                  {d}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title={`Stop accepting ${d}`}
                    onClick={() =>
                      run(d, async () => {
                        await adminSetDomain(d, false);
                        toast({
                          title: `${d} removed`,
                          description:
                            "Nobody new can sign up with it. Accounts already approved keep working.",
                        });
                      })
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Input
              className="w-56"
              value={newDomain}
              placeholder="ashesi.edu.gh"
              onChange={(e) => setNewDomain(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!newDomain.trim() || busy === "add-domain"}
              onClick={() =>
                run("add-domain", async () => {
                  await adminSetDomain(newDomain.trim(), true);
                  setNewDomain("");
                  toast({ title: "Domain added" });
                })
              }
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Removing a domain only stops new signups. It does not revoke anybody
            already approved.
          </p>
        </CardContent>
      </Card>

      {/* Class repair */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="text-base">
            Classes (
            {classQuery.trim()
              ? `${shownClasses.length} of ${classes.length}`
              : classes.length}
            )
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            For putting somebody back on a class they lost access to. You can see
            which classes exist and who manages them — not their rosters,
            sessions or attendance.
          </p>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={classQuery}
              placeholder="Filter by code or name"
              onChange={(e) => setClassQuery(e.target.value)}
            />
          </div>

          {classes.length > 0 && shownClasses.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No class matches that.
            </p>
          )}

          {shownClasses.map((c) => (
            <div key={c.class_id} className="rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {c.code}
                    <span className="text-muted-foreground">{c.name}</span>
                    {c.archived && (
                      <Badge variant="secondary" className="text-xs">
                        archived
                      </Badge>
                    )}
                    {c.members === 0 && (
                      <Badge variant="destructive" className="gap-1 text-xs">
                        <AlertTriangle className="h-3 w-3" />
                        nobody can reach it
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.members} manager{c.members === 1 ? "" : "s"} ·{" "}
                    {c.enrolments} enrolment{c.enrolments === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openMembers(c)}
                  >
                    {expanded === c.class_id ? "Hide" : "Managers"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => {
                      setDeleting(c);
                      setConfirmCode("");
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {expanded === c.class_id && (
                <div className="space-y-2 border-t px-3 py-2">
                  {members.map((m) => (
                    <div
                      key={m.staff_id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="truncate">
                        {m.display_name || m.email}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === m.staff_id}
                        onClick={() =>
                          run(m.staff_id, async () => {
                            await adminSetClassMember(
                              c.class_id,
                              m.email ?? "",
                              false,
                            );
                            setMembers(
                              await adminListClassMembers(c.class_id),
                            );
                            toast({ title: "Removed" });
                          })
                        }
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}

                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="w-64"
                      value={addEmail}
                      placeholder="Their email, to give them the class"
                      onChange={(e) => setAddEmail(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={!addEmail.trim() || busy === "add-member"}
                      onClick={() =>
                        run("add-member", async () => {
                          await adminSetClassMember(
                            c.class_id,
                            addEmail.trim(),
                            true,
                          );
                          setAddEmail("");
                          setMembers(await adminListClassMembers(c.class_id));
                          toast({ title: "Added" });
                        })
                      }
                    >
                      <UserPlus className="mr-1 h-4 w-4" />
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Deleting somebody else's class asks for the same confirmation theirs does */}
      {deleting && (
        <Card className="border-2 border-destructive/40 bg-destructive/5">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm font-medium">
              Delete {deleting.code} — {deleting.name}?
            </p>
            <p className="text-xs text-muted-foreground">
              Its cohorts, sessions, enrolments and every attendance record go
              with it, and students whose only class this was are deleted too.
              There is no undo.
            </p>
            <Input
              value={confirmCode}
              placeholder={`Type ${deleting.code} to confirm`}
              onChange={(e) => setConfirmCode(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setDeleting(null)}>
                Keep it
              </Button>
              <Button
                variant="destructive"
                disabled={busy === "delete"}
                onClick={() =>
                  run("delete", async () => {
                    await adminDeleteClass(deleting.class_id, confirmCode.trim());
                    toast({ title: `${deleting.code} deleted` });
                    setDeleting(null);
                  })
                }
              >
                Delete the class
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default Admin;
