import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listClasses } from "@/lib/api/classes";
import type { ClassWithCohorts, CohortRow } from "@/lib/api/types";

/**
 * Which class the TA is looking at.
 *
 * The dashboard used to take `roster`, `currentPin` and `timeLimit` as props
 * from Index.tsx — a shape that is single-class by construction, since
 * `currentPin` is one PIN. This replaces that bundle.
 *
 * The choice is persisted next to the active tab so a reload lands where the TA
 * left off, in sessionStorage rather than localStorage: the same reasoning as
 * the tab key, which is that attendance data should not linger on a shared
 * machine after the browser closes.
 */

const ACTIVE_CLASS_KEY = "ta_active_class";

interface ClassContextValue {
  classes: ClassWithCohorts[];
  activeClass: ClassWithCohorts | null;
  activeClassId: string | null;
  cohorts: CohortRow[];
  isLoading: boolean;
  error: string | null;
  setActiveClassId: (id: string | null) => void;
  /** Re-read from the server, e.g. after creating or editing a class. */
  refresh: () => Promise<void>;
}

const ClassContext = createContext<ClassContextValue | null>(null);

export const ClassProvider = ({ children }: { children: ReactNode }) => {
  const [classes, setClasses] = useState<ClassWithCohorts[]>([]);
  const [activeClassId, setActiveId] = useState<string | null>(
    () => sessionStorage.getItem(ACTIVE_CLASS_KEY),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await listClasses();
      setClasses(rows);

      setActiveId((current) => {
        // A remembered class the user can no longer reach — unshared, archived
        // or deleted — must not leave the dashboard pointed at nothing.
        if (current && rows.some((c) => c.id === current)) return current;
        const next = rows[0]?.id ?? null;
        if (next) sessionStorage.setItem(ACTIVE_CLASS_KEY, next);
        else sessionStorage.removeItem(ACTIVE_CLASS_KEY);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load classes.");
      setClasses([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setActiveClassId = useCallback((id: string | null) => {
    setActiveId(id);
    if (id) sessionStorage.setItem(ACTIVE_CLASS_KEY, id);
    else sessionStorage.removeItem(ACTIVE_CLASS_KEY);
  }, []);

  const value = useMemo<ClassContextValue>(() => {
    const activeClass = classes.find((c) => c.id === activeClassId) ?? null;
    return {
      classes,
      activeClass,
      activeClassId: activeClass?.id ?? null,
      cohorts: activeClass?.cohorts ?? [],
      isLoading,
      error,
      setActiveClassId,
      refresh: load,
    };
  }, [classes, activeClassId, isLoading, error, setActiveClassId, load]);

  return <ClassContext.Provider value={value}>{children}</ClassContext.Provider>;
};

export const useActiveClass = (): ClassContextValue => {
  const ctx = useContext(ClassContext);
  if (!ctx) {
    throw new Error("useActiveClass must be used inside a ClassProvider");
  }
  return ctx;
};
