import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useActiveClass } from "@/lib/classContext";
import SessionList from "@/components/ta/SessionList";

/**
 * The sessions of the active class — open one, close it, move it, cancel it.
 *
 * Split from Schedule, which now holds only the weekly pattern. The two were
 * one tab of four stacked cards: a screen and a half of term setup sat above
 * the list you use every day.
 */
const Sessions = () => {
  const { activeClass, cohorts, isLoading } = useActiveClass();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (!activeClass) {
    return (
      <Card className="border-2 border-dashed">
        <CardContent className="pt-6 text-center">
          <p className="font-medium">No class selected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose one in the sidebar, or create one under Classes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-2">
      <CardContent className="pt-6">
        <SessionList
          classId={activeClass.id}
          cohorts={cohorts}
          timezone={activeClass.timezone}
        />
      </CardContent>
    </Card>
  );
};

export default Sessions;
