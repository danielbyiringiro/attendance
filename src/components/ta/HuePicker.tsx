// The one control that sets a day off's colour (052).
//
// Split from dayOffHues.ts so this file exports a component and nothing else:
// a module that exports both constants and a component breaks React fast
// refresh, and the maps are imported by three files that render no picker.

import { NO_CLASS_HUES, type NoClassHue } from "@/lib/api/sessions";
import { HUE_BG, HUE_NAME } from "@/components/ta/dayOffHues";

/**
 * Pick one. Six fixed choices rather than a colour input: an arbitrary picker
 * produces days off nobody can see against a white cell, and the person who
 * picked one is the last to find out.
 */
const HuePicker = ({
  value,
  onChange,
  label = "Colour",
}: {
  value: NoClassHue;
  onChange: (hue: NoClassHue) => void;
  label?: string;
}) => (
  <div className="flex flex-wrap items-center gap-2">
    <span className="text-xs text-muted-foreground">{label}</span>
    {NO_CLASS_HUES.map((h) => (
      <button
        key={h}
        type="button"
        aria-pressed={value === h}
        aria-label={HUE_NAME[h]}
        title={HUE_NAME[h]}
        onClick={() => onChange(h)}
        className={`h-6 w-6 rounded-md transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
          HUE_BG[h]
        } ${
          value === h ? "ring-2 ring-foreground ring-offset-2" : "hover:scale-110"
        }`}
      />
    ))}
  </div>
);

export default HuePicker;
