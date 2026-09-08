import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LogOut, Loader2, Mail, Search, UserMinus, UserPlus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  addClassMember,
  addClassMemberById,
  listClassMembers,
  removeClassMember,
  searchAddableStaff,
  type AddableStaff,
  type ClassMember,
} from "@/lib/api/staff";

interface ClassMembersProps {
  classId: string;
  className?: string;
}

const looksLikeEmail = (v: string) => /\S+@\S+\.\S+/.test(v.trim());

/**
 * Who can reach this class.
 *
 * Typing searches people you already share a class with — the set you actually
 * want to pick from. It deliberately does not search every account: that would
 * be a directory of the whole institution. Anyone outside that circle is added
 * by typing their full email, which reveals nothing you did not already know,
 * so the box does both.
 */
const ClassMembers = ({ classId, className }: ClassMembersProps) => {
  const { toast } = useToast();
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddableStaff[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [leaving, setLeaving] = useState<ClassMember | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setMembers(await listClassMembers(classId));
    } catch (e) {
      toast({
        title: "Could not load collaborators",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [classId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced, so typing an email does not fire a request per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      setResults([]);
      return;
    }
    setIsSearching(true);
    const timer = setTimeout(() => {
      searchAddableStaff(classId, q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setIsSearching(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      setIsSearching(false);
    };
  }, [query, classId]);

  const afterChange = async () => {
    setQuery("");
    setResults([]);
    await load();
  };

  const handleAddById = async (person: AddableStaff) => {
    setIsWorking(true);
    try {
      await addClassMemberById(classId, person.staff_id);
      toast({
        title: "Added",
        description: `${
          person.display_name || person.email
        } can now see and manage this class.`,
      });
      await afterChange();
    } catch (e) {
      toast({
        title: "Could not add them",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  const handleAddByEmail = async () => {
    setIsWorking(true);
    try {
      await addClassMember(classId, query.trim());
      toast({
        title: "Added",
        description: `${query.trim()} can now see and manage this class.`,
      });
      await afterChange();
    } catch (e) {
      toast({
        title: "Could not add them",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  // Leaving is a different act from removing somebody else, so it is a
  // different control with its own confirmation. The server refuses an
  // unconfirmed self-removal regardless — this is not the only guard.
  const handleRemove = async (member: ClassMember, confirmSelf = false) => {
    setIsWorking(true);
    try {
      const result = await removeClassMember(classId, member.staff_id, {
        confirmSelf,
      });
      toast({
        title: result.was_self ? "You left this class" : "Removed",
        description: result.was_self
          ? "It is gone from your class list. Another member can add you back."
          : `${member.email ?? "They"} can no longer see this class.`,
      });
      setLeaving(null);
      await load();
    } catch (e) {
      toast({
        title: "Could not remove them",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Who can manage this class</h3>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />}
      </div>

      <div className="space-y-1 mb-3">
        {members.map((m) => (
          <div
            key={m.staff_id}
            className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5"
          >
            <span className="truncate text-sm">
              {m.display_name || m.email || "(unnamed account)"}
              {m.display_name && m.email && (
                <span className="text-muted-foreground"> · {m.email}</span>
              )}
              {m.is_you && (
                <Badge variant="outline" className="ml-2 text-xs">
                  you
                </Badge>
              )}
            </span>
            {m.is_you ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={isWorking || members.length === 1}
                title={
                  members.length === 1
                    ? "You are the only person on this class — leaving would make it unreachable"
                    : "Leave this class"
                }
                onClick={() => setLeaving(m)}
              >
                <LogOut className="mr-1 h-3.5 w-3.5" />
                Leave
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={isWorking}
                title="Remove"
                onClick={() => handleRemove(m)}
              >
                <UserMinus className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
        {!isLoading && members.length === 0 && (
          <p className="text-xs text-muted-foreground">Nobody yet.</p>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          value={query}
          placeholder="Search a colleague, or type a full email"
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && (
          <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin opacity-60" />
        )}
      </div>

      {results.length > 0 && (
        <div className="mt-1 space-y-1 rounded-md border p-1">
          {results.map((p) => (
            <button
              key={p.staff_id}
              type="button"
              disabled={isWorking}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => handleAddById(p)}
            >
              <span className="truncate">
                {p.display_name || p.email}
                {p.display_name && p.email && (
                  <span className="text-muted-foreground"> · {p.email}</span>
                )}
              </span>
              <UserPlus className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
          ))}
        </div>
      )}

      {/* Nobody in your circle matched, but a full address still reaches them. */}
      {query.trim() !== "" && !isSearching && results.length === 0 && (
        <div className="mt-1">
          {looksLikeEmail(query) ? (
            <Button
              variant="outline"
              className="w-full justify-start"
              disabled={isWorking}
              onClick={handleAddByEmail}
            >
              <Mail className="h-4 w-4 mr-2" />
              Add {query.trim()} by email
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground px-1">
              No colleague matches. Type someone's full email address to add them.
            </p>
          )}
        </div>
      )}

      <AlertDialog
        open={leaving !== null}
        onOpenChange={(o) => !o && setLeaving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this class?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to it — its sessions, its roster and its
              attendance. There is no admin who can undo this: only somebody
              still on the class can add you back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => leaving && handleRemove(leaving, true)}
            >
              Leave the class
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p className="mt-2 text-xs text-muted-foreground">
        Search covers people you already share a class with. Anyone else can be
        added by their full email, and they must have signed in at least once.
        Everyone here has the same rights as you.
      </p>
    </div>
  );
};

export default ClassMembers;
