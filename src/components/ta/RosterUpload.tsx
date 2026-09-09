import { useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileUp,
  Loader2,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  applyMapping,
  autoMap,
  codesMatch,
  courseCodeIn,
  readCsvFile,
  type ColumnMapping,
  type ExtractedTable,
} from "@/lib/roster";
import { previewEnrolments, upsertEnrolments } from "@/lib/api/enrolment";
import type { UpsertEnrolmentsResult } from "@/lib/api/types";

interface CohortOption {
  id: string;
  label: string;
}

interface RosterUploadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cohorts: CohortOption[];
  /** Pre-selected cohort, if the caller knows which one. */
  defaultCohortId?: string;
  /** The active class's code, checked against the one in the file. */
  classCode?: string | null;
  /** Re-read the roster behind this dialog once something was written. */
  onUploaded: () => void;
}

type Step = "pick" | "map" | "confirm" | "done";

/**
 * Upload a class list into one cohort.
 *
 * NOTHING IS SAVED. The file is read in the browser, parsed in memory, and
 * dropped when this closes. What crosses the network is the {student_id, name}
 * list and nothing else — not the file, not its name, not the columns that
 * were discarded.
 *
 * Four steps, because the expensive mistakes here are silent ones. Choosing
 * the wrong ID column does not error: mark_attendance matches student_id
 * exactly, so it enrols people whose IDs nobody will ever type and marks every
 * one of them absent for the rest of term. Uploading into the wrong class does
 * not error either. So the mapping is shown before it is used, and the preview
 * is real — it comes from the same server function that does the write, asked
 * not to write (migration 023), rather than from a calculation here that could
 * drift away from it.
 */
const RosterUpload = ({
  open,
  onOpenChange,
  cohorts,
  defaultCohortId,
  classCode,
  onUploaded,
}: RosterUploadProps) => {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("pick");
  const [cohortId, setCohortId] = useState(defaultCohortId ?? "");
  const [table, setTable] = useState<ExtractedTable | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    studentId: null,
    name: null,
    headerRow: null,
  });
  const [moveExisting, setMoveExisting] = useState(false);
  const [preview, setPreview] = useState<UpsertEnrolmentsResult | null>(null);
  const [result, setResult] = useState<UpsertEnrolmentsResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const reset = () => {
    setStep("pick");
    setTable(null);
    setMapping({ studentId: null, name: null, headerRow: null });
    setMoveExisting(false);
    setPreview(null);
    setResult(null);
    setShowRaw(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const mapped = useMemo(
    () => (table ? applyMapping(table, mapping) : { rows: [], skipped: [] }),
    [table, mapping],
  );

  const fileCode = useMemo(
    () => (table ? courseCodeIn(table.preamble) : null),
    [table],
  );

  const codeMismatch = !codesMatch(fileCode, classCode ?? null);

  const cohortLabel =
    cohorts.find((c) => c.id === cohortId)?.label ?? "";

  // ---- step 1: the file ----------------------------------------------------

  const handleFile = async (file: File) => {
    setIsBusy(true);
    try {
      const name = file.name.toLowerCase();
      const isPdf =
        name.endsWith(".pdf") || file.type === "application/pdf";

      // pdfjs is about a megabyte and most uploads are CSV, so it is fetched
      // only when somebody actually picks a PDF.
      const extracted = isPdf
        ? await (await import("@/lib/roster/pdfSource")).readPdfFile(file)
        : await readCsvFile(file);

      if (extracted.rows.length === 0) {
        toast({
          title: "Nothing in that file",
          description: "It parsed as empty. Check it opens in a spreadsheet.",
          variant: "destructive",
        });
        return;
      }

      setTable(extracted);
      setMapping(autoMap(extracted.rows));
      setStep("map");
    } catch (e) {
      // Deliberately not echoing the file name: it alone identifies a class
      // and cohort, and this text can end up in logs.
      toast({
        title: "Could not read that file",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  // ---- step 2: what the columns mean --------------------------------------

  const handlePreview = async () => {
    if (!cohortId) {
      toast({ title: "Choose a cohort first", variant: "destructive" });
      return;
    }
    if (mapping.studentId === null) {
      toast({
        title: "Say which column holds the student ID",
        description:
          "Nothing can be uploaded until that is known — guessing it wrong is invisible until attendance stops matching.",
        variant: "destructive",
      });
      return;
    }

    setIsBusy(true);
    try {
      setPreview(await previewEnrolments(cohortId, mapped.rows, moveExisting));
      setStep("confirm");
    } catch (e) {
      toast({
        title: "Could not check the roster",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  // ---- step 3: do it -------------------------------------------------------

  const handleUpload = async () => {
    setIsBusy(true);
    try {
      const outcome = await upsertEnrolments(cohortId, mapped.rows, moveExisting);
      setResult(outcome);
      setStep("done");
      onUploaded();
    } catch (e) {
      toast({
        title: "The upload failed",
        description: e instanceof Error ? e.message : "Unknown error.",
        variant: "destructive",
      });
    } finally {
      setIsBusy(false);
    }
  };

  const headerCells =
    table && mapping.headerRow !== null ? table.rows[mapping.headerRow] : null;

  const columnCount = table
    ? Math.max(...table.rows.map((r) => r.length), 0)
    : 0;

  const columnName = (i: number) =>
    headerCells?.[i]?.trim() ? headerCells[i].trim() : `Column ${i + 1}`;

  const sample = mapped.rows.slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5" />
            Upload a class list
          </DialogTitle>
          <DialogDescription>
            {step === "pick" &&
              "A CSV or PDF exported from CAMU or Canvas. The file is read here in your browser and never stored anywhere."}
            {step === "map" &&
              "Check the columns before anything is uploaded. Getting the ID column wrong does not show up until attendance stops matching."}
            {step === "confirm" &&
              "This is what the upload will do, worked out by the server that will do it."}
            {step === "done" && "Done."}
          </DialogDescription>
        </DialogHeader>

        {/* ---- step 1 ---- */}
        {step === "pick" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Into which cohort</label>
              <Select value={cohortId} onValueChange={setCohortId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a cohort" />
                </SelectTrigger>
                <SelectContent>
                  {cohorts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      Cohort {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A list is uploaded into one cohort at a time. Somebody already in
                another cohort of this class is reported rather than moved,
                unless you say otherwise.
              </p>
            </div>

            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />

            <Button
              variant="outline"
              className="h-24 w-full border-dashed"
              disabled={isBusy || !cohortId}
              onClick={() => fileInput.current?.click()}
            >
              {isBusy ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <span className="flex flex-col items-center gap-1">
                  <Upload className="h-5 w-5" />
                  <span>Choose a CSV or PDF file</span>
                </span>
              )}
            </Button>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              The file is not uploaded or saved. It is read in this browser, and
              only the student IDs and names are sent — the other columns never
              leave your machine.
            </p>
          </div>
        )}

        {/* ---- step 2 ---- */}
        {step === "map" && table && (
          <div className="space-y-4">
            {table.preamble.length > 0 && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {table.preamble.slice(0, 2).map((line, i) => (
                  <div key={i} className="truncate">
                    {line}
                  </div>
                ))}
              </div>
            )}

            {codeMismatch && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  This file looks like <strong>{fileCode}</strong>, but the
                  class you are uploading into is{" "}
                  <strong>{classCode}</strong>. Check you have the right file
                  and the right class before continuing.
                </span>
              </div>
            )}

            {mapping.headerRow === null && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  No column titles were recognised, so nothing has been guessed.
                  Pick the columns yourself below.
                </span>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Student ID column
                </label>
                <Select
                  value={mapping.studentId === null ? "" : String(mapping.studentId)}
                  onValueChange={(v) =>
                    setMapping({ ...mapping, studentId: Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose the ID column" />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {columnName(i)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The number students type when they check in.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Name column</label>
                <Select
                  value={mapping.name === null ? "none" : String(mapping.name)}
                  onValueChange={(v) =>
                    setMapping({
                      ...mapping,
                      name: v === "none" ? null : Number(v),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No names in this file</SelectItem>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {columnName(i)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Optional. A missing name is filled in; an existing one is
                  never overwritten.
                </p>
              </div>
            </div>

            {sample.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">
                  First {sample.length} of {mapped.rows.length}, as they will be
                  sent
                </p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left">Student ID</th>
                        <th className="px-3 py-1.5 text-left">Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sample.map((r, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-1.5 font-mono">
                            {r.student_id}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.name ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/*
              What the file actually gave us, before any interpretation.
              A PDF has no table in it — the rows above are reconstructed from
              where the text sits on the page, and that reconstruction is
              wrong often enough to be worth being able to look at. It is also
              the only way to diagnose a bad read without sending the document
              to anybody.
            */}
            <div className="space-y-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto p-0 text-xs text-muted-foreground hover:bg-transparent"
                onClick={() => setShowRaw(!showRaw)}
              >
                {showRaw ? "Hide" : "Show"} what was read from the file
                {table.kind === "pdf" && ` (${table.pageCount} page${table.pageCount === 1 ? "" : "s"})`}
              </Button>

              {showRaw && (
                <div className="max-h-64 overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <tbody>
                      {table.rows.slice(0, 40).map((row, r) => (
                        <tr
                          key={r}
                          className={
                            r === mapping.headerRow
                              ? "border-t bg-primary/10 font-medium"
                              : "border-t"
                          }
                        >
                          <td className="w-10 px-2 py-1 text-right text-muted-foreground">
                            {r + 1}
                          </td>
                          {row.map((cell, c) => (
                            <td
                              key={c}
                              className={
                                c === mapping.studentId
                                  ? "whitespace-nowrap px-2 py-1 font-mono font-semibold"
                                  : "whitespace-nowrap px-2 py-1"
                              }
                            >
                              {cell || <span className="text-muted-foreground">·</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {table.rows.length > 40 && (
                    <p className="border-t px-2 py-1 text-xs text-muted-foreground">
                      +{table.rows.length - 40} more rows
                    </p>
                  )}
                </div>
              )}
            </div>

            {mapped.skipped.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {mapped.skipped.length} line
                {mapped.skipped.length === 1 ? "" : "s"} will be ignored:{" "}
                {Array.from(new Set(mapped.skipped.map((s) => s.reason))).join(
                  ", ",
                )}
                .
              </p>
            )}
          </div>
        )}

        {/* ---- step 3 ---- */}
        {step === "confirm" && preview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "New to the system", value: preview.created_students },
                { label: "Already known", value: preview.reused_students },
                { label: "Will be enrolled", value: preview.enrolled },
                { label: "Already in this cohort", value: preview.already_enrolled },
              ].map((s) => (
                <div key={s.label} className="rounded-md border px-3 py-2">
                  <div className="text-2xl font-bold">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>

            {/*
              The signature of the wrong ID column. A class whose students have
              checked in before should mostly be RECOGNISED, not created. Said
              in words, because nobody reads two numbers and draws the
              inference themselves.
            */}
            {preview.created_students > 0 && preview.reused_students === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  Every one of these {preview.created_students} students is new
                  to the system and none was recognised. That is expected for a
                  brand-new class — but it is also exactly what picking the
                  wrong ID column looks like. If these students have checked in
                  before, go back and check the column.
                </span>
              </div>
            )}

            {preview.in_other_cohort.length > 0 && (
              <div className="space-y-2 rounded-md border px-3 py-2">
                <p className="text-sm font-medium">
                  {preview.in_other_cohort.length} already in another cohort of
                  this class
                </p>
                <div className="flex flex-wrap gap-1">
                  {preview.in_other_cohort.slice(0, 12).map((s) => (
                    <Badge key={s.student_id} variant="outline">
                      {s.student_id} · {s.current_cohort}
                    </Badge>
                  ))}
                  {preview.in_other_cohort.length > 12 && (
                    <Badge variant="outline">
                      +{preview.in_other_cohort.length - 12} more
                    </Badge>
                  )}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={moveExisting}
                    onCheckedChange={(v) => {
                      setMoveExisting(v === true);
                      setPreview(null);
                      setStep("map");
                    }}
                    className="mt-0.5"
                  />
                  <span>
                    Move them into Cohort {cohortLabel}.{" "}
                    <span className="text-muted-foreground">
                      This changes which sessions they count as absent from, so
                      the preview is worked out again.
                    </span>
                  </span>
                </label>
              </div>
            )}

            {preview.invalid.length > 0 && (
              <div className="space-y-1 rounded-md border px-3 py-2">
                <p className="text-sm font-medium">
                  {preview.invalid.length} row
                  {preview.invalid.length === 1 ? "" : "s"} cannot be used
                </p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {preview.invalid.slice(0, 6).map((r, i) => (
                    <li key={i}>
                      Row {r.row}: {r.reason}
                    </li>
                  ))}
                  {preview.invalid.length > 6 && (
                    <li>+{preview.invalid.length - 6} more</li>
                  )}
                </ul>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Nothing has been written yet.
            </p>
          </div>
        )}

        {/* ---- step 4 ---- */}
        {step === "done" && result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">
                {result.enrolled} student
                {result.enrolled === 1 ? "" : "s"} enrolled in Cohort{" "}
                {cohortLabel}
              </span>
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>{result.created_students} new to the system</li>
              <li>{result.reused_students} already known and reused</li>
              {result.moved > 0 && <li>{result.moved} moved from another cohort</li>}
              {result.already_enrolled > 0 && (
                <li>{result.already_enrolled} were already in this cohort</li>
              )}
              {result.invalid.length > 0 && (
                <li>{result.invalid.length} unusable rows ignored</li>
              )}
            </ul>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {step === "map" || step === "confirm" ? (
            <Button
              variant="ghost"
              disabled={isBusy}
              onClick={() => setStep(step === "confirm" ? "map" : "pick")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => close(false)}>
              {step === "done" ? "Close" : "Cancel"}
            </Button>

            {step === "map" && (
              <Button onClick={handlePreview} disabled={isBusy}>
                {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Check what this will do
              </Button>
            )}

            {step === "confirm" && (
              <Button onClick={handleUpload} disabled={isBusy}>
                {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Upload {mapped.rows.length} row
                {mapped.rows.length === 1 ? "" : "s"}
              </Button>
            )}

            {step === "done" && (
              <Button
                variant="secondary"
                onClick={() => {
                  reset();
                }}
              >
                Upload another
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RosterUpload;
