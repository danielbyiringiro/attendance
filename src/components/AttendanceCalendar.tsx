import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { monthGrid, toDateStr, todayStr } from "@/lib/dates";
import {
  DAY_TONES,
  TONE_LABEL,
  dayTone,
  entriesByDate,
  latestMonth,
  type CalendarEntry,
  type DayTone,
} from "@/lib/attendanceCalendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/*
 * Written out in full, never built from parts: Tailwind only emits classes it
 * finds as complete literals in the source (see SessionCalendar).
 *
 * Inset shadows rather than borders for the coloured edge, because high
 * contrast mode repaints every border in one colour and would flatten them.
 */
const TONE_CELL: Record<DayTone, string> = {
  present: "bg-success/15 shadow-[inset_3px_0_0_hsl(var(--success))]",
  late: "bg-warning/15 shadow-[inset_3px_0_0_hsl(var(--warning))]",
  absent: "bg-destructive/15 shadow-[inset_3px_0_0_hsl(var(--destructive))]",
  excused: "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]",
  exempted: "bg-muted/70 shadow-[inset_3px_0_0_hsl(var(--muted-foreground))]",
  dayoff: "bg-muted/70 shadow-[inset_3px_0_0_hsl(var(--muted-foreground))]",
  pending: "bg-muted/40 shadow-[inset_3px_0_0_hsl(var(--border))]",
  cancelled: "bg-muted/40 shadow-[inset_3px_0_0_hsl(var(--muted-foreground))]",
};

/*
 * A day off is striped, the same way SessionCalendar marks one, so it reads as
 * "no class" at a glance and is never mistaken for a single exemption, which
 * shares its colour. Inline rather than a class: the gradient's commas and
 * spaces do not survive as a Tailwind arbitrary value.
 */
const HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.14) 0 3px, transparent 3px 8px)",
};

interface AttendanceCalendarProps {
  entries: CalendarEntry[];
  /** When given, a day with sessions is a button that calls this with its date. */
  onDayClick?: (date: string) => void;
}

/**
 * One student's sessions as a month, each day coloured by what was recorded.
 *
 * Shared by the student record dialog and the student's own history page, the
 * list's other half on both. A pattern — every Monday missed, a run of lates in
 * one week — shows at a glance here and hides in a list of forty rows.
 *
 * Each day also says what it was in words, so nothing depends on telling two
 * colours apart. A day with several sessions shows the tone most worth noticing
 * and a count; the rule is dayTone in lib/attendanceCalendar.
 */
const AttendanceCalendar = ({ entries, onDayClick }: AttendanceCalendarProps) => {
  const today = todayStr();
  const latest = useMemo(() => latestMonth(entries.map((e) => e.date)), [entries]);
  const [cursor, setCursor] = useState(latest);

  // A different student or class opens on their own latest month. A correction
  // leaves the dates alone, so it does not move a month somebody navigated to.
  useEffect(() => {
    setCursor({ year: latest.year, month: latest.month });
  }, [latest.year, latest.month]);

  const days = useMemo(
    () => monthGrid(cursor.year, cursor.month),
    [cursor.year, cursor.month],
  );
  const byDate = useMemo(() => entriesByDate(entries), [entries]);
  const tonesShown = useMemo(
    () => DAY_TONES.filter((t) => entries.some((e) => e.tone === t)),
    [entries],
  );

  const monthName = new Date(cursor.year, cursor.month, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  const atLatest = cursor.year === latest.year && cursor.month === latest.month;

  const step = (by: number) =>
    setCursor((c) => {
      const d = new Date(c.year, c.month + by, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Previous month"
            onClick={() => step(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] text-center text-sm font-medium">
            {monthName}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Next month"
            onClick={() => step(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atLatest}
          onClick={() => setCursor({ year: latest.year, month: latest.month })}
        >
          Latest
        </Button>
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
          const onDay = byDate.get(key) ?? [];
          const tone = dayTone(onDay.map((e) => e.tone));
          const words = onDay.map((e) => e.label ?? TONE_LABEL[e.tone]);
          const summary =
            onDay.length > 0
              ? `${d.toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}: ${onDay
                  .map((e) =>
                    e.tone === "dayoff" && e.label
                      ? `${TONE_LABEL.dayoff} (${e.label})`
                      : TONE_LABEL[e.tone],
                  )
                  .join(", ")}`
              : undefined;

          // Spans throughout, not divs or paragraphs: the cell may be a button,
          // and a button can only contain phrasing content.
          const body = (
            <>
              <span className="flex items-baseline justify-between gap-1">
                <span
                  className={`text-xs tabular-nums ${
                    isToday
                      ? "font-bold text-primary"
                      : tone
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground/50"
                  }`}
                >
                  {d.getDate()}
                </span>
                {onDay.length > 1 && (
                  <span className="text-[0.6rem] tabular-nums text-muted-foreground">
                    {onDay.length}
                  </span>
                )}
              </span>
              {words.slice(0, 2).map((word, i) => (
                <span
                  key={i}
                  className={`mt-0.5 block truncate text-[0.6rem] leading-tight sm:text-[0.65rem] ${
                    onDay[i].tone === "cancelled"
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  }`}
                >
                  {word}
                </span>
              ))}
              {onDay.length > 2 && (
                <span className="block text-[0.6rem] text-muted-foreground">
                  +{onDay.length - 2} more
                </span>
              )}
            </>
          );

          const cell = `block min-h-[3.75rem] p-1 text-left sm:min-h-[4.5rem] ${
            tone ? TONE_CELL[tone] : "bg-card"
          } ${inMonth ? "" : "opacity-40"} ${isToday ? "ring-2 ring-inset ring-primary" : ""}`;
          const style = tone === "dayoff" ? HATCH : undefined;

          return tone && onDayClick ? (
            <button
              type="button"
              key={key}
              title={summary}
              aria-label={summary}
              style={style}
              onClick={() => onDayClick(key)}
              className={`${cell} cursor-pointer transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
            >
              {body}
            </button>
          ) : (
            <div key={key} title={summary} aria-label={summary} style={style} className={cell}>
              {body}
            </div>
          );
        })}
      </div>

      {/* The legend shows the actual cell treatments, and only the ones this
          record uses, so it stays short. */}
      {tonesShown.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {tonesShown.map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span
                style={t === "dayoff" ? HATCH : undefined}
                className={`h-4 w-6 shrink-0 rounded border ${TONE_CELL[t]}`}
              />
              {TONE_LABEL[t]}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
      )}
    </div>
  );
};

export default AttendanceCalendar;
