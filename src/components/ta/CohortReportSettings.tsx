import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabase";
import type { CohortRow } from "@/lib/api/types";

interface CohortReportSettingsProps {
  classId: string;
  cohorts: CohortRow[];
  className?: string;
}

interface Pair {
  instructor: string;
  fi: string;
}

/**
 * Who teaches each cohort, for the weekly absence report.
 *
 * These names go in the report a TA pastes into the faculty spreadsheet, and
 * they change about once a term. They lived inside the Weekly Absences dialog,
 * behind a collapsible, which put a settings form in the middle of a screen
 * meant for reading a report — and made them hard to find when they were
 * actually wrong. The report still uses them; this is only where they are set.
 */
const CohortReportSettings = ({
  classId,
  cohorts,
  className,
}: CohortReportSettingsProps) => {
  const { toast } = useToast();
  const [pairs, setPairs] = useState<Record<string, Pair>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("cohort_report_settings")
        .select("cohort_id, instructor_name, fi_name")
        .eq("class_id", classId);
      if (error) throw error;

      setPairs(
        Object.fromEntries(
          ((data ?? []) as Array<{
            cohort_id: string;
            instructor_name: string;
            fi_name: string;
          }>).map((row) => [
            row.cohort_id,
            {
              instructor: row.instructor_name || "",
              fi: row.fi_name || "",
            },
          ]),
        ),
      );
    } catch (e) {
      toast({
        title: "Could not load lecturer and FI",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [classId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (cohortId: string, patch: Partial<Pair>) =>
    setPairs((prev) => ({
      ...prev,
      [cohortId]: { instructor: "", fi: "", ...prev[cohortId], ...patch },
    }));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const rows = cohorts.map((co) => ({
        cohort_id: co.id,
        class_id: classId,
        instructor_name: pairs[co.id]?.instructor || "",
        fi_name: pairs[co.id]?.fi || "",
        updated_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from("cohort_report_settings")
        .upsert(rows, { onConflict: "cohort_id" });
      if (error) throw error;

      toast({
        title: "Saved",
        description: "The weekly absence report will use these names.",
      });
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">Lecturer and FI, per cohort</h3>
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />}
      </div>

      {cohorts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This class has no cohorts yet.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="hidden grid-cols-[4rem_1fr_1fr] gap-2 text-xs font-medium text-muted-foreground sm:grid">
            <div>Cohort</div>
            <div>Lecturer</div>
            <div>FI</div>
          </div>

          {cohorts.map((co) => (
            <div
              key={co.id}
              className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[4rem_1fr_1fr]"
            >
              <Badge variant="outline" className="w-fit">
                {co.label}
              </Badge>
              <Input
                value={pairs[co.id]?.instructor ?? ""}
                placeholder={`Cohort ${co.label} lecturer`}
                onChange={(e) => set(co.id, { instructor: e.target.value })}
              />
              <Input
                value={pairs[co.id]?.fi ?? ""}
                placeholder={`Cohort ${co.label} FI`}
                onChange={(e) => set(co.id, { fi: e.target.value })}
              />
            </div>
          ))}

          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>

          <p className="text-xs text-muted-foreground">
            Used when generating the weekly absence report, which pastes into
            the faculty spreadsheet.
          </p>
        </div>
      )}
    </div>
  );
};

export default CohortReportSettings;
