// The six colours a day off can be given (052), and the one picker that sets
// them.
//
// Every Tailwind class name for these lives here, written out in full and
// never assembled. Tailwind finds classes by scanning source text for complete
// literals, so `bg-[hsl(var(--off-${hue}))]` emits no CSS whatsoever: the
// swatches render as invisible squares and the calendar cells lose their
// colour, silently, with no error and a clean build. Three files need these
// strings; one file should own them.
//
// The values behind the tokens are in index.css, defined twice — once for
// light and once for dark. That is the whole reason the column stores a name
// rather than a hex: a colour picked at noon still has to read at night.

import type { NoClassHue } from "@/lib/api/sessions";

/** A solid block of the colour: swatches, and the edge on a day-off banner. */
export const HUE_BG: Record<NoClassHue, string> = {
  amber: "bg-[hsl(var(--off-amber))]",
  rose: "bg-[hsl(var(--off-rose))]",
  violet: "bg-[hsl(var(--off-violet))]",
  teal: "bg-[hsl(var(--off-teal))]",
  blue: "bg-[hsl(var(--off-blue))]",
  slate: "bg-[hsl(var(--off-slate))]",
};

/** The colour as text — the reason, printed in its own day's colour. */
export const HUE_TEXT: Record<NoClassHue, string> = {
  amber: "text-[hsl(var(--off-amber))]",
  rose: "text-[hsl(var(--off-rose))]",
  violet: "text-[hsl(var(--off-violet))]",
  teal: "text-[hsl(var(--off-teal))]",
  blue: "text-[hsl(var(--off-blue))]",
  slate: "text-[hsl(var(--off-slate))]",
};

/**
 * A calendar cell: a wash of the colour and a solid edge carrying it.
 *
 * Two signals rather than one, for the reason SessionCalendar's KIND_CELL
 * gives — a tint alone washes out at this opacity, and an edge alone is easy
 * to miss on a dense month.
 */
export const HUE_CELL: Record<NoClassHue, string> = {
  amber:
    "bg-[hsl(var(--off-amber)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-amber))]",
  rose: "bg-[hsl(var(--off-rose)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-rose))]",
  violet:
    "bg-[hsl(var(--off-violet)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-violet))]",
  teal: "bg-[hsl(var(--off-teal)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-teal))]",
  blue: "bg-[hsl(var(--off-blue)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-blue))]",
  slate:
    "bg-[hsl(var(--off-slate)/0.16)] shadow-[inset_3px_0_0_hsl(var(--off-slate))]",
};

/** What each colour is called, so a swatch has a name and not just a look. */
export const HUE_NAME: Record<NoClassHue, string> = {
  amber: "Amber",
  rose: "Rose",
  violet: "Violet",
  teal: "Teal",
  blue: "Blue",
  slate: "Slate",
};

/**
 * The hatch that marks a day nothing runs on, in that day's colour.
 *
 * An inline style rather than a class, because it is the one place the value
 * is interpolated — and safe here precisely because it never reaches Tailwind.
 */
export const hatchFor = (hue: NoClassHue) => ({
  backgroundImage: `repeating-linear-gradient(45deg, hsl(var(--off-${hue}) / 0.22) 0 3px, transparent 3px 8px)`,
});
