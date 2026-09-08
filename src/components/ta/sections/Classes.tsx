import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useActiveClass } from "@/lib/classContext";
import { addCohort, archiveClass, listClasses } from "@/lib/api/classes";
import { Input } from "@/components/ui/input";
import ClassFormDialog from "@/components/ta/dialogs/ClassFormDialog";
import DeleteClassDialog from "@/components/ta/dialogs/DeleteClassDialog";
import ClassMembers from "@/components/ta/ClassMembers";
import type { ClassWithCohorts } from "@/lib/api/types";

/**
 * The next label in the A, B, C… run this class is already using, as a
 * placeholder. Only a suggestion — a cohort can be called anything.
 */
const nextLabelFor = (c: ClassWithCohorts): string => {
  const used = new Set(c.cohorts.map((co) => co.label.toUpperCase()));
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return letter;
  }
  return "New";
};

const formatRange = (from: string, to: string) => {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  return `${fmt(from)} – ${fmt(to)}`;
};

const Classes = () => {
  const { toast } = useToast();
  const { classes, activeClassId, setActiveClassId, refresh, isLoading } =
    useActiveClass();

  // Archived classes are not in the context — that only carries what the
  // switcher should offer — so this screen fetches them separately.
  const [archived, setArchived] = useState<ClassWithCohorts[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClassWithCohorts | null>(null);
  const [deleting, setDeleting] = useState<ClassWithCohorts | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Which class is having a cohort added, and the label being typed.
  const [addingCohortTo, setAddingCohortTo] = useState<string | null>(null);
  const [newCohortLabel, setNewCohortLabel] = useState("");
  const [isAddingCohort, setIsAddingCohort] = useState(false);

  useEffect(() => {
    if (!showArchived) return;
    listClasses(true)
      .then((all) => setArchived(all.filter((c) => c.archived_at !== null)))
      .catch((e) =>
        toast({
          title: "Could not load archived classes",
          description: e instanceof Error ? e.message : "Unexpected error.",
          variant: "destructive",
        }),
      );
  }, [showArchived, toast]);

  // A class's cohort count was fixed at creation: create_class took it and
  // nothing since could change it. add_cohort has existed since 007 with no
  // caller.
  const handleAddCohort = async (c: ClassWithCohorts) => {
    const label = newCohortLabel.trim();
    if (label === "") {
      toast({
        title: "A label is needed",
        description: "A letter or a short name — it is what people see.",
        variant: "destructive",
      });
      return;
    }
    if (c.cohorts.some((co) => co.label.toLowerCase() === label.toLowerCase())) {
      toast({
        title: "That cohort already exists",
        description: `${c.code} already has a cohort ${label}.`,
        variant: "destructive",
      });
      return;
    }

    setIsAddingCohort(true);
    try {
      await addCohort(c.id, label);
      toast({
        title: `Cohort ${label} added`,
        description:
          "It has no meeting days yet — set them under Schedule, then save to create its sessions.",
      });
      setAddingCohortTo(null);
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

  const handleUnarchive = async (c: ClassWithCohorts) => {
    try {
      await archiveClass(c.id, false);
      toast({ title: `${c.code} restored` });
      setArchived((prev) => prev.filter((a) => a.id !== c.id));
      await refresh();
    } catch (e) {
      toast({
        title: "Could not restore",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
    }
  };

  const renderCard = (c: ClassWithCohorts, isArchived: boolean) => (
    <Card key={c.id} className="border-2">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{c.code}</span>
              <span className="text-muted-foreground">{c.name}</span>
              {c.id === activeClassId && !isArchived && (
                <Badge variant="outline" className="text-xs">
                  showing
                </Badge>
              )}
              {isArchived && (
                <Badge variant="secondary" className="text-xs">
                  archived
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatRange(c.term_starts_on, c.term_ends_on)} · {c.timezone}
            </p>
            <p className="mt-1 text-sm">
              {c.cohorts.length} cohort{c.cohorts.length === 1 ? "" : "s"}
              {c.cohorts.length > 0 && (
                <span className="text-muted-foreground">
                  {" — "}
                  {c.cohorts.map((co) => co.label).join(", ")}
                </span>
              )}
              {!isArchived && addingCohortTo !== c.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-1 h-6 px-2 text-xs"
                  onClick={() => {
                    setAddingCohortTo(c.id);
                    setNewCohortLabel("");
                  }}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add cohort
                </Button>
              )}
            </p>

            {addingCohortTo === c.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  autoFocus
                  className="h-8 w-32"
                  value={newCohortLabel}
                  placeholder={nextLabelFor(c)}
                  disabled={isAddingCohort}
                  onChange={(e) => setNewCohortLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAddCohort(c);
                    if (e.key === "Escape") setAddingCohortTo(null);
                  }}
                />
                <Button
                  size="sm"
                  disabled={isAddingCohort}
                  onClick={() => handleAddCohort(c)}
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
                  onClick={() => setAddingCohortTo(null)}
                >
                  Cancel
                </Button>
                <span className="text-xs text-muted-foreground">
                  Existing cohorts and their sessions are untouched.
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-1 shrink-0">
            {isArchived ? (
              <Button size="sm" variant="outline" onClick={() => handleUnarchive(c)}>
                <ArchiveRestore className="h-4 w-4 mr-1" />
                Restore
              </Button>
            ) : (
              <>
                {c.id !== activeClassId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setActiveClassId(c.id)}
                  >
                    Show
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Who can manage this class"
                  onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                >
                  <Users className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Edit"
                  onClick={() => {
                    setEditing(c);
                    setFormOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Archive or delete"
                  onClick={() => setDeleting(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        {expanded === c.id && !isArchived && (
          <ClassMembers classId={c.id} className="mt-4 border-t pt-4" />
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-2" />
          New class
        </Button>

        <Button variant="ghost" onClick={() => setShowArchived((v) => !v)}>
          <Archive className="h-4 w-4 mr-2" />
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : classes.length === 0 ? (
        <Card className="border-2 border-dashed">
          <CardContent className="pt-6 text-center">
            <p className="font-medium">No classes yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create one to set its cohorts, when they meet, and who is enrolled.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">{classes.map((c) => renderCard(c, false))}</div>
      )}

      {showArchived && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">Archived</h3>
          {archived.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing archived.</p>
          ) : (
            archived.map((c) => renderCard(c, true))
          )}
        </div>
      )}

      <ClassFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={async (classId) => {
          await refresh();
          setActiveClassId(classId);
        }}
      />

      <DeleteClassDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        target={deleting}
        onDone={refresh}
      />
    </div>
  );
};

export default Classes;
