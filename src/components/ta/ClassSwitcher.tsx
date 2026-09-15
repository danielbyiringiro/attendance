import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveClass } from "@/lib/classContext";

/** Not a class id: choosing it opens the list of every class instead. */
const ALL_CLASSES = "__all_classes__";

interface ClassSwitcherProps {
  /** Open the list of every class: create one, or find an archived one. */
  onOpenAllClasses: () => void;
}

/**
 * Which class the dashboard is showing, and the way to every other class.
 *
 * Lives in the sidebar header because it scopes everything below it — the
 * roster, the sessions, the analytics — rather than being a filter on any one
 * screen.
 *
 * The list of all classes used to be a sidebar tab of its own. It opens from
 * the foot of this list now, beside the classes it lists, and each class's
 * settings are on its own Class page.
 */
const ClassSwitcher = ({ onOpenAllClasses }: ClassSwitcherProps) => {
  const { isMobile, setOpenMobile } = useSidebar();
  const { classes, activeClassId, setActiveClassId, isLoading, error } =
    useActiveClass();

  /*
   * Get out of the way on a phone, for the same reason the nav does. The
   * sidebar is a sheet over the page there, so a choice changed everything
   * underneath and showed you none of it.
   *
   * Deferred a tick because the select is closing its own popover at this
   * moment; tearing the sheet out from under it in the same frame leaves the
   * overlay behind on some browsers.
   */
  const closeSheet = () => {
    if (isMobile) setTimeout(() => setOpenMobile(false), 0);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading classes…
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-2 py-1.5 text-xs text-destructive">
        {error}
      </p>
    );
  }

  // Not an error state: a newly provisioned account legitimately has none yet.
  if (classes.length === 0) {
    return (
      <div className="space-y-2 px-2 py-1.5">
        <p className="text-xs text-muted-foreground">No classes yet.</p>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => {
            onOpenAllClasses();
            closeSheet();
          }}
        >
          Create a class
        </Button>
      </div>
    );
  }

  return (
    <div className="px-2 py-1.5">
      <Select
        value={activeClassId ?? undefined}
        onValueChange={(value) => {
          if (value === ALL_CLASSES) onOpenAllClasses();
          else setActiveClassId(value);
          closeSheet();
        }}
      >
        <SelectTrigger className="h-9">
          <SelectValue placeholder="Choose a class" />
        </SelectTrigger>
        <SelectContent>
          {classes.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <span className="font-medium">{c.code}</span>
              <span className="text-muted-foreground"> · {c.name}</span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ALL_CLASSES}>All classes…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};

export default ClassSwitcher;
