import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { listNoClassDays, listSessions, type NoClassMode } from "@/lib/api/sessions";
import type { CohortRow, SessionRow, SessionStatus } from "@/lib/api/types";
import { monthGrid, toDateStr, todayStr } from "@/lib/dates";

/**
 * A month of sessions.
 *
 * Offered beside the list rather than instead of it. The list answers "what is
 * next and what do I press"; this answers "what does this month look like",
 * which is the question the pattern editor cannot show and the list only shows
 * one screenful at a time.
 *
 * DELIBERATELY READ-MOSTLY
 *
 * Nothing here drags. A calendar is instance-shaped and the schedule is
 * pattern-shaped, so dragging a session has two defensible meanings — move this
 * one, or change the pattern from here on — and picking wrong silently rewrites
 * a term. That question is far easier to answer against a view that exists than
 * in the abstract, so this ships without it and clicking a day hands off to the
 * dialogs that already know how to act on a session.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Colour by what the day actually is, not by a palette. */
const STATUS_DOT: Record<SessionStatus, string> = {
  scheduled: "bg-muted-foreground/40",
  open: "bg-success",
  closed: "bg-primary/60",
  cancelled: "bg-destructive/60",
};

const SessionCalendar = ({
  classId,
  cohorts,
  timezone,
}: {
  classId: string;
  cohorts: CohortRow[];
  timezone: string;
}) => {
  const today = todayStr();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [daysOff, setDaysOff] = useState<
    Array<{ on_date: string; mode: NoClassMode; reason: string; cohort_id: string | null }>
  >([]);
  const [isLoading, setIsLoading] = useState(false);

  const days = useMemo(
    () => monthGrid(cursor.year, cursor.month),
    [cursor.year, cursor.month],
  );

  const load = useCallback(async () => {
    if (days.length === 0) return;
    setIsLoading(true);
    try {
      // The whole grid, not the whole month: the first and last rows show days
      // from the neighbouring months, and leaving those blank makes the grid
      // look like the term has gaps it does not have.
      const [rows, off] = await Promise.all([
        listSessions({
          classId,
          from: toDateStr(days[0]),
          to: toDateStr(days[days.length - 1]),
        }),
        listNoClassDays(classId),
      ]);
      setSessions(rows);
      setDaysOff(off);
    } catch {
      setSessions([]);
      setDaysOff([]);
    } finally {
      setIsLoading(false);
    }
  }, [classId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    sessions.forEach((s) => {
      const list = map.get(s.session_date);
      if (list) list.push(s);
      else map.set(s.session_date, [s]);
    });
    return map;
  }, [sessions]);

  const offByDate = useMemo(() => {
    const map = new Map<string, (typeof daysOff)[number]>();
    daysOff.forEach((d) => map.set(d.on_date, d));
    return map;
  }, [daysOff]);

  const cohortLabel = useMemo(
    () => new Map(cohorts.map((c) => [c.id, c.label])),
    [cohorts],
  );

  const timeOf = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });

  const monthName = new Date(cursor.year, cursor.month, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );

  const step = (by: number) =>
    setCursor((c) => {
      const d = new Date(c.year, c.month + by, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-medium">
            {monthName}
          </span>
          <Button variant="ghost" size="sm" onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {isLoading && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const d = new Date();
              setCursor({ year: d.getFullYear(), month: d.getMonth() });
            }}
          >
            Today
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="bg-muted/50 py-1 text-center text-xs font-medium text-muted-foreground"
          >
            {/* One letter on a phone: seven columns of "Wed" does not fit. */}
            <span className="sm:hidden">{w[0]}</span>
            <span className="hidden sm:inline">{w}</span>
          </div>
        ))}

        {days.map((d) => {
          const key = toDateStr(d);
          const inMonth = d.getMonth() === cursor.month;
          const isToday = key === today;
          const off = offByDate.get(key);
          const onDay = byDate.get(key) ?? [];

          return (
            <div
              key={key}
              className={`min-h-[4.5rem] bg-card p-1 sm:min-h-[6rem] ${
                inMonth ? "" : "opacity-40"
              } ${off ? "bg-muted/40" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs tabular-nums ${
                    isToday
                      ? "rounded bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {d.getDate()}
                </span>
              </div>

              {off && (
                <p
                  className="mt-0.5 truncate text-[0.65rem] leading-tight text-muted-foreground"
                  title={off.reason}
                >
                  {off.mode === "exempt" ? "No class" : "Counted"} · {off.reason}
                </p>
              )}

              <div className="mt-0.5 space-y-0.5">
                {onDay.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[0.65rem] leading-tight hover:bg-muted"
                    title={`Cohort ${cohortLabel.get(s.cohort_id) ?? "?"} · ${timeOf(s.starts_at)} · ${s.status}`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[s.status]}`}
                    />
                    <span className="truncate">
                      {cohortLabel.get(s.cohort_id) ?? "?"}{" "}
                      <span className="text-muted-foreground">
                        {timeOf(s.starts_at)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {(
          [
            ["scheduled", "Scheduled"],
            ["open", "Open"],
            ["closed", "Closed"],
            ["cancelled", "Cancelled"],
          ] as Array<[SessionStatus, string]>
        ).map(([status, label]) => (
          <span key={status} className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
            {label}
          </span>
        ))}
        <Badge variant="outline" className="text-[0.65rem]">
          shaded = day off
        </Badge>
      </div>
    </div>
  );
};

export default SessionCalendar;
