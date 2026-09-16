import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Loader2, Megaphone, PlayCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getHelp, markAnnouncementsRead, type HelpContent } from "@/lib/api/help";

/**
 * How to use the app, and what has changed lately.
 *
 * The videos link out rather than embedding. An embed would mean admitting a
 * player and its scripts into a page that has stayed dependency-free, and this
 * screen is not worth that; a new tab costs nothing and cannot break.
 *
 * Announcements are listed under Updates, newest first, and stay listed after
 * they are read — people forget what changed, and "read" is a state on one of
 * them rather than a reason to hide it. Opening this screen marks them read,
 * which is what clears the dot in the sidebar.
 */
const Help = ({ onRead }: { onRead?: () => void }) => {
  const { toast } = useToast();
  const [content, setContent] = useState<HelpContent | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const help = await getHelp();
      setContent(help);

      /*
       * Marked read on arrival, not on a button.
       *
       * The dot means "there is something here you have not seen", and being
       * on this screen is seeing it. Asking somebody to press "mark as read"
       * after reading is asking them to do the bookkeeping. Reading twice is
       * not a second event, so this is safe to call every visit.
       */
      if (help.unread > 0) {
        await markAnnouncementsRead();
        setContent({
          ...help,
          unread: 0,
          announcements: help.announcements.map((a) => ({ ...a, read: true })),
        });
        onRead?.();
      }
    } catch (e) {
      toast({
        title: "Could not load Help",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast, onRead]);

  useEffect(() => {
    void load();
  }, [load]);

  const postedOn = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  if (isLoading && !content) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  const videos = content?.videos ?? [];
  const announcements = content?.announcements ?? [];

  return (
    <div className="space-y-4">
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-5 w-5" />
            How to use this
          </CardTitle>
        </CardHeader>
        <CardContent>
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No videos yet. An admin can add them from the Admin screen.
            </p>
          ) : (
            <div className="space-y-2">
              {videos.map((v) => (
                <a
                  key={v.id}
                  href={v.url}
                  target="_blank"
                  // noreferrer as well as noopener: the page being opened has no
                  // business knowing which screen sent somebody to it.
                  rel="noopener noreferrer"
                  className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{v.title}</span>
                    {v.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {v.description}
                      </span>
                    )}
                  </span>
                  <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                </a>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            These open in a new tab.
          </p>
        </CardContent>
      </Card>

      <Card className="border-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-5 w-5" />
            Updates
          </CardTitle>
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing announced yet.
            </p>
          ) : (
            <div className="space-y-2">
              {announcements.map((a) => (
                <div key={a.id} className="rounded-lg border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{a.title}</p>
                    <div className="flex items-center gap-2">
                      {!a.read && (
                        <Badge variant="secondary" className="text-xs">
                          New
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {postedOn(a.posted_at)}
                      </span>
                    </div>
                  </div>
                  {/* Whitespace kept: an announcement is typed as paragraphs. */}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                    {a.body}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Help;
