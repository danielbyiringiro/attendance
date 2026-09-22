import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CalendarDays, CalendarOff, List, Loader2, Wand2 } from "lucide-react";
import { useActiveClass } from "@/lib/classContext";
import SessionList from "@/components/ta/SessionList";
import NoClassDays from "@/components/ta/NoClassDays";
import SessionCalendar from "@/components/ta/SessionCalendar";
import Schedule from "@/components/ta/sections/Schedule";
import FillSessionsDialog from "@/components/ta/dialogs/FillSessionsDialog";

/**
 * A class's sessions and the weekly pattern that produces them, on one screen.
 *
 * They were two tabs until now, and the split put the button on one and its
 * consequence on the other: "Generate sessions" sat at the bottom of the
 * pattern editor, and the only way to see what it had done was to change tab.
 * People pressed it, read a number, and went looking. Side by side, a pattern
 * edit and the month it rewrites are in the same glance.
 *
 * Check-in timing and the display link used to sit at the top of this screen.
 * Both are set about once a term, so they moved to the class's Settings tab and
 * stopped pushing the sessions down.
 */
const Sessions = () => {
  const { activeClass, cohorts, isLoading } = useActiveClass();
  /*
   * Calendar first. The month shows the shape of a term, days off included, at
   * a glance; the list is one click away for "what is next and what do I press".
   */
  const [view, setView] = useState<"month" | "list">("month");
  const [daysOffOpen, setDaysOffOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  // Bumped when the days-off window closes, so the calendar re-reads the days
  // it paints instead of showing what it loaded before the change.
  const [calendarKey, setCalendarKey] = useState(0);

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
            Choose one in the class switcher, or create one from All classes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Above the sessions in the list, where there is room to read them. The
          calendar already paints days off on the month, so there the full list
          waits behind a button. */}
      {view === "list" && (
        <Card className="border-2">
          <CardContent className="pt-6">
            <NoClassDays classId={activeClass.id} cohorts={cohorts} />
          </CardContent>
        </Card>
      )}

      {/*
        The weekly rule beside what it produces.
        A slot used to be six controls on one line, which is why this was two
        tabs: it could not share a screen with anything. The four that are set
        once a term — length, sign-up, early open, shuts at start — now fold
        away behind each meeting, and the two that get changed stay out. Under
        xl the rail drops below the month, which is what the screen is opened
        for.
      */}
      <div className="grid gap-4 xl:grid-cols-[24rem_1fr]">
      <div className="order-2 xl:order-1">
        <Schedule />
      </div>

      <Card className="order-1 border-2 xl:order-2">
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={view === "month" ? "secondary" : "ghost"}
                aria-pressed={view === "month"}
                onClick={() => setView("month")}
              >
                <CalendarDays className="mr-1 h-4 w-4" />
                Calendar
              </Button>
              <Button
                size="sm"
                variant={view === "list" ? "secondary" : "ghost"}
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <List className="mr-1 h-4 w-4" />
                List
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setFillOpen(true)}>
                <Wand2 className="mr-1 h-4 w-4" />
                Fill in sessions
              </Button>
              {view === "month" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDaysOffOpen(true)}
              >
                <CalendarOff className="mr-1 h-4 w-4" />
                Days off
              </Button>
              )}
            </div>
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
              key={calendarKey}
              classId={activeClass.id}
              cohorts={cohorts}
              timezone={activeClass.timezone}
              termEndsOn={activeClass.term_ends_on}
            />
          )}
        </CardContent>
      </Card>
      </div>

      <FillSessionsDialog
        open={fillOpen}
        onOpenChange={setFillOpen}
        classId={activeClass.id}
        termStart={activeClass.term_starts_on}
        termEnd={activeClass.term_ends_on}
        onFilled={() => setCalendarKey((k) => k + 1)}
      />

      <Dialog
        open={daysOffOpen}
        onOpenChange={(open) => {
          setDaysOffOpen(open);
          if (!open) setCalendarKey((k) => k + 1);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Days off</DialogTitle>
            <DialogDescription>
              Days this class does not meet, for every cohort or one. The
              calendar updates when you close this.
            </DialogDescription>
          </DialogHeader>
          <NoClassDays classId={activeClass.id} cohorts={cohorts} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Sessions;
