import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Copy, Loader2, Monitor, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  DISPLAY_MAX_ATTEMPTS,
  getDisplayLink,
  issueDisplayCode,
  revokeDisplayLink,
  type DisplayLink,
} from "@/lib/api/display";
import { displayUrl } from "@/lib/classDisplay";
import { isUnreachableFromPhone } from "@/lib/checkinLink";

/**
 * The class's display link, for a screen that is not signed in.
 *
 * The presenter tab needs a staff account, which is right on the TA's laptop
 * and wrong on a room PC, a TV or a tablet by the door. This gives the class
 * one link that can be sent to any of those, and a short access code typed on
 * the screen itself before it shows anything. Once in, the screen follows the
 * class from session to session with nobody touching it.
 *
 * The code is shown here in full, and can be shown again: it guards the same
 * live PINs everybody on this panel can already see. The link survives a new
 * code, so a link already sent keeps working; turning it off does not, so the
 * address is dead for good.
 */
const DisplayLinkPanel = ({ classId }: { classId: string }) => {
  const { toast } = useToast();
  // undefined while loading, null when the class has no link.
  const [link, setLink] = useState<DisplayLink | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"issue" | "revoke" | null>(null);

  const load = useCallback(async () => {
    try {
      setLink(await getDisplayLink(classId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unexpected error.");
    }
  }, [classId]);

  useEffect(() => {
    setLink(undefined);
    void load();
  }, [load]);

  const run = async (kind: "issue" | "revoke") => {
    setBusy(kind);
    try {
      if (kind === "issue") await issueDisplayCode(classId);
      else await revokeDisplayLink(classId);
      await load();
      toast({
        title:
          kind === "revoke"
            ? "Display link turned off"
            : link
              ? "New access code issued"
              : "Display link created",
        description:
          kind === "revoke"
            ? "Screens using it stop showing the code within a few seconds."
            : link
              ? "Screens using the old code will ask for this one."
              : undefined,
      });
    } catch (e) {
      toast({
        title: kind === "revoke" ? "Could not turn off the link" : "Could not issue a code",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const url = link ? displayUrl(window.location.origin, link.token) : "";
  const locked = link ? link.failed_attempts >= DISPLAY_MAX_ATTEMPTS : false;

  const copy = () => {
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied" }),
      () =>
        toast({
          title: "Could not copy",
          description: "Select the link and copy it by hand.",
          variant: "destructive",
        }),
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-medium">
          <Monitor className="h-4 w-4" />
          Show on another screen
        </p>
        <p className="text-xs text-muted-foreground">
          A link for a screen nobody is signed in to — a room PC, a TV or a
          tablet. It asks for the access code before it shows anything, then
          shows this class&apos;s check-in code whenever a session is running.
        </p>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      {link === undefined && !loadError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </p>
      )}

      {link === null && (
        <Button size="sm" onClick={() => void run("issue")} disabled={busy !== null}>
          {busy === "issue" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Create a display link
        </Button>
      )}

      {link && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              readOnly
              value={url}
              aria-label="Display link"
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-1 h-4 w-4" />
              Copy
            </Button>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {/* For opening the link on a tablet or phone without typing it.
                The access code is deliberately not in it. */}
            <div className="self-start rounded-lg bg-white p-2">
              <QRCodeSVG
                value={url}
                size={112}
                level="M"
                bgColor="#ffffff"
                fgColor="#000000"
                marginSize={0}
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Access code</p>
              <p className="font-mono text-3xl font-bold tracking-[0.25em]">
                {link.access_code}
              </p>
              {locked ? (
                <p className="text-xs text-destructive">
                  Locked after {DISPLAY_MAX_ATTEMPTS} wrong codes. Issue a new
                  code to unlock it.
                </p>
              ) : (
                link.failed_attempts > 0 && (
                  <p className="text-xs text-warning">
                    {link.failed_attempts} wrong{" "}
                    {link.failed_attempts === 1 ? "attempt" : "attempts"} so far.
                    It locks at {DISPLAY_MAX_ATTEMPTS}.
                  </p>
                )
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run("issue")}
              disabled={busy !== null}
            >
              {busy === "issue" ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-4 w-4" />
              )}
              New code
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" disabled={busy !== null}>
                  Turn off link
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Turn off the display link?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Every screen using it stops showing the code, and the link
                    will not work again. Creating another gives a new link to
                    send.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void run("revoke")}>
                    Turn it off
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <p className="text-xs text-muted-foreground">
            A new code signs out every screen using the current one; the link
            stays the same.
          </p>

          {isUnreachableFromPhone(window.location.hostname) && (
            <p className="text-xs text-warning">
              This dashboard is open on localhost, so the link only works on
              this computer. Open the dashboard by its network address to share
              it.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default DisplayLinkPanel;
