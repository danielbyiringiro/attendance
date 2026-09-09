import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Accessibility preferences, kept in the browser.
 *
 * Built as siblings of the theme rather than folded into it: a colour scheme
 * is a preference, and these are closer to requirements. Somebody who needs
 * 150% text needs it in light mode and dark mode both.
 *
 * Everything here works by putting a class or a style on <html> and letting
 * index.css do the rest, so no component has to know these settings exist.
 * That matters — a preference that only some screens honour is worse than one
 * that does not exist, because it looks like it is working.
 */

/** Root font size, which every rem in the app scales from. */
export type TextScale = "normal" | "large" | "larger" | "largest";

/** Motion: follow the machine, or override it in either direction. */
export type MotionSetting = "system" | "reduced" | "full";

export interface AccessibilityState {
  textScale: TextScale;
  highContrast: boolean;
  motion: MotionSetting;
  /** Underline links and buttons that look like links, not just colour them. */
  underlineLinks: boolean;
  /** Keep the focus ring visible even for a mouse click, not only for Tab. */
  alwaysShowFocus: boolean;
}

export const TEXT_SCALES: Record<TextScale, { label: string; percent: number }> =
  {
    normal: { label: "Normal", percent: 100 },
    large: { label: "Large", percent: 112.5 },
    larger: { label: "Larger", percent: 125 },
    largest: { label: "Largest", percent: 150 },
  };

const DEFAULTS: AccessibilityState = {
  textScale: "normal",
  highContrast: false,
  motion: "system",
  underlineLinks: false,
  alwaysShowFocus: false,
};

const STORAGE_KEY = "ta_accessibility";

interface AccessibilityContextValue extends AccessibilityState {
  set: <K extends keyof AccessibilityState>(
    key: K,
    value: AccessibilityState[K],
  ) => void;
  reset: () => void;
  /** True when anything differs from the defaults, so the UI can offer a reset. */
  isCustomised: boolean;
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(
  null,
);

const read = (): AccessibilityState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULTS;

    const parsed = JSON.parse(stored) as Partial<AccessibilityState>;

    // Field by field rather than a spread of whatever was stored: this comes
    // out of the browser, where an older version of the app — or somebody with
    // the console open — may have left something that is not one of these.
    return {
      textScale:
        parsed.textScale && parsed.textScale in TEXT_SCALES
          ? parsed.textScale
          : DEFAULTS.textScale,
      highContrast:
        typeof parsed.highContrast === "boolean"
          ? parsed.highContrast
          : DEFAULTS.highContrast,
      motion:
        parsed.motion === "reduced" ||
        parsed.motion === "full" ||
        parsed.motion === "system"
          ? parsed.motion
          : DEFAULTS.motion,
      underlineLinks:
        typeof parsed.underlineLinks === "boolean"
          ? parsed.underlineLinks
          : DEFAULTS.underlineLinks,
      alwaysShowFocus:
        typeof parsed.alwaysShowFocus === "boolean"
          ? parsed.alwaysShowFocus
          : DEFAULTS.alwaysShowFocus,
    };
  } catch {
    // Private browsing, storage disabled, or unparseable. Defaults are a
    // working app; refusing to render would not be.
    return DEFAULTS;
  }
};

export const AccessibilityProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [state, setState] = useState<AccessibilityState>(read);

  useEffect(() => {
    const root = document.documentElement;

    // Root font size, so every rem-based size in the app follows — text,
    // spacing, and the height of a button with it. Scaling only the text would
    // leave the same words in the same box, which is not the point.
    root.style.fontSize = `${TEXT_SCALES[state.textScale].percent}%`;

    root.classList.toggle("a11y-contrast", state.highContrast);
    root.classList.toggle("a11y-underline", state.underlineLinks);
    root.classList.toggle("a11y-focus", state.alwaysShowFocus);

    // "system" means neither class: the media query in index.css decides, as it
    // did before anybody opened this dialog.
    root.classList.toggle("a11y-motion-off", state.motion === "reduced");
    root.classList.toggle("a11y-motion-on", state.motion === "full");
  }, [state]);

  const set = useCallback(
    <K extends keyof AccessibilityState>(
      key: K,
      value: AccessibilityState[K],
    ) => {
      setState((current) => {
        const next = { ...current, [key]: value };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Not being able to remember it is not a reason to refuse it.
        }
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setState(DEFAULTS);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to undo if it was never stored.
    }
  }, []);

  const isCustomised = useMemo(
    () =>
      (Object.keys(DEFAULTS) as (keyof AccessibilityState)[]).some(
        (k) => state[k] !== DEFAULTS[k],
      ),
    [state],
  );

  const value = useMemo(
    () => ({ ...state, set, reset, isCustomised }),
    [state, set, reset, isCustomised],
  );

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
    </AccessibilityContext.Provider>
  );
};

export const useAccessibility = (): AccessibilityContextValue => {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) {
    throw new Error(
      "useAccessibility must be used inside an AccessibilityProvider",
    );
  }
  return ctx;
};
