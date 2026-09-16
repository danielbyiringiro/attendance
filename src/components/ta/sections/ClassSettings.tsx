import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Archive,
  GraduationCap,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useActiveClass } from "@/lib/classContext";
import { useResetOnOpen } from "@/lib/useResetOnOpen";
import { addCohort, archiveClass } from "@/lib/api/classes";
import ClassFormDialog from "@/components/ta/dialogs/ClassFormDialog";
import DeleteClassDialog from "@/components/ta/dialogs/DeleteClassDialog";
import SessionTimingSettings from "@/components/ta/SessionTimingSettings";
import CohortReportSettings from "@/components/ta/CohortReportSettings";
import ClassMembers from "@/components/ta/ClassMembers";
import DisplayLinkPanel from "@/components/ta/DisplayLinkPanel";
import {
  requirementOf,
  requirementSummary,
} from "@/lib/attendanceRule";

const SECTIONS = [
  { id: "class-settings-details", label: "Details" },
  { id: "class-settings-cohorts", label: "Cohorts" },
  { id: "class-settings-timing", label: "Check-in timing" },
  { id: "class-settings-report", label: "Weekly report" },
  { id: "class-settings-people", label: "People" },
  { id: "class-settings-screen", label: "Screen sharing" },
  { id: "class-settings-archive", label: "Archive or delete" },
];

/**
 * The next label in the A, B, C… run a class is already using, as a
 * placeholder. Only a suggestion — a cohort can be called anything.
 */
const nextLabelFor = (labels: string[]): string => {
  const used = new Set(labels.map((l) => l.toUpperCase()));
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return "New";
};

const formatDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

interface ClassSettingsProps {
  /** Where to go once the class is archived or deleted. */
  onOpenAllClasses: () => void;
}

/**
 * Everything about a class that is set up rather than used day to day.
 *
 * These were spread across three sidebar tabs and a panel: details behind an
 * edit icon and cohorts on the Classes list, check-in timing and the display
 * link on Class Sessions, and people and lecturer/FI names in a panel that only
 * opened from a people icon. One page now, with a jump list beside it.
 *
 * Archive and delete are two separate actions. They used to be one dialog with
 * archiving as its main button, and people who meant to delete archived instead
 * and could not find the class again.
 */
const ClassSettings = ({ onOpenAllClasses }: ClassSettingsProps) => {
  const { toast } = useToast();
  const { activeClass, cohorts, refresh } = useActiveClass();
  const [editOpen, setEditOpen] = useState(false);
  const [addingCohort, setAddingCohort] = useState(false);
  const [newCohortLabel, setNewCohortLabel] = useState("");
  const [isAddingCohort, setIsAddingCohort] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Switching class in the switcher keeps this tab open. A cohort label half
  // typed for the last class must not be added to this one.
  useResetOnOpen(activeClass?.id, () => {
    setAddingCohort(false);
    setNewCohortLabel("");
  });

  if (!activeClass) return null;

  const jumpTo = (id: string) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  const handleAddCohort = async () => {
    const label = newCohortLabel.trim();
    if (label === "") {
      toast({
        title: "A label is needed",
        description: "A letter or a short name — it is what people see.",
        variant: "destructive",
      });
      return;
    }
    if (cohorts.some((co) => co.label.toLowerCase() === label.toLowerCase())) {
      toast({
        title: "That cohort already exists",
        description: `${activeClass.code} already has a cohort ${label}.`,
        variant: "destructive",
      });
      return;
    }

    setIsAddingCohort(true);
    try {
      await addCohort(activeClass.id, label);
      toast({
        title: `Cohort ${label} added`,
        description:
          "It has no meeting days yet — set them on the Weekly pattern tab.",
      });
      setAddingCohort(false);
      setNewCohortLabel("");
      await refresh();
    } catch (e) {
      toast({
        title: "Could not add the cohort",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsAddingCohort(false);
    }
  };

  const handleArchive = async () => {
    setIsArchiving(true);
    try {
      await archiveClass(activeClass.id, true);
      toast({
        title: `${activeClass.code} archived`,
        description:
          "Nothing was deleted. Restore it from All classes → Show archived.",
      });
      setArchiveOpen(false);
      await refresh();
      onOpenAllClasses();
    } catch (e) {
      toast({
        title: "Could not archive",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setIsArchiving(false);
    }
  };

  const details: Array<[string, string]> = [
    ["Class code", activeClass.code],
    ["Name", activeClass.name],
    [
      "Term",
      `${formatDate(activeClass.term_starts_on)} – ${formatDate(activeClass.term_ends_on)}`,
    ],
    ["Timezone", activeClass.timezone],
    [
      activeClass.attendance_rule === "absences"
        ? "Absences allowed"
        : "Required attendance",
      requirementSummary(requirementOf(activeClass)),
    ],
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
      {/* A jump list rather than more tabs: the sections are short, and
          seeing them in one scroll is how you notice what is set and what is
          not. Hidden on narrow screens, where the page is one column anyway. */}
      <nav aria-label="Settings sections" className="hidden lg:block">
        <div className="sticky top-6 flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              size="sm"
              className="justify-start text-muted-foreground"
              onClick={() => jumpTo(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </nav>

      <div className="min-w-0 space-y-6">
        <Card id="class-settings-details" className="scroll-mt-6 border-2">
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <GraduationCap className="h-4 w-4" />
                  Details
                </p>
                <p className="text-xs text-muted-foreground">
                  The code students see, the term dates sessions are made
                  between, and the attendance this class requires.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-1 h-4 w-4" />
                Edit details
              </Button>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {details.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="truncate text-sm font-medium">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card id="class-settings-cohorts" className="scroll-mt-6 border-2">
          <CardContent className="space-y-4 pt-6">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                <Layers className="h-4 w-4" />
                Cohorts
              </p>
              <p className="text-xs text-muted-foreground">
                Existing cohorts and their sessions are untouched when you add
                one. A new cohort has no meeting days until you set them on the
                Weekly pattern tab.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {cohorts.map((co) => (
                <Badge key={co.id} variant="outline" className="h-8 px-3 text-sm">
                  Cohort {co.label}
                </Badge>
              ))}
              {addingCohort ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="class-settings-new-cohort"
                    autoFocus
                    aria-label="New cohort label"
                    className="h-8 w-32"
                    value={newCohortLabel}
                    placeholder={nextLabelFor(cohorts.map((co) => co.label))}
                    disabled={isAddingCohort}
                    onChange={(e) => setNewCohortLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleAddCohort();
                      if (e.key === "Escape") setAddingCohort(false);
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={isAddingCohort}
                    onClick={() => void handleAddCohort()}
                  >
                    {isAddingCohort ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Add"
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isAddingCohort}
                    onClick={() => setAddingCohort(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAddingCohort(true);
                    setNewCohortLabel("");
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add cohort
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card id="class-settings-timing" className="scroll-mt-6 border-2">
          <CardContent className="pt-6">
            <SessionTimingSettings />
          </CardContent>
        </Card>

        <Card id="class-settings-report" className="scroll-mt-6 border-2">
          <CardContent className="pt-6">
            <CohortReportSettings classId={activeClass.id} cohorts={cohorts} />
          </CardContent>
        </Card>

        <Card id="class-settings-people" className="scroll-mt-6 border-2">
          <CardContent className="pt-6">
            <ClassMembers classId={activeClass.id} />
          </CardContent>
        </Card>

        <Card id="class-settings-screen" className="scroll-mt-6 border-2">
          <CardContent className="pt-6">
            <DisplayLinkPanel classId={activeClass.id} />
          </CardContent>
        </Card>

        <Card id="class-settings-archive" className="scroll-mt-6 border-2">
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm font-medium">Archive or delete</p>

            <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">Archive this class</p>
                <p className="text-xs text-muted-foreground">
                  Hides it from the class switcher. Nothing is deleted, and you
                  can restore it from All classes → Show archived.
                </p>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => setArchiveOpen(true)}
              >
                <Archive className="mr-1 h-4 w-4" />
                Archive
              </Button>
            </div>

            <div className="flex flex-col gap-3 rounded-md border border-destructive/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-destructive">
                  Delete permanently
                </p>
                <p className="text-xs text-muted-foreground">
                  Removes the class with its sessions and attendance, and cannot
                  be undone. You type the class code to confirm.
                </p>
              </div>
              <Button
                variant="destructive"
                className="shrink-0"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Delete permanently
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <ClassFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={activeClass}
        onSaved={() => void refresh()}
      />

      <AlertDialog
        open={archiveOpen}
        onOpenChange={(open) => {
          if (!isArchiving) setArchiveOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {activeClass.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the class switcher and the dashboard, but its sessions,
              attendance and students are all kept. Bring it back any time from
              All classes → Show archived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isArchiving}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={isArchiving}
              onClick={(e) => {
                // Stay open until the request answers, so a failure is seen.
                e.preventDefault();
                void handleArchive();
              }}
            >
              {isArchiving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteClassDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        target={activeClass}
        onDone={() => {
          void refresh();
          onOpenAllClasses();
        }}
      />
    </div>
  );
};

export default ClassSettings;
