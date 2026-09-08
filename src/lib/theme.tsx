import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "ta_theme";

interface ThemeContextValue {
  /** What the user chose, which may be "system". */
  theme: Theme;
  /** What is actually on screen right now. */
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const systemPrefers = (): "light" | "dark" =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

const read = (): Theme => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Private browsing, or storage disabled. Fall through to the default.
  }
  return "system";
};

/**
 * Light, dark, or whatever the machine is set to.
 *
 * `darkMode: ["class"]` has been in the Tailwind config from the start and
 * index.css has always had a `.dark` block, but nothing ever put the class on
 * the document — so dark mode was unreachable and every `dark:` variant in the
 * codebase was dead. This is the piece that was missing.
 *
 * localStorage rather than sessionStorage: unlike the active class and tab,
 * which are deliberately forgotten when the browser closes so attendance data
 * does not linger on a shared machine, a colour preference is not sensitive
 * and being asked for it every session would be irritating.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setThemeState] = useState<Theme>(read);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(systemPrefers);

  // Follow the machine while the choice is "system" — someone whose OS flips at
  // sunset expects the app to come with it, without a reload.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved: "light" | "dark" = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    // Lets the browser paint form controls and scrollbars to match.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not being able to remember it is not a reason to refuse the change.
    }
  }, []);

  const value = useMemo(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside a ThemeProvider");
  return ctx;
};
