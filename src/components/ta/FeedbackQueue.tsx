import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Loader2, MessageSquare, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ConfirmDelete from "@/components/ta/ConfirmDelete";
import {
  adminDeleteFeedback,
  adminListFeedback,
  adminSetFeedbackHandled,
  type FeedbackItem,
} from "@/lib/api/feedback";

/**
 * What staff have reported, and what has been done about it.
 *
 * Handled rather than deleted is the normal end: a list that has been worked
 * through should still be there next term, or the same report arrives again and
 * nobody recognises it. Delete is for rubbish.
 *
 * Open ones first — that is the reason to look at this screen at all.
 */
const FeedbackQueue = () => {
  const { toast } = useToast();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setItems(await adminListFeedback());
    } catch (e) {
      toast({
        title: "Could not load the feedback",
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

  const setHandled = async (f: FeedbackItem, handled: boolean) => {
    setBusy(f.id);
    try {
      await adminSetFeedbackHandled(f.id, handled);
      await load();
    } catch (e) {
      toast({
        title: "Could not change that",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (f: FeedbackItem) => {
    setBusy(f.id);
    try {
      await adminDeleteFeedback(f.id);
      toast({ title: "Removed" });
      await load();
    } catch (e) {
      toast({
        title: "Could not remove that",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const open = items.filter((f) => !f.handled);
  const done = items.filter((f) => f.handled);
  const shown = showHandled ? done : open;

  const sentOn = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  const who = (f: FeedbackItem) =>
    f.from_name || f.from_email || "an account since removed";

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <MessageSquare className="h-5 w-5" />
          Feedback
          {open.length > 0 && <Badge className="ml-1">{open.length}</Badge>}
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant={showHandled ? "ghost" : "secondary"}
              onClick={() => setShowHandled(false)}
            >
              Open ({open.length})
            </Button>
            <Button
              size="sm"
              variant={showHandled ? "secondary" : "ghost"}
              onClick={() => setShowHandled(true)}
            >
              Handled ({done.length})
            </Button>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {showHandled
              ? "Nothing has been marked handled yet."
              : "Nothing open. Staff can send this from Help."}
          </p>
        ) : (
          shown.map((f) => (
            <div key={f.id} className="space-y-2 rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {who(f)}
                  {f.from_email && f.from_name && (
                    <span className="text-muted-foreground">
                      {" · "}
                      {f.from_email}
                    </span>
                  )}
                </p>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {f.page && (
                    <Badge variant="outline" className="mr-2 text-xs">
                      {f.page}
                    </Badge>
                  )}
                  {sentOn(f.created_at)}
                </span>
              </div>

              {/* Whitespace kept: somebody typed this as paragraphs. */}
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {f.body}
              </p>

              <div className="flex flex-wrap justify-end gap-1">
                {f.handled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === f.id}
                    onClick={() => void setHandled(f, false)}
                  >
                    <RotateCcw className="mr-1 h-4 w-4" />
                    Reopen
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === f.id}
                    onClick={() => void setHandled(f, true)}
                  >
                    <Check className="mr-1 h-4 w-4" />
                    Mark handled
                  </Button>
                )}
                <ConfirmDelete
                  label="Remove"
                  confirmLabel="Yes, remove it"
                  warning="The report is gone for good. Marking it handled keeps it."
                  size="sm"
                  isWorking={busy === f.id}
                  resetKey={f.id}
                  onConfirm={() => void remove(f)}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
};

export default FeedbackQueue;
