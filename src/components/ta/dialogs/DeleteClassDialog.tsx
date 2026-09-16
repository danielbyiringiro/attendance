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
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { deleteClass, previewClassDeletion } from "@/lib/api/classes";
import type { ClassDeletionPreview, ClassWithCohorts } from "@/lib/api/types";
import ConfirmDelete from "@/components/ta/ConfirmDelete";

interface DeleteClassDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ClassWithCohorts | null;
  onDone: () => void;
}

/**
 * Permanent deletion, behind a preview of what goes and the typed class code.
 *
 * This used to be "Archive or delete", with archiving as its main button and
 * deletion beneath it. People opened it meaning to delete, pressed the big
 * button, archived the class instead, and then could not find it. Archive is
 * now its own action beside this one on the class's Settings tab, so this
 * dialog does exactly one thing.
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
          <DialogTitle>Delete {target?.code} permanently</DialogTitle>
          <DialogDescription>
            This cannot be undone. To keep everything and only hide the class,
            close this and use Archive instead.
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
                Deleting permanently removes
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
                record of every correction. There is no undo.
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

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <ConfirmDelete
            label="Delete permanently"
            confirmLabel="Yes, delete the class"
            warning={
              preview
                ? `${target?.code} goes, and with it ${preview.sessions} session${preview.sessions === 1 ? "" : "s"}, ${preview.enrolments} enrolment${preview.enrolments === 1 ? "" : "s"} and ${preview.attendance_records} attendance record${preview.attendance_records === 1 ? "" : "s"}.`
                : "The class and every session, enrolment and attendance record in it will be destroyed."
            }
            icon={<Trash2 className="h-4 w-4 mr-2" />}
            isWorking={isWorking}
            disabled={!codeMatches}
            resetKey={`${open}-${target?.id ?? ""}`}
            onConfirm={handleDelete}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteClassDialog;
