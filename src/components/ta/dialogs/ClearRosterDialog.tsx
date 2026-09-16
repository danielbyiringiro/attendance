import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Loader2, Trash2, UserMinus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { clearRoster, previewRosterClearing } from "@/lib/api/enrolment";
import type { CohortRow, RosterClearingPreview } from "@/lib/api/types";
import ConfirmDelete from "@/components/ta/ConfirmDelete";

interface ClearRosterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classId: string;
  /** Typed back to confirm, exactly as delete_class asks for it. */
  classCode: string;
  cohorts: CohortRow[];
  /** Re-read the roster: everything on the screen behind this has changed. */
  onDone: () => void;
}

const ALL = "__all__";

/**
 * Empty a roster — the whole class, or one cohort — keeping or erasing what was
 * recorded against the people on it.
 *
 * The scope is chosen HERE and stated in full, rather than inherited from the
 * cohort and search filters on the screen behind. A destructive action that
 * quietly follows a filter is how somebody narrows to Cohort B, forgets, and
 * clears the class.
 *
 * Keeping is the bulk version of the existing Remove button: every enrolment is
 * dropped, and the term that was taught can still be exported. Erasing is for
 * the roster uploaded into the wrong class, where "dropped" would leave forty
 * people and a term of absences sitting in a class they were never in.
 */
const ClearRosterDialog = ({
  open,
  onOpenChange,
  classId,
  classCode,
  cohorts,
  onDone,
}: ClearRosterDialogProps) => {
  const { toast } = useToast();
  const [scope, setScope] = useState<string>(ALL);
  const [mode, setMode] = useState<"keep" | "erase">("erase");
  const [confirmText, setConfirmText] = useState("");
  const [preview, setPreview] = useState<RosterClearingPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  // Opens fresh every time: whole class, erasing, confirmation empty. Erasing
  // is the default because it is what people open this for — a roster in the
  // wrong class — and it is the option the two presses and the typed code are
  // there to slow down. Never carried over from last time.
  useEffect(() => {
    if (!open) return;
    setScope(ALL);
    setMode("erase");
    setConfirmText("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setIsLoading(true);
    setPreview(null);
    previewRosterClearing(classId, scope === ALL ? null : scope)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch((e) => {
        if (!live) return;
        toast({
          title: "Could not check what this would remove",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        });
      })
      .finally(() => {
        if (live) setIsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, classId, scope, toast]);

  const erasing = mode === "erase";
  const codeMatches =
    confirmText.trim().toLowerCase() === classCode.trim().toLowerCase();
  const scopeName =
    scope === ALL
      ? `all of ${classCode}`
      : `cohort ${cohorts.find((c) => c.id === scope)?.label ?? "?"}`;

  const handleClear = async () => {
    setIsWorking(true);
    try {
      const result = await clearRoster(classId, confirmText.trim(), {
        cohortId: scope === ALL ? null : scope,
        erase: erasing,
      });

      toast({
        title: result.erased ? "Roster erased" : "Roster cleared",
        description: result.erased
          ? `${result.removed} enrolment${result.removed === 1 ? "" : "s"} and ${result.records_deleted ?? 0} attendance record${result.records_deleted === 1 ? "" : "s"} deleted${
              result.students_deleted
                ? `, along with ${result.students_deleted} student${result.students_deleted === 1 ? "" : "s"} left in no class at all`
                : ""
            }.`
          : `${result.removed} student${result.removed === 1 ? "" : "s"} taken off the roster. Their attendance is kept and still exports.`,
      });
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not clear the roster",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Clear the roster</DialogTitle>
          <DialogDescription>
            This cannot be undone. The class, its sessions and its settings are
            kept either way — this is about who is on the roster.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Who</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  Everyone in {classCode}
                </SelectItem>
                {cohorts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    Cohort {c.label} only
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Chosen here, not taken from the filters on the screen behind.
            </p>
          </div>

          <div className="space-y-2">
            <Label>What happens to their attendance</Label>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setMode("keep")}
                aria-pressed={mode === "keep"}
                className={
                  mode === "keep"
                    ? "rounded-md border border-primary bg-primary/5 px-3 py-2 text-left"
                    : "rounded-md border px-3 py-2 text-left hover:bg-muted/50"
                }
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <UserMinus className="h-4 w-4" />
                  Take them off, keep their records
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Nothing is deleted. The term they were taught still exports,
                  and they stop being marked absent from now on.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setMode("erase")}
                aria-pressed={mode === "erase"}
                className={
                  erasing
                    ? "rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-left"
                    : "rounded-md border px-3 py-2 text-left hover:bg-muted/50"
                }
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Trash2 className="h-4 w-4" />
                  Remove them and erase their attendance here
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  For a roster uploaded into the wrong class. Their attendance in
                  other classes is untouched.
                </span>
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking what this holds…
            </div>
          ) : preview ? (
            <div
              className={
                erasing
                  ? "space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
                  : "space-y-2 rounded-lg border p-3"
              }
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                {erasing && <AlertTriangle className="h-4 w-4 text-destructive" />}
                {erasing
                  ? `Erasing ${scopeName} permanently removes`
                  : `Taking ${scopeName} off the roster`}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Students</span>
                <span className="font-medium">{preview.students}</span>
                <span className="text-muted-foreground">
                  {erasing ? "Enrolments" : "Still on the roster"}
                </span>
                <span>
                  {erasing ? preview.students : preview.still_on_roster}
                </span>
                {erasing && (
                  <>
                    <span className="text-muted-foreground">
                      Attendance records
                    </span>
                    <span className="font-medium">
                      {preview.attendance_records}
                    </span>
                    {preview.flags > 0 && (
                      <>
                        <span className="text-muted-foreground">Flags</span>
                        <span>{preview.flags}</span>
                      </>
                    )}
                    {preview.students_also_deleted > 0 && (
                      <>
                        <span className="text-muted-foreground">
                          Students deleted entirely
                        </span>
                        <span className="font-medium">
                          {preview.students_also_deleted}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>

              {erasing ? (
                <>
                  {preview.students_also_deleted > 0 && (
                    <p className="border-t pt-2 text-xs text-muted-foreground">
                      {preview.students_also_deleted} of them take no other
                      class, so they are deleted from the system too — keeping
                      them would leave a record no screen here can reach. Anyone
                      enrolled elsewhere is kept, along with their attendance in
                      that class.
                    </p>
                  )}
                  <p className="border-t pt-2 text-xs font-medium text-destructive">
                    {preview.attendance_records} attendance record
                    {preview.attendance_records === 1 ? "" : "s"} and every
                    correction behind{" "}
                    {preview.attendance_records === 1 ? "it" : "them"} will be
                    destroyed. There is no undo, and no export afterwards.
                  </p>
                </>
              ) : (
                <p className="border-t pt-2 text-xs text-muted-foreground">
                  Nothing is deleted. Their attendance stays exportable, and they
                  can be added back by uploading a roster again.
                </p>
              )}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="clear-confirm">
              To continue, type the class code <code>{classCode}</code>
            </Label>
            <Input
              id="clear-confirm"
              value={confirmText}
              autoComplete="off"
              placeholder={classCode}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {erasing ? (
            <ConfirmDelete
              label="Erase permanently"
              confirmLabel="Yes, erase it all"
              warning={
                preview
                  ? `${preview.attendance_records} record${preview.attendance_records === 1 ? "" : "s"} destroyed, no undo`
                  : "This cannot be undone"
              }
              icon={<Trash2 className="mr-2 h-4 w-4" />}
              isWorking={isWorking}
              disabled={!codeMatches || isLoading}
              resetKey={`${open}-${scope}-${mode}`}
              onConfirm={handleClear}
            />
          ) : (
            <Button
              onClick={handleClear}
              disabled={isWorking || !codeMatches || isLoading}
            >
              {isWorking ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserMinus className="mr-2 h-4 w-4" />
              )}
              Take them off
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ClearRosterDialog;
