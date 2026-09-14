import { useEffect, useRef } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { isStudentCheckIn, type RecordChange } from "@/lib/checkInSound";

/**
 * Re-read when somebody else changes something.
 *
 * The TA dashboard fetched once on mount. During a class that is the one time
 * it is guaranteed to be wrong: students are checking in while the TA watches a
 * count that stopped moving when the page loaded. The only signal that a
 * refresh was needed was pressing refresh.
 *
 * Two mechanisms, on purpose.
 *
 * REALTIME is the one that makes it feel live. Migration 030 puts
 * attendance_records and class_sessions in the supabase_realtime publication;
 * without that the channel connects, reports SUBSCRIBED, and no event ever
 * arrives. Row-level security applies to the stream, so a TA is told only about
 * rows they could already read.
 *
 * POLLING is the backstop, and it is not redundancy for its own sake. A
 * WebSocket dies quietly: a laptop lid closes, a phone changes network, a proxy
 * times out an idle socket. The client reconnects, but events that happened
 * while it was gone are simply not replayed — realtime is a stream, not a
 * queue. A slow poll bounds how long a missed event can go unnoticed. It only
 * runs while `active` is true, which the dashboard sets when a session is
 * actually live, so an idle tab costs nothing.
 *
 * Both call the same reload. Duplicate work is a wasted query; a missed event
 * is a TA telling a student they were not marked when they were.
 *
 * `onCheckIn` hears each student check-in as it arrives, for the beep. Realtime
 * only: a check-in the poll catches after a dropped socket is counted on screen
 * but not beeped for, which is the right way round — a burst of stale beeps
 * minutes late would be worse than none.
 */
export const useLiveClass = (
  classId: string | null,
  reload: () => void | Promise<void>,
  opts: {
    active?: boolean;
    pollMs?: number;
    onCheckIn?: (change: RecordChange) => void;
  } = {},
) => {
  const { active = false, pollMs = 20_000, onCheckIn } = opts;

  // Kept in refs so a re-created callback does not tear down the subscription
  // and build a new one on every render. The channel outlives the closure.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const onCheckInRef = useRef(onCheckIn);
  onCheckInRef.current = onCheckIn;

  useEffect(() => {
    if (!classId) return;

    const fire = () => void reloadRef.current();

    const onRecord = (
      payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
    ) => {
      fire();
      const change = payload as unknown as RecordChange;
      if (onCheckInRef.current && isStudentCheckIn(change)) {
        onCheckInRef.current(change);
      }
    };

    const channel = supabase
      .channel(`class:${classId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "attendance_records",
          filter: `class_id=eq.${classId}`,
        },
        onRecord,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "class_sessions",
          filter: `class_id=eq.${classId}`,
        },
        fire,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [classId]);

  useEffect(() => {
    if (!classId || !active) return;

    const id = setInterval(() => void reloadRef.current(), pollMs);

    // A tab that was in the background may have missed events entirely, and
    // coming back to a stale screen is exactly when the number is looked at.
    const onVisible = () => {
      if (document.visibilityState === "visible") void reloadRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [classId, active, pollMs]);
};
