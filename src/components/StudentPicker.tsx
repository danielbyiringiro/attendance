import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SummaryRow } from "@/lib/attendanceExport";

interface StudentPickerProps {
  students: SummaryRow[];
  value: string | null;
  onChange: (studentId: string | null) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Type-to-search student picker. A roster of a few hundred is unusable as a
 * plain dropdown, and the TA usually knows the name or ID they are looking for.
 */
const StudentPicker = ({
  students,
  value,
  onChange,
  placeholder = "Leave blank",
  className,
}: StudentPickerProps) => {
  const [open, setOpen] = useState(false);
  const selected = students.find((s) => s.student_id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("justify-between font-normal", className)}
        >
          <span className="truncate">
            {selected
              ? `${selected.name || selected.student_id} · ${selected.student_id}`
              : placeholder}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {selected && (
              <X
                className="h-3.5 w-3.5 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  // Clear without opening the list.
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            )}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command
          // Search both the name and the ID, so either works.
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search name or ID…" />
          <CommandList>
            <CommandEmpty>No student matches.</CommandEmpty>
            <CommandGroup>
              {students.map((s) => (
                <CommandItem
                  key={s.student_id}
                  value={`${s.name} ${s.student_id} ${s.cohort}`}
                  onSelect={() => {
                    onChange(s.student_id === value ? null : s.student_id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      s.student_id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">
                    {s.name || "(no name)"}
                    <span className="text-muted-foreground">
                      {" · "}
                      {s.student_id} · {s.cohort}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

export default StudentPicker;
