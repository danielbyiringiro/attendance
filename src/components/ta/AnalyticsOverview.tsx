import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  attendanceLog,
  isAbsentState,
  isPresentState,
  tallyStates,
  type AttendanceLog,
} from "@/lib/api/attendance";
import { listSessions } from "@/lib/api/sessions";
import type { CohortRow, SessionRow } from "@/lib/api/types";
import { todayStr } from "@/lib/dates";

interface AnalyticsOverviewProps {
  classId: string;
  cohorts: CohortRow[];
  /** Everyone enrolled, for the per-cohort denominators. */
  roster: { student_id: string; cohort: string }[];
  termStartsOn: string;
  termEndsOn: string;
}

type Scope = { mode: "day"; date: string } | { mode: "term" };

const shiftDay = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

/**
 * The numbers at the top of Analytics, for a day you choose or for the term.
 *
 * IT USED TO BE TODAY, AND ONLY TODAY. A TA asking "how did Tuesday go" had to
 * open the absence history and read it a student at a time, and there was no
 * way at all to see how the term was going — which is the question that
 * actually decides whether somebody is in trouble.
 *
 * ABSENCE IS COUNTED, NOT INFERRED. The previous cards took every enrolled
 * student who was not marked present and called them absent. That is the exact
 * derivation this project spent migration 004 removing: it cannot tell a
 * student who missed a class from a day the class did not meet, so choosing a
 * Sunday would have reported the entire roster absent. These read the stored
 * records — `unexcused` is an absence, a session with no record at all is not.
 */
const AnalyticsOverview = ({
  classId,
  cohorts,
  roster,
  termStartsOn,
  termEndsOn,
}: AnalyticsOverviewProps) => {
  const { toast } = useToast();
  const [scope, setScope] = useState<Scope>({ mode: "day", date: todayStr() });
  const [log, setLog] = useState<AttendanceLog | null>(null);
  /*
   * Sessions that have not happened, which the log cannot show.
   *
   * attendanceLog deliberately leaves out `scheduled` ones — it answers "what
   * was attended", and a session nobody has held yet has no attendance to
   * report. But "nothing was held here" and "the class meets here on Thursday
   * and has not yet" are different answers to the same question, and only the
   * second tells somebody the date they picked was a class day at all.
   */
  const [upcoming, setUpcoming] = useState<SessionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const from = scope.mode === "day" ? scope.date : termStartsOn;
  const to = scope.mode === "day" ? scope.date : termEndsOn;

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [entries, sessions] = await Promise.all([
        attendanceLog(classId, { from, to }),
        listSessions({ classId, from, to }),
      ]);
      setLog(entries);
      setUpcoming(sessions.filter((s) => s.status === "scheduled"));
    } catch (e) {
      toast({
        title: "Could not load attendance",
        description: e instanceof Error ? e.message : "Unexpected error.",
        variant: "destructive",
      });
      setLog(null);
      setUpcoming([]);
    } finally {
      setIsLoading(false);
    }
  }, [classId, from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    if (!log) return null;

    // attendanceLog already leaves out sessions that have not happened, so
    // "held" here means exactly that. Cancelled ones come back labelled and
    // are counted separately: a cancelled Wednesday is not a day anybody
    // missed.
    const held = log.sessions.filter((s) => s.status !== "cancelled");
    const cancelled = log.sessions.length - held.length;
    const heldIds = new Set(held.map((s) => s.session_id));
    const marks = log.marks.filter((m) => heldIds.has(m.session_id));

    const cohortOf = new Map(roster.map((r) => [r.student_id, r.cohort]));

    const byCohort = cohorts.map((co) => {
      const theirs = marks.filter(
        (m) => (cohortOf.get(m.student_id) ?? m.cohort_label) === co.label,
      );
      const t = tallyStates(theirs.map((m) => m.state));

      return {
        id: co.id,
        label: co.label,
        present: theirs.filter((m) => isPresentState(m.state)).length,
        // Distinct people, for the day view: "12 of 20 here" is about people.
        presentPeople: new Set(
          theirs.filter((m) => isPresentState(m.state)).map((m) => m.student_id),
        ).size,
        enrolled: roster.filter((r) => r.cohort === co.label).length,
        sessions: held.filter((s) => s.cohort_label === co.label).length,
        rate: t.rate,
      };
    });

    return {
      held: held.length,
      cancelled,
      present: marks.filter((m) => isPresentState(m.state)).length,
      absent: marks.filter((m) => isAbsentState(m.state)).length,
      presentPeople: new Set(
        marks.filter((m) => isPresentState(m.state)).map((m) => m.student_id),
      ).size,
      absentPeople: new Set(
        marks.filter((m) => isAbsentState(m.state)).map((m) => m.student_id),
      ).size,
      rate: tallyStates(marks.map((m) => m.state)).rate,
      byCohort,
    };
  }, [log, cohorts, roster]);

  const isDay = scope.mode === "day";
  const isToday = isDay && scope.date === todayStr();

  return (
    <div className="space-y-4">
      {/* ---- what these numbers are about ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant={isDay ? "secondary" : "ghost"}
            size="sm"
            onClick={() =>
              setScope({ mode: "day", date: isDay ? scope.date : todayStr() })
            }
          >
            A day
          </Button>
          <Button
            variant={!isDay ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setScope({ mode: "term" })}
          >
            <CalendarRange className="mr-1 h-4 w-4" />
            Whole term
          </Button>
        </div>

        {isDay && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title="The day before"
              onClick={() =>
                setScope({ mode: "day", date: shiftDay(scope.date, -1) })
              }
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <Input
              type="date"
              className="h-9 w-[10.5rem]"
              value={scope.date}
              min={termStartsOn}
              max={termEndsOn}
              onChange={(e) =>
                e.target.value &&
                setScope({ mode: "day", date: e.target.value })
              }
            />

            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              title="The day after"
              onClick={() =>
                setScope({ mode: "day", date: shiftDay(scope.date, 1) })
              }
            >
              <ChevronRight className="h-4 w-4" />
            </Button>

            {!isToday && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setScope({ mode: "day", date: todayStr() })}
              >
                Today
              </Button>
            )}
          </div>
        )}

        {isLoading && <Loader2 className="h-4 w-4 animate-spin opacity-60" />}
      </div>

      {/*
        What this day or term actually was, said before the numbers rather than
        instead of them.

        The cards used to be replaced by a message when nothing had been held.
        That hid the shape of the class on exactly the days somebody is asking
        about it — a date with a session still to come reads very differently
        from a date with no class at all, and the cards are how you see which
        cohorts are involved.
      */}
      {stats && stats.held === 0 && (
        <Card className="border-2 border-dashed">
          <CardContent className="py-4 text-center">
            <p className="text-sm font-medium">
              {upcoming.length > 0
                ? isDay
                  ? `Nothing marked yet — ${upcoming.length} session${
                      upcoming.length === 1 ? " is" : "s are"
                    } scheduled for this day.`
                  : `No session has been held yet — ${upcoming.length} scheduled this term.`
                : isDay
                  ? "No session was held on this day, and none is scheduled."
                  : "No sessions have been held yet this term."}
            </p>
            {stats.cancelled > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {stats.cancelled} cancelled session
                {stats.cancelled === 1 ? " was" : "s were"} scheduled.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-2 border-success/30 bg-success/5 shadow-soft">
          <CardContent className="pt-6">
            <div className="flex items-center space-x-2">
              <UserCheck className="h-5 w-5 text-success" />
              <div>
                <p className="text-2xl font-bold text-success">
                  {isDay ? (stats?.presentPeople ?? 0) : (stats?.present ?? 0)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isDay ? "Present" : "Marks present"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-destructive/30 bg-destructive/5 shadow-soft">
          <CardContent className="pt-6">
            <div className="flex items-center space-x-2">
              <UserX className="h-5 w-5 text-destructive" />
              <div>
                <p className="text-2xl font-bold text-destructive">
                  {isDay ? (stats?.absentPeople ?? 0) : (stats?.absent ?? 0)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isDay ? "Absent" : "Marks absent"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/*
          The term's rate rather than a fourth count. Over a term the useful
          number is the proportion, and it is the same definition every other
          screen uses — tallyStates, so this cannot disagree with the roster or
          with the export.
        */}
        {!isDay && (
          <Card className="border-2 border-primary/25 bg-gradient-card shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center space-x-2">
                <CalendarRange className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-2xl font-bold">{stats?.rate ?? 0}%</p>
                  <p className="text-sm text-muted-foreground">
                    Across {stats?.held ?? 0} session
                    {stats?.held === 1 ? "" : "s"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {stats?.byCohort.map((c) => {
          // Which cohorts meet on this day, for the ones with nothing marked.
          const due = upcoming.filter((u) => u.cohort_id === c.id).length;

          return (
            <Card
              key={c.id}
              className="border-2 border-primary/25 bg-gradient-card shadow-soft"
            >
              <CardContent className="pt-6">
                <div className="flex items-center space-x-2">
                  <Users className="h-5 w-5 text-primary" />
                  <div className="min-w-0">
                    <p className="text-2xl font-bold">
                      {isDay ? `${c.presentPeople}/${c.enrolled}` : `${c.rate}%`}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      Cohort {c.label}
                      {!isDay && c.sessions > 0 && (
                        <span className="ml-1 text-xs">
                          · {c.sessions} session{c.sessions === 1 ? "" : "s"}
                        </span>
                      )}
                      {isDay && c.sessions === 0 && due > 0 && (
                        <span className="ml-1 text-xs">· due today</span>
                      )}
                      {isDay && c.sessions === 0 && due === 0 && (
                        <span className="ml-1 text-xs">· no class</span>
                      )}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {stats && stats.held > 0 && stats.cancelled > 0 && (
        <p className="text-xs text-muted-foreground">
          <Badge variant="outline" className="mr-1">
            {stats.cancelled} cancelled
          </Badge>
          not counted against anybody.
        </p>
      )}
    </div>
  );
};

export default AnalyticsOverview;
