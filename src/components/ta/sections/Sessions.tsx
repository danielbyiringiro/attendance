import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CalendarDays, List, Loader2 } from "lucide-react";
import { useActiveClass } from "@/lib/classContext";
import SessionList from "@/components/ta/SessionList";
import NoClassDays from "@/components/ta/NoClassDays";
import SessionCalendar from "@/components/ta/SessionCalendar";

/**
 * The sessions of the active class — open one, close it, move it, cancel it.
 *
 * Split from Schedule, which now holds only the weekly pattern. The two were
 * one tab of four stacked cards: a screen and a half of term setup sat above
 * the list you use every day.
 */
const Sessions = () => {
  const { activeClass, cohorts, isLoading } = useActiveClass();
  /*
   * Both views, chosen rather than replaced.
   *
   * The list answers "what is next and what do I press", which is the daily
   * question and the one with the buttons on it. The month answers "what does
   * this term look like", which the list can only show a screenful at a time
   * and the pattern editor cannot show at all. Neither is a better version of
   * the other.
   */
  const [view, setView] = useState<"list" | "month">("list");

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
    <div className="space-y-6">
      <Card className="border-2">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              onClick={() => setView("list")}
            >
              <List className="mr-1 h-4 w-4" />
              List
            </Button>
            <Button
              size="sm"
              variant={view === "month" ? "secondary" : "ghost"}
              onClick={() => setView("month")}
            >
              <CalendarDays className="mr-1 h-4 w-4" />
              Month
            </Button>
          </div>

          {view === "list" ? (
            <SessionList
              classId={activeClass.id}
              cohorts={cohorts}
              timezone={activeClass.timezone}
              termEndsOn={activeClass.term_ends_on}
            />
          ) : (
            <SessionCalendar
              classId={activeClass.id}
              cohorts={cohorts}
              timezone={activeClass.timezone}
              termEndsOn={activeClass.term_ends_on}
            />
          )}
        </CardContent>
      </Card>

      {/* Below the list, not above it. Days off are set once a term; the
          session list is the thing opened every day. */}
      <Card className="border-2">
        <CardContent className="pt-6">
          <NoClassDays classId={activeClass.id} cohorts={cohorts} />
        </CardContent>
      </Card>
    </div>
  );
};

export default Sessions;
