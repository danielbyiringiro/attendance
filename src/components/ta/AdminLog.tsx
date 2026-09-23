// The log admins keep for each other (057).
//
// Not a feature for staff with a permission check bolted on: a TA cannot read
// this even if they find the URL, because the reading happens in a function
// that refuses them. This screen is only ever shown inside Admin, which is
// itself admin-only, so the check here is about what to render, not security.
//
// Entries the app wrote (a pause, a resume) sit in the same list as the ones
// people type, marked so they read as different things. The evening the app
// was paused for two hours is exactly the evening somebody will ask about.

import { useEffect, useState } from "react";
import { Loader2, NotebookPen, Send } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import ConfirmDelete from "@/components/ta/ConfirmDelete";
import {
  adminLogDelete,
  adminLogList,
  adminLogWrite,
  type AdminLogEntry,
} from "@/lib/api/service";

/** Within a day, only the clock matters — the date is on the rule above. */
const when = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

const dayKey = (iso: string) => new Date(iso).toDateString();

/**
 * "Today", "Yesterday", or the date written out.
 *
 * The two recent days are named rather than dated because that is how somebody
 * reading a log thinks about them — "what happened this morning" — and a date
 * makes them do the arithmetic to find out whether it was today.
 */
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};

const AdminLog = () => {
  const { toast } = useToast();
  const [entries, setEntries] = useState<AdminLogEntry[]>([]);
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setIsLoading(true);
    try {
      setEntries(await adminLogList(200));
    } catch (e) {
      toast({
        title: "Could not read the log",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const entry = await adminLogWrite(body.trim());
      setEntries((prev) => [entry, ...prev]);
      setBody("");
    } catch (e) {
      toast({
        title: "Could not save that",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await adminLogDelete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      toast({
        title: "Could not remove that entry",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="border-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <NotebookPen className="h-4 w-4" />
          Admin log
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            id="admin-log-body"
            value={body}
            rows={3}
            placeholder="What happened, and why. Only other admins can read this — not staff, not students."
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              For the installation as a whole. A note about one class belongs on
              that class's session.
            </p>
            <Button size="sm" disabled={busy || !body.trim()} onClick={() => void post()}>
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        </div>

        {isLoading ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Nothing written yet. Pausing and resuming the app add their own
            entries.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((e, i) => (
              <div key={e.id} className="space-y-2">
                {/* A rule between days. The list is newest first, so a new day
                    starts wherever this entry's date differs from the one
                    above it — and the first entry always opens one. */}
                {(i === 0 ||
                  dayKey(entries[i - 1].created_at) !== dayKey(e.created_at)) && (
                  <div className="flex items-center gap-3 pt-2 first:pt-0">
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {dayLabel(e.created_at)}
                    </span>
                    <hr className="min-w-0 flex-1 border-t" />
                  </div>
                )}

              <div
                className={`flex flex-col gap-1 rounded-lg border px-3 py-2 sm:flex-row sm:items-start sm:justify-between ${
                  e.kind === "event" ? "bg-muted/40" : ""
                }`}
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {e.body}
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {e.kind === "event" && (
                      <Badge variant="secondary" className="text-[0.65rem]">
                        by the app
                      </Badge>
                    )}
                    <span>{when(e.created_at)}</span>
                    {e.author && <span>· {e.author}</span>}
                  </p>
                </div>

                <ConfirmDelete
                  label="Remove"
                  confirmLabel="Yes, remove it"
                  warning="This entry is gone for every admin, and nothing keeps a copy."
                  size="sm"
                  resetKey={e.id}
                  onConfirm={() => void remove(e.id)}
                />
              </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default AdminLog;
