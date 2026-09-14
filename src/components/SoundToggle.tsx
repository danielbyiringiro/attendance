import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SoundToggleProps {
  enabled: boolean;
  onChange: (next: boolean) => void;
  /** Shown beside the icon. Without it the button is icon-only, with a title. */
  label?: string;
  className?: string;
}

/**
 * Mute and unmute the check-in beep.
 *
 * One component for the dashboard, the presenter tab, the display link and the
 * student page, so the icon and wording are the same everywhere. aria-pressed
 * says whether the beep is on to anyone not reading the icon.
 */
const SoundToggle = ({ enabled, onChange, label, className }: SoundToggleProps) => {
  const action = enabled ? "Mute the check-in beep" : "Turn the check-in beep on";
  const Icon = enabled ? Volume2 : VolumeX;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      aria-pressed={enabled}
      title={action}
      onClick={() => onChange(!enabled)}
    >
      <Icon className={`h-4 w-4${label ? " mr-1" : ""}`} />
      {label ?? <span className="sr-only">{action}</span>}
    </Button>
  );
};

export default SoundToggle;
