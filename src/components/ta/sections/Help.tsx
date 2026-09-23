import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bug, ExternalLink, Lightbulb, Loader2, Megaphone, MessageSquare, PlayCircle, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getHelp, markAnnouncementsRead, type HelpContent } from "@/lib/api/help";
import { sendFeedback, type FeedbackKind } from "@/lib/api/feedback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
/*
 * What the box asks for, per kind (059).
 *
 * The placeholder is the whole point of splitting these: "what happened
 * instead?" is the wrong question to be asked when what you have is an idea,
 * and being asked it is how somebody decides their idea does not belong here.
 */
const KINDS: Record<
  FeedbackKind,
  { label: string; placeholder: string; icon: typeof Bug }
> = {
  bug: {
    label: "Something is wrong",
    placeholder: "What were you trying to do, and what happened instead?",
    icon: Bug,
  },
  idea: {
    label: "An idea",
    placeholder: "What would you like it to do, and when would that help?",
    icon: Lightbulb,
  },
};

const Help = ({
  onRead,
  yourName,
}: {
  onRead?: () => void;
  /** Shown on the form so it is obvious what is being attached (059). */
  yourName?: string | null;
}) => {
  const { toast } = useToast();
  const [content, setContent] = useState<HelpContent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // 051. Kept here rather than in a dialog: somebody who has just been confused
  // by a screen should not have to find a second one to say so.
  const [report, setReport] = useState("");
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [anon, setAnon] = useState(false);
  const [isSending, setIsSending] = useState(false);

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

  const send = async () => {
    setIsSending(true);
    try {
      await sendFeedback(report.trim(), { page: "help", kind, anonymous: anon });
      setReport("");
      setAnon(false);
      toast({
        title: "Sent",
        description: anon
          ? "Thank you — it went without your name, so nobody can reply."
          : "Thank you — an admin sees this with your name on it.",
      });
    } catch (e) {
      toast({
        title: "Could not send that",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

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

      {/*
        051. The other direction from Updates: those come from an admin, this
        goes back to one. Stored in the app rather than pointed at a form
        elsewhere — a link rots when whoever set it up moves on, and nothing
        here would know that feedback had simply stopped arriving.
      */}
      <Card className="border-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-5 w-5" />
            Tell us what you think
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Asked before the box, not after: it changes what the box asks
              for, and a question that arrives after the answer is written is
              one somebody has to go back and re-read. */}
          <div className="flex flex-wrap gap-2">
            {(Object.keys(KINDS) as FeedbackKind[]).map((k) => {
              const Icon = KINDS[k].icon;
              return (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? "secondary" : "outline"}
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                >
                  <Icon className="mr-1 h-4 w-4" />
                  {KINDS[k].label}
                </Button>
              );
            })}
          </div>

          <Textarea
            rows={3}
            value={report}
            placeholder={KINDS[kind].placeholder}
            onChange={(e) => setReport(e.target.value)}
          />

          <div className="flex items-start gap-2">
            <Checkbox
              id="feedback-anon"
              checked={anon}
              onCheckedChange={(v) => setAnon(v === true)}
            />
            <Label
              htmlFor="feedback-anon"
              className="text-xs font-normal leading-snug text-muted-foreground"
            >
              Send this without my name
            </Label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Said plainly both ways round. "Anonymous" is a promise, and the
                one thing worse than not offering it is offering it vaguely:
                the server never stores a name on these, so there is nothing to
                look up afterwards, and nothing to reply to either. */}
            <p className="max-w-prose text-xs text-muted-foreground">
              {anon
                ? kind === "bug"
                  ? "Your name is not stored, so nobody can ask you which class or screen this was about — say so above if it matters."
                  : "Your name is not stored. Nobody can tell it was you, and nobody can come back to you about it."
                : yourName
                  ? `Sent as ${yourName}, so an admin can come back to you about it.`
                  : "Sent with your name, so an admin can come back to you about it."}
            </p>
            <Button
              size="sm"
              disabled={isSending || report.trim() === ""}
              onClick={() => void send()}
            >
              {isSending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Help;
