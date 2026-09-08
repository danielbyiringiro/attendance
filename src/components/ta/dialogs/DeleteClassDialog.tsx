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
import { AlertTriangle, Archive, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { archiveClass, deleteClass, previewClassDeletion } from "@/lib/api/classes";
import type { ClassDeletionPreview, ClassWithCohorts } from "@/lib/api/types";

interface DeleteClassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ClassWithCohorts | null;
  onDone: () => void;
}

/**
 * Archiving is the primary action and deletion is behind a typed confirmation.
 *
 * The user asked for delete, and delete exists — but archive is what someone
 * actually wants the second time they reach for this on live data, and a class
 * carries every attendance record ever taken for it.
 */
const DeleteClassDialog = ({
  open,
  onOpenChange,
  target,
  onDone,
}: DeleteClassDialogProps) => {
  const { toast } = useToast();
  const [preview, setPreview] = useState<ClassDeletionPreview | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    setConfirmText("");
    setPreview(null);
    setIsLoading(true);
    previewClassDeletion(target.id)
      .then(setPreview)
      .catch((e) =>
        toast({
          title: "Could not check what this would delete",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        }),
      )
      .finally(() => setIsLoading(false));
  }, [open, target, toast]);

  const handleArchive = async () => {
    if (!target) return;
    setIsWorking(true);
    try {
      await archiveClass(target.id, true);
      toast({
        title: "Class archived",
        description: "Nothing was deleted. You can bring it back at any time.",
      });
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not archive",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  const handleDelete = async () => {
    if (!target) return;
    setIsWorking(true);
    try {
      const result = await deleteClass(target.id, confirmText.trim());
      toast({
        title: "Class deleted",
        description:
          result.students_deleted > 0
            ? `${target.code} and everything recorded against it is gone, along with ${result.students_deleted} student${result.students_deleted === 1 ? "" : "s"} who took no other class.`
            : `${target.code} and everything recorded against it is gone.`,
      });
      onDone();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not delete",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsWorking(false);
    }
  };

  const codeMatches =
    target != null &&
    confirmText.trim().toLowerCase() === target.code.trim().toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Archive or delete {target?.code}</DialogTitle>
          <DialogDescription>
            Archiving hides the class and keeps everything. Deleting does not.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking what this holds…
            </div>
          ) : preview ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                Deleting would permanently remove
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">Cohorts</span>
                <span>{preview.cohorts}</span>
                <span className="text-muted-foreground">Enrolments</span>
                <span>{preview.enrolments}</span>
                <span className="text-muted-foreground">Sessions</span>
                <span>{preview.sessions}</span>
                <span className="text-muted-foreground">Attendance records</span>
                <span className="font-medium">{preview.attendance_records}</span>
                {preview.students_also_deleted > 0 && (
                  <>
                    <span className="text-muted-foreground">Students</span>
                    <span className="font-medium">
                      {preview.students_also_deleted}
                    </span>
                  </>
                )}
              </div>

              {preview.students_also_deleted > 0 && (
                <p className="border-t pt-2 text-xs text-muted-foreground">
                  {preview.students_also_deleted} student
                  {preview.students_also_deleted === 1 ? " takes" : "s take"} no
                  other class, so {preview.students_also_deleted === 1 ? "it" : "they"}{" "}
                  will be deleted too — keeping{" "}
                  {preview.students_also_deleted === 1 ? "it" : "them"} would leave
                  a record no screen here can reach. Anyone enrolled in another
                  class is kept, along with their attendance in it.
                </p>
              )}

              <p className="border-t pt-2 text-xs text-muted-foreground">
                Attendance history for this class goes with it, including the
                record of every correction. There is no undo. To put a class out
                of the way without destroying anything, archive it instead.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="confirm-code">
              To delete, type the class code <code>{target?.code}</code>
            </Label>
            <Input
              id="confirm-code"
              value={confirmText}
              autoComplete="off"
              placeholder={target?.code}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button onClick={handleArchive} disabled={isWorking}>
              <Archive className="h-4 w-4 mr-2" />
              Archive instead
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isWorking || !codeMatches}
            >
              {isWorking ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete permanently
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteClassDialog;
