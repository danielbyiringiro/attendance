// What a student sees while the app is paused (055).
//
// In place of the check-in box, not beside it. A form that is present but
// cannot work invites twenty attempts and a queue at the front of the room;
// the honest thing is to say there is nothing to type yet.
//
// Their history stays reachable underneath: reading a record changes nothing,
// and a pause is not a reason to hide somebody's own attendance from them.

import { PauseCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const PausedNotice = ({
  message,
  endsAt,
}: {
  message: string | null;
  endsAt?: string | null;
}) => (
  <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-4">
    <Card className="w-full max-w-md border-2">
      <CardContent className="space-y-3 pt-6 text-center">
        <PauseCircle className="mx-auto h-10 w-10 text-warning" aria-hidden />
        <h1 className="text-xl font-semibold">Check-in is paused</h1>
        <p className="text-sm text-muted-foreground">
          {message ??
            "Attendance is paused for maintenance. Nothing you do now would be recorded, so there is nothing to type yet."}
        </p>
        {endsAt && (
          <p className="text-sm">
            Expected back by <span className="font-medium">{time(endsAt)}</span>.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          This page checks again every minute. If your class is being held now,
          tell your TA — they can mark you once it is back.
        </p>
      </CardContent>
    </Card>
  </div>
);

export default PausedNotice;
