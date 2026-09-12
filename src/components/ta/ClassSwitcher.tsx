import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { useActiveClass } from "@/lib/classContext";

/**
 * Which class the dashboard is showing.
 *
 * Lives in the sidebar header because it scopes everything below it — the
 * roster, the sessions, the analytics — rather than being a filter on any one
 * screen.
 */
const ClassSwitcher = () => {
  const { isMobile, setOpenMobile } = useSidebar();
  const { classes, activeClassId, setActiveClassId, isLoading, error } =
    useActiveClass();

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

  // Not an error state: a newly provisioned account legitimately has none yet,
  // and the Classes section is where they make one.
  if (classes.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        No classes yet. Create one in Classes.
      </p>
    );
  }

  return (
    <div className="px-2 py-1.5">
      <Select
        value={activeClassId ?? undefined}
        onValueChange={(id) => {
          setActiveClassId(id);
          /*
           * Get out of the way on a phone, for the same reason the nav does.
           * The sidebar is a sheet over the page there, so picking a class
           * changed everything underneath and showed you none of it.
           *
           * Deferred a tick because the select is closing its own popover at
           * this moment; tearing the sheet out from under it in the same frame
           * leaves the overlay behind on some browsers.
           */
          if (isMobile) setTimeout(() => setOpenMobile(false), 0);
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
        </SelectContent>
      </Select>
    </div>
  );
};

export default ClassSwitcher;
