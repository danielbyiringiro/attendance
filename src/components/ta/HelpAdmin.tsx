import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Megaphone, Plus, PlayCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ConfirmDelete from "@/components/ta/ConfirmDelete";
import {
  adminDeleteAnnouncement,
  adminDeleteHelpVideo,
  adminPostAnnouncement,
  adminSetHelpVideo,
  getHelp,
  type Announcement,
  type HelpVideo,
} from "@/lib/api/help";

/**
 * What staff see on the Help screen: the videos, and the notices.
 *
 * Its own component rather than three more cards inside Admin, which is already
 * doing accounts, domains and class repair. Everything here is admin-only and
 * the server checks that too — these RPCs refuse anybody else, so this being
 * rendered inside the admin section is convenience, not the guard.
 */
const HelpAdmin = () => {
  const { toast } = useToast();
  const [videos, setVideos] = useState<HelpVideo[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");

  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const help = await getHelp();
      setVideos(help.videos);
      setAnnouncements(help.announcements);
    } catch (e) {
      toast({
        title: "Could not load the Help content",
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

  const addVideo = async () => {
    setBusy("video");
    try {
      await adminSetHelpVideo({
        title: title.trim(),
        url: url.trim(),
        description: description.trim() || undefined,
        // Appended, so the overview stays first unless somebody reorders.
        sortOrder: videos.length,
      });
      setTitle("");
      setUrl("");
      setDescription("");
      toast({ title: "Video added" });
      await load();
    } catch (e) {
      toast({
        title: "Could not add the video",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    setBusy("note");
    try {
      await adminPostAnnouncement(noteTitle.trim(), noteBody.trim());
      setNoteTitle("");
      setNoteBody("");
      toast({
        title: "Announced",
        description:
          "Everyone sees a dot on Help until they read it. It stays listed afterwards.",
      });
      await load();
    } catch (e) {
      toast({
        title: "Could not post it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const removeVideo = async (v: HelpVideo) => {
    setBusy(v.id);
    try {
      await adminDeleteHelpVideo(v.id);
      toast({ title: "Video removed" });
      await load();
    } catch (e) {
      toast({
        title: "Could not remove it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const removeNote = async (a: Announcement) => {
    setBusy(a.id);
    try {
      await adminDeleteAnnouncement(a.id);
      toast({ title: "Announcement removed" });
      await load();
    } catch (e) {
      toast({
        title: "Could not remove it",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const looksLikeWeb = /^https?:\/\//i.test(url.trim());

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlayCircle className="h-5 w-5" />
          Help and announcements
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">Videos</p>
              {videos.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  None yet. The first one is the overview everybody sees first.
                </p>
              ) : (
                videos.map((v) => (
                  <div
                    key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{v.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {v.url}
                      </p>
                    </div>
                    <ConfirmDelete
                      label="Remove"
                      confirmLabel="Yes, remove it"
                      warning="Staff lose this link from the Help screen."
                      size="sm"
                      isWorking={busy === v.id}
                      resetKey={v.id}
                      onConfirm={() => void removeVideo(v)}
                    />
                  </div>
                ))
              )}

              <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="help-title">Title</Label>
                  <Input
                    id="help-title"
                    value={title}
                    placeholder="How this works"
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="help-url">Link</Label>
                  <Input
                    id="help-url"
                    value={url}
                    placeholder="https://www.youtube.com/watch?v=…"
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="help-desc">Description (optional)</Label>
                  <Input
                    id="help-desc"
                    value={description}
                    placeholder="The five minute overview"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button
                    size="sm"
                    disabled={
                      busy === "video" || !title.trim() || !looksLikeWeb
                    }
                    onClick={() => void addVideo()}
                  >
                    {busy === "video" ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-4 w-4" />
                    )}
                    Add video
                  </Button>
                  {url.trim() !== "" && !looksLikeWeb && (
                    <p className="mt-1 text-xs text-destructive">
                      A link has to start with http:// or https://.
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2 border-t pt-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Megaphone className="h-4 w-4" />
                Announcements
              </p>

              {announcements.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing announced yet.
                </p>
              ) : (
                announcements.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{a.title}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {a.body}
                      </p>
                    </div>
                    <ConfirmDelete
                      label="Remove"
                      confirmLabel="Yes, remove it"
                      warning="It disappears from everybody's Updates list."
                      size="sm"
                      isWorking={busy === a.id}
                      resetKey={a.id}
                      onConfirm={() => void removeNote(a)}
                    />
                  </div>
                ))
              )}

              <div className="space-y-2 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="note-title">Title</Label>
                  <Input
                    id="note-title"
                    value={noteTitle}
                    placeholder="Check-in can close at the start now"
                    onChange={(e) => setNoteTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="note-body">What changed</Label>
                  <Textarea
                    id="note-body"
                    rows={3}
                    value={noteBody}
                    placeholder="Set it on Class then Settings. Off by default."
                    onChange={(e) => setNoteBody(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={
                    busy === "note" || !noteTitle.trim() || !noteBody.trim()
                  }
                  onClick={() => void post()}
                >
                  {busy === "note" ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Megaphone className="mr-1 h-4 w-4" />
                  )}
                  Announce
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default HelpAdmin;
