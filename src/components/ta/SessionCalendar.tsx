import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  listNoClassDays,
  listSessions,
  type NoClassMode,
} from "@/lib/api/sessions";
import type { CohortRow, SessionRow, SessionStatus } from "@/lib/api/types";
import { monthGrid, toDateStr, todayStr } from "@/lib/dates";
import CalendarDayDialog, {
  type DayOff,
} from "@/components/ta/dialogs/CalendarDayDialog";
import SessionEditDialog from "@/components/ta/dialogs/SessionEditDialog";
import SessionCancelDialog from "@/components/ta/dialogs/SessionCancelDialog";

/**
 * A month of sessions.
 *
 * Offered beside the list rather than instead of it. The list answers "what is
 * next and what do I press"; this answers "what does this month look like",
 * which is the question the pattern editor cannot show and the list only shows
 * one screenful at a time.
 *
 * EDITABLE BY CLICKING A DAY, NOT BY DRAGGING
 *
 * Dragging a session has two defensible meanings — move this one, or change the
 * pattern from here on — and picking wrong silently rewrites a term. Clicking a
 * day has no such ambiguity: you get that day, and the actions that apply to it.
 *
 * So every day opens a dialog with the sessions on it, their open/close/edit/
 * cancel actions, and the two things you can add: a session, or a declared day
 * off. None of that is new behaviour — it is the same components and the same
 * two RPCs the list and the days-off panel use. The calendar is another way in,
 * not a second implementation.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * What kind of day this is. The whole cell is styled from it, rather than a dot
 * in a corner.
 *
 * A month grid is read by scanning, and a 6px dot does not survive scanning.
 * The first version differed only by a dot and a faint tint, so a cancelled day,
 * a holiday and an ordinary one were all the same pale square. Each kind now
 * changes the cell ground, which makes the shape of the month legible before any
 * text is.
 */
type DayKind =
  /** Declared off, does not count. */
  | "holiday"
  /** Declared, and credited to everybody. */
  | "credited"
  /** Something is running right now. */
  | "live"
  /** Every session that day was called off. */
  | "cancelled"
  /** Sessions that have been and gone. */
  | "done"
  /** Sessions still to come. */
  | "upcoming"
  /** Nothing scheduled. */
  | "empty";

/**
 * Diagonal hatching for a day the class does not meet.
 *
 * A texture rather than a seventh tint, because tints are how the other kinds
 * are told apart and one more would be indistinguishable. Hatching reads as
 * struck out at any size, including the small cell a phone gets.
 */
const HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.14) 0 3px, transparent 3px 8px)",
};

/**
 * A hue each, and a solid edge to carry it.
 *
 * The previous version left three of the seven kinds — done, upcoming and empty
 * — all as plain card, which is most of a normal month, so the grid read as flat
 * however carefully the other four were treated.
 *
 * Two signals rather than one. A tint alone washes out at 10% over a card, and
 * the edge survives that: a solid bar of the hue whatever the ground does, still
 * legible in the small cell a phone gets.
 *
 * THE EDGE IS AN INSET SHADOW, NOT A BORDER
 *
 * High-contrast mode sets border-color on every element in the page:
 *
 *   .a11y-contrast * { border-color: hsl(var(--border)); }
 *
 * which is right for the borders it was written for and would repaint every one
 * of these the same grey. The whole scheme would collapse to seven 10% tints in
 * the one mode that exists because tints are hard to see. box-shadow is not
 * reachable by that rule.
 *
 * The hues are spaced round the wheel on purpose. Blue for planned, green for
 * running, teal for finished, amber for a deliberate override, red for called
 * off, grey for a day that is not a working day. Green and teal are the closest
 * pair, so the live day gets a wider bar as well.
 */
/*
 * Written out in full, never built from parts.
 *
 * Tailwind finds classes by scanning source text for complete literals. A
 * helper returning `shadow-[inset_${px}px_...]` produces names the scanner
 * never sees, so the CSS is simply not emitted and every cell comes out with no
 * edge at all — silently, with no error and a clean build. The first version of
 * this did exactly that; the classes were correct and absent.
 */
const KIND_CELL: Record<DayKind, string> = {
  holiday:
    "bg-muted/70 shadow-[inset_3px_0_0_hsl(var(--muted-foreground))]",
  credited: "bg-warning/15 shadow-[inset_3px_0_0_hsl(var(--warning))]",
  live: "bg-success/25 shadow-[inset_5px_0_0_hsl(var(--success))]",
  cancelled: "bg-destructive/10 shadow-[inset_3px_0_0_hsl(var(--destructive))]",
  done: "bg-accent/10 shadow-[inset_3px_0_0_hsl(var(--accent))]",
  upcoming: "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
  empty: "bg-muted/25",
};

const kindOf = (
  sessions: SessionRow[],
  off: { mode: NoClassMode } | null | undefined,
  today: string,
  date: string,
): DayKind => {
  if (off) return off.mode === "exempt" ? "holiday" : "credited";
  if (sessions.length === 0) return "empty";
  if (sessions.some((s) => s.status === "open")) return "live";
  if (sessions.every((s) => s.status === "cancelled")) return "cancelled";
  return date < today ? "done" : "upcoming";
};

/**
 * How one session reads inside a cell.
 *
 * Solid grounds rather than tints here. The chip sits ON a tinted cell, so a
 * second tint of the same hue disappears into it — the closed chip used to be
 * primary/15 on a card and was invisible the moment the cell gained a colour.
 */
const CHIP: Record<SessionStatus, string> = {
  scheduled: "bg-primary/25 text-foreground",
  open: "bg-success text-success-foreground font-semibold",
  closed: "bg-accent/30 text-foreground",
  cancelled: "bg-destructive/20 text-destructive line-through",
};

const SessionCalendar = ({
  classId,
  cohorts,
  timezone,
  termEndsOn,
}: {
  classId: string;
  cohorts: CohortRow[];
  timezone: string;
  /** Caps "for the rest of term" at the class's own end date. */
  termEndsOn: string;
}) => {
  const today = todayStr();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  // Edit and cancel are rendered here rather than inside the day dialog: a
  // dialog nested in a dialog traps focus in the wrong one and closes both when
  // either is dismissed.
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [cancelling, setCancelling] = useState<SessionRow | null>(null);

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

          const kind = kindOf(onDay, off, today, key);
          // Three at most. A cell listing six sessions in 4px type is not
          // showing you six sessions.
          const shown = onDay.slice(0, 3);
          const hidden = onDay.length - shown.length;

          return (
            <button
              type="button"
              key={key}
              onClick={() => setOpenDay(key)}
              style={kind === "holiday" ? HATCH : undefined}
              className={`min-h-[4.5rem] cursor-pointer p-1 text-left transition-colors hover:brightness-95 sm:min-h-[6rem] ${
                KIND_CELL[kind]
              } ${inMonth ? "" : "opacity-40"} ${
                isToday ? "ring-2 ring-inset ring-primary" : ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span
                  className={`text-xs tabular-nums ${
                    isToday
                      ? "font-bold text-primary"
                      : kind === "empty"
                        ? "text-muted-foreground/50"
                        : "font-semibold text-foreground"
                  }`}
                >
                  {d.getDate()}
                </span>
                {/* The count, so a dense day still reads as dense where the
                    chips below are cut off. */}
                {onDay.length > 1 && (
                  <span className="text-[0.6rem] tabular-nums text-muted-foreground">
                    {onDay.length}
                  </span>
                )}
              </div>

              {off && (
                <p
                  className={`mt-0.5 truncate text-[0.65rem] font-medium leading-tight ${
                    off.mode === "exempt"
                      ? "text-muted-foreground"
                      : "text-primary"
                  }`}
                  title={off.reason}
                >
                  {off.mode === "exempt" ? "No class" : "Counted"}
                </p>
              )}

              <div className="mt-0.5 space-y-0.5">
                {shown.map((s) => (
                  <div
                    key={s.id}
                    className={`truncate rounded px-1 py-px text-[0.65rem] leading-tight ${CHIP[s.status]}`}
                    title={`Cohort ${cohortLabel.get(s.cohort_id) ?? "?"} · ${timeOf(s.starts_at)} · ${s.status}`}
                  >
                    {cohortLabel.get(s.cohort_id) ?? "?"} {timeOf(s.starts_at)}
                  </div>
                ))}
                {hidden > 0 && (
                  <p className="px-1 text-[0.6rem] text-muted-foreground">
                    +{hidden} more
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <CalendarDayDialog
        date={openDay}
        classId={classId}
        cohorts={cohorts}
        sessions={openDay ? (byDate.get(openDay) ?? []) : []}
        dayOff={openDay ? (offByDate.get(openDay) ?? null) : null}
        timezone={timezone}
        termEndsOn={termEndsOn}
        onClose={() => setOpenDay(null)}
        onChanged={load}
        onEdit={(s) => {
          setOpenDay(null);
          setEditing(s);
        }}
        onCancelSession={(s) => {
          setOpenDay(null);
          setCancelling(s);
        }}
      />

      <SessionEditDialog
        session={editing}
        timezone={timezone}
        cohortLabel={editing ? (cohortLabel.get(editing.cohort_id) ?? "?") : ""}
        onClose={() => setEditing(null)}
        onSaved={load}
      />

      <SessionCancelDialog
        session={cancelling}
        cohortLabel={
          cancelling ? (cohortLabel.get(cancelling.cohort_id) ?? "?") : ""
        }
        onClose={() => setCancelling(null)}
        onCancelled={load}
      />

      {/*
        The legend shows the actual cell treatments, not a parallel set of dots.
        A key that does not look like the thing it explains is one more thing to
        decode.
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {(
          [
            ["upcoming", "Scheduled"],
            ["live", "Open now"],
            ["done", "Been and gone"],
            ["cancelled", "Cancelled"],
            ["holiday", "No class"],
            ["credited", "Counted"],
          ] as Array<[DayKind, string]>
        ).map(([kind, label]) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span
              style={kind === "holiday" ? HATCH : undefined}
              className={`h-4 w-6 shrink-0 rounded border ${KIND_CELL[kind]}`}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
};

export default SessionCalendar;
