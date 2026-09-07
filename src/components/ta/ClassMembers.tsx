import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  addClassMember,
  listClassMembers,
  removeClassMember,
  type ClassMember,
} from "@/lib/api/staff";

interface ClassMembersProps {
  classId: string;
  className?: string;
}

/**
 * Who can reach this class.
 *
 * Adding is by exact email rather than by picking from a list: a member can add
 * someone they can name, but nobody can enumerate every account in the
 * institution.
 */
const ClassMembers = ({ classId, className }: ClassMembersProps) => {
  const { toast } = useToast();
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isWorking, setIsWorking] = useState(false);

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

  const handleAdd = async () => {
    if (email.trim() === "") return;
    setIsWorking(true);
    try {
      await addClassMember(classId, email.trim());
      toast({
        title: "Added",
        description: `${email.trim()} can now see and manage this class.`,
      });
      setEmail("");
      await load();
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

  const handleRemove = async (member: ClassMember) => {
    setIsWorking(true);
    try {
      await removeClassMember(classId, member.staff_id);
      toast({
        title: "Removed",
        description: `${member.email ?? "They"} can no longer see this class.`,
      });
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
              {m.is_you && (
                <Badge variant="outline" className="ml-2 text-xs">
                  you
                </Badge>
              )}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={isWorking || members.length === 1}
              title={
                members.length === 1
                  ? "The last person cannot be removed — the class would be unreachable"
                  : "Remove"
              }
              onClick={() => handleRemove(m)}
            >
              <UserMinus className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {!isLoading && members.length === 0 && (
          <p className="text-xs text-muted-foreground">Nobody yet.</p>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          value={email}
          placeholder="colleague@example.edu"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
        />
        <Button
          variant="outline"
          disabled={isWorking || email.trim() === ""}
          onClick={handleAdd}
        >
          <UserPlus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        They need to have signed in at least once. Everyone here has the same
        rights as you.
      </p>
    </div>
  );
};

export default ClassMembers;
