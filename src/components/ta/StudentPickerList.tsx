import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Pick one student out of a roster.
 *
 * WHY THIS EXISTS
 *
 * Remove-a-student and excuse-an-absence had grown the same list twice, each
 * with its own copy of the search, its own filter written inline in the JSX
 * (the excused one computed it twice per render, once to ask whether it was
 * empty and again to draw it), and its own idea of what a row looks like. Two
 * copies of a list is two places to fix anything, and they had already drifted
 * from the roster on Analytics — which is the list people actually use, and
 * the one they said the others should behave like.
 *
 * WHAT "BEHAVE LIKE THE ANALYTICS LIST" MEANS HERE
 *
 * The name first, the ID underneath. A TA looking somebody up has a name in
 * their head, not an ID; the ID is what they check once they have found the
 * row. The ID stays visible because it is what gets typed into everything
 * else. Searching matches either, in any case — a name read off a screen and
 * an ID read off a card are the same question.
 *
 * Rows are reachable from the keyboard and say what they do, because on this
 * list "activate" can mean "remove this person".
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No attendance rate and no click-through to the record. This list is for
 * choosing somebody, and the dialogs it sits in are about to do something to
 * that choice; a second thing a click might mean is how the wrong student gets
 * removed. The Analytics roster opens records because that is all it does.
 */
export interface PickableStudent {
  student_id: string;
  cohort: string;
  name?: string | null;
}

const StudentPickerList = ({
  students,
  selectedId,
  onSelect,
  label = "Search student",
  placeholder = "Search by name or student ID…",
  emptyText = "No students found.",
  tone = "primary",
  className,
}: {
  students: PickableStudent[];
  selectedId?: string | null;
  onSelect: (student: PickableStudent) => void;
  label?: string;
  placeholder?: string;
  emptyText?: string;
  /** Destructive where activating a row leads somewhere destructive. */
  tone?: "primary" | "destructive";
  className?: string;
}) => {
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) =>
        s.student_id.toLowerCase().includes(q) ||
        (s.name ?? "").toLowerCase().includes(q),
    );
  }, [students, query]);

  return (
    <div className="space-y-2">
      <div className="space-y-2">
        <Label htmlFor="student-picker-search" className="text-sm font-medium">
          {label}
        </Label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="student-picker-search"
            className="pl-8"
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className={cn("max-h-48 space-y-2 overflow-y-auto", className)}>
        {shown.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            {students.length === 0 ? "Nobody is on this roster yet." : emptyText}
          </p>
        ) : (
          shown.map((student) => {
            const isSelected = selectedId === student.student_id;
            const pick = () => onSelect(student);
            return (
              <div
                key={student.student_id}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`Choose ${student.name || student.student_id}`}
                onClick={pick}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick();
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected
                    ? tone === "destructive"
                      ? "border-destructive/40 bg-destructive/10"
                      : "border-primary/40 bg-primary/10"
                    : "border-transparent bg-muted/50 hover:bg-muted",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {student.name || student.student_id}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {student.cohort}
                    </Badge>
                  </div>
                  {/* Only when the name is above it — otherwise this line
                      would repeat the ID back at itself. */}
                  {student.name && (
                    <span className="text-sm text-muted-foreground">
                      {student.student_id}
                    </span>
                  )}
                </div>

                {isSelected && (
                  <Badge
                    variant={tone === "destructive" ? "destructive" : "default"}
                    className="shrink-0 text-xs"
                  >
                    Selected
                  </Badge>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default StudentPickerList;
