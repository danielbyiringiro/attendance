// Remembered Canvas row mappings.
//
// A pairing made by hand, or a row marked as not-a-student, is a decision worth
// keeping: the same Canvas export gets filled every few weeks, and the rows
// that need human judgement are the same ones every time.
//
// Requires sql/add_canvas_mappings.sql. If that has not been run, every call
// here degrades to a no-op and matching simply forgets between exports — the
// export itself keeps working.

import { supabase } from "@/lib/supabase";
import type { CanvasMatch } from "@/lib/canvasGradebook";

export interface CanvasMapping {
  canvasKey: string;
  studentId: string | null;
  ignored: boolean;
  canvasName: string;
}

/** Postgres "relation does not exist"; PostgREST also reports its own code. */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);

const isMissingTable = (error: { code?: string; message?: string } | null) =>
  !!error &&
  (MISSING_TABLE_CODES.has(error.code ?? "") ||
    /canvas_row_mappings/i.test(error.message ?? "") &&
      /does not exist|not find|schema cache/i.test(error.message ?? ""));

export interface MappingStore {
  mappings: Map<string, CanvasMapping>;
  /** False when the table is absent, so the UI can say memory is off. */
  available: boolean;
}

export const loadCanvasMappings = async (): Promise<MappingStore> => {
  const { data, error } = await supabase
    .from("canvas_row_mappings")
    .select("canvas_key, student_id, ignored, canvas_name");

  if (error) {
    if (isMissingTable(error)) return { mappings: new Map(), available: false };
    // A real failure: log it, but never block an export over remembered state.
    console.error("Could not load Canvas mappings:", error);
    return { mappings: new Map(), available: false };
  }

  const mappings = new Map<string, CanvasMapping>();
  (data || []).forEach((r) => {
    mappings.set(String(r.canvas_key), {
      canvasKey: String(r.canvas_key),
      studentId: r.student_id ? String(r.student_id) : null,
      ignored: Boolean(r.ignored),
      canvasName: r.canvas_name ? String(r.canvas_name) : "",
    });
  });
  return { mappings, available: true };
};

/** Store one decision. Returns false when memory is unavailable. */
export const saveCanvasMapping = async (
  mapping: CanvasMapping,
): Promise<boolean> => {
  const { error } = await supabase.from("canvas_row_mappings").upsert(
    {
      canvas_key: mapping.canvasKey,
      student_id: mapping.studentId,
      ignored: mapping.ignored,
      canvas_name: mapping.canvasName,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "canvas_key" },
  );
  if (error) {
    if (!isMissingTable(error)) {
      console.error("Could not save Canvas mapping:", error);
    }
    return false;
  }
  return true;
};

/** Forget one decision, so the row goes back to being matched from scratch. */
export const forgetCanvasMapping = async (
  canvasKey: string,
): Promise<boolean> => {
  const { error } = await supabase
    .from("canvas_row_mappings")
    .delete()
    .eq("canvas_key", canvasKey);
  if (error) {
    if (!isMissingTable(error)) {
      console.error("Could not forget Canvas mapping:", error);
    }
    return false;
  }
  return true;
};

/**
 * Overlay remembered decisions onto a fresh match.
 *
 * A remembered *ignore* always wins: someone stated that row is not a person,
 * and nothing in a later export makes it one.
 *
 * A remembered *pairing* only fills a row that is otherwise unmatched. Memory
 * is there to cover what the automatic rules cannot see, not to override
 * current evidence — if Canvas has since been given a correct SIS User ID, that
 * is fresher than a pairing made by hand months ago.
 */
export const applyRememberedMappings = (
  matches: CanvasMatch[],
  mappings: Map<string, CanvasMapping>,
): CanvasMatch[] => {
  const claimed = new Set(
    matches.map((m) => m.studentId).filter((id): id is string => Boolean(id)),
  );

  return matches.map((m) => {
    const remembered = mappings.get(m.canvasKey);
    if (!remembered) return m;

    if (remembered.ignored) {
      return {
        ...m,
        ignored: true,
        ignoredReason: "remembered" as const,
        studentId: null,
        how: "unmatched" as const,
      };
    }

    // A stored decision that this row IS a person overrides the boilerplate
    // guess — someone looked at it and said so.
    const base: CanvasMatch =
      m.ignored && m.ignoredReason === "boilerplate"
        ? { ...m, ignored: false, ignoredReason: undefined }
        : m;

    if (base.ignored || base.studentId || !remembered.studentId) return base;
    // The student may already belong to another row in this file.
    if (claimed.has(remembered.studentId)) return base;

    claimed.add(remembered.studentId);
    return {
      ...base,
      studentId: remembered.studentId,
      how: "remembered" as const,
    };
  });
};
