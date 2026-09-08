import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Search, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  rosterForSession,
  setAttendanceState,
  stateLabel,
  type SessionAttendee,
} from "@/lib/api/attendance";
import type { SessionRow } from "@/lib/api/types";

interface SessionRosterDialogProps {
  session: SessionRow | null;
  cohortLabel: string;
  onOpenChange: (open: boolean) => void;
  /** Re-read the card behind, so its count follows. */
  onChanged: () => void;
}

/**
 * Who is in the room, and who is not.
 *
 * The Today card showed "18/21 here" and stopped there, which answers the
 * wrong half of the question: mid-session a TA wants the three names, not the
 * eighteen. This is driven from enrolments rather than from records, so a
 * student with no mark yet appears — a query over attendance_records alone
 * cannot show somebody who is missing.
 */
const SessionRosterDialog = ({
  session,
  cohortLabel,
  onOpenChange,
  onChanged,
}: SessionRosterDialogProps) => {
  const { toast } = useToast();
  const [attendees, setAttendees] = useState<SessionAttendee[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!session) return;
    setIsLoading(true);
    try {
      setAttendees(await rosterForSession(session.id));
    } catch (e) {
      toast({
        title: "Could not load the roster",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setAttendees([]);
    } finally {
      setIsLoading(false);
    }
  }, [session, toast]);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  const { here, missing } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = attendees.filter(
      (a) =>
        needle === "" ||
        a.student_id.toLowerCase().includes(needle) ||
        (a.name ?? "").toLowerCase().includes(needle),
    );
    return {
      here: matches.filter((a) => a.state === "present" || a.state === "late"),
      // Anything else, including no record at all.
      missing: matches.filter(
        (a) => a.state !== "present" && a.state !== "late",
      ),
    };
  }, [attendees, query]);

  const markPresent = async (studentId: string) => {
    if (!session) return;
    setBusyId(studentId);
    try {
      await setAttendanceState(session.id, studentId, "present");
      await load();
      onChanged();
    } catch (e) {
      toast({
        title: "Could not mark them present",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={session !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cohort {cohortLabel}</DialogTitle>
          <DialogDescription>
            Everyone enrolled on this day. Marking somebody here records it
            against the session, the same as a check-in.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            placeholder="Find a student"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Not here first: that is the list being read during a session. */}
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Not here yet ({missing.length})
              </p>
              {missing.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  Everyone enrolled is accounted for.
                </p>
              ) : (
                missing.map((a) => (
                  <div
                    key={a.student_id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {a.name || a.student_id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {a.name ? `${a.student_id} · ` : ""}
                        {stateLabel(a.state)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === a.student_id}
                      onClick={() => markPresent(a.student_id)}
                    >
                      {busyId === a.student_id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <UserCheck className="mr-1 h-4 w-4" />
                          Present
                        </>
                      )}
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Here ({here.length})</p>
              {here.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  Nobody has marked yet.
                </p>
              ) : (
                here.map((a) => (
                  <div
                    key={a.student_id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2"
                  >
                    <span className="truncate text-sm">
                      {a.name || a.student_id}
                    </span>
                    <Badge
                      variant={a.state === "late" ? "secondary" : "outline"}
                    >
                      {stateLabel(a.state)}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SessionRosterDialog;
