import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Accessibility, RotateCcw } from "lucide-react";
import {
  TEXT_SCALES,
  useAccessibility,
  type MotionSetting,
  type TextScale,
} from "@/lib/accessibility";

/**
 * The accessibility panel, and the icon that opens it.
 *
 * Everything in here is applied by putting a class on <html>; index.css does
 * the rest. That is deliberate — a setting honoured by only some screens is
 * worse than no setting at all, because it looks like it is working.
 *
 * Kept beside the theme toggle rather than buried in a settings page. Somebody
 * who needs larger text needs it on the screen they are on, not after finding
 * a menu at 100%.
 */
const AccessibilitySettings = ({ className }: { className?: string }) => {
  const [open, setOpen] = useState(false);
  const a11y = useAccessibility();

  const motions: { value: MotionSetting; label: string; hint: string }[] = [
    {
      value: "system",
      label: "Match my device",
      hint: "Follow the reduced-motion setting on this machine.",
    },
    {
      value: "reduced",
      label: "Reduce motion",
      hint: "Turn off animations and transitions here, whatever the device says.",
    },
    { value: "full", label: "Allow motion", hint: "Keep animations on." },
  ];

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={className}
        onClick={() => setOpen(true)}
        aria-label="Accessibility settings"
        title="Accessibility settings"
      >
        <Accessibility className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90dvh] max-w-lg flex-col gap-0 p-4 sm:p-6">
          <DialogHeader className="shrink-0 pb-4">
            <DialogTitle className="flex items-center gap-2">
              <Accessibility className="h-5 w-5" />
              Accessibility
            </DialogTitle>
            <DialogDescription>
              These apply to this browser and are remembered. They do not change
              anything for anybody else.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            {/* ---- text size ---- */}
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Text size</p>
                <p className="text-xs text-muted-foreground">
                  Scales the whole interface, not just the words — a bigger
                  label in the same small button helps nobody.
                </p>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {(Object.keys(TEXT_SCALES) as TextScale[]).map((key) => (
                  <Button
                    key={key}
                    variant={a11y.textScale === key ? "default" : "outline"}
                    className="h-auto flex-col gap-0.5 py-2"
                    onClick={() => a11y.set("textScale", key)}
                    aria-pressed={a11y.textScale === key}
                  >
                    <span className="text-sm">{TEXT_SCALES[key].label}</span>
                    <span className="text-[10px] font-normal opacity-70">
                      {TEXT_SCALES[key].percent}%
                    </span>
                  </Button>
                ))}
              </div>
            </div>

            {/* ---- motion ---- */}
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Motion</p>
                <p className="text-xs text-muted-foreground">
                  The app already follows your device. Override it here if that
                  setting is not yours to change — a shared machine, say.
                </p>
              </div>

              <div className="space-y-1.5">
                {motions.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => a11y.set("motion", m.value)}
                    aria-pressed={a11y.motion === m.value}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      a11y.motion === m.value
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* ---- switches ---- */}
            <div className="space-y-3">
              {[
                {
                  key: "highContrast" as const,
                  label: "Higher contrast",
                  hint: "Solid borders, stronger text, and no faded elements. Keeps the colours; pushes apart the pairs that carry meaning.",
                  value: a11y.highContrast,
                },
                {
                  key: "underlineLinks" as const,
                  label: "Underline links",
                  hint: "So a link is not marked by colour alone.",
                  value: a11y.underlineLinks,
                },
                {
                  key: "alwaysShowFocus" as const,
                  label: "Always show what is focused",
                  hint: "The outline normally appears only when using Tab. This keeps it there after a click too.",
                  value: a11y.alwaysShowFocus,
                },
              ].map((row) => (
                <label
                  key={row.key}
                  className="flex cursor-pointer items-start justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {row.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {row.hint}
                    </span>
                  </span>
                  <Switch
                    checked={row.value}
                    onCheckedChange={(v) => a11y.set(row.key, v)}
                    aria-label={row.label}
                  />
                </label>
              ))}
            </div>
          </div>

          <DialogFooter className="mt-4 shrink-0 gap-2 border-t pt-4 sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              disabled={!a11y.isCustomised}
              onClick={a11y.reset}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset to defaults
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default AccessibilitySettings;
