// Picking a session up on the month calendar and putting it down on another day.
//
// Three ways in, because each fails for somebody:
//
//   - the browser's own drag, for a mouse. It is what people expect on a
//     desktop and the browser draws the thing being dragged.
//   - pointer events, for touch. The browser's drag does not fire for a finger
//     at all, so without this a phone could not move anything.
//   - tap the grip, then tap a day. For a trackpad that fumbles a drag, for a
//     screen reader, and for anywhere the other two are swallowed — the
//     prototype's drag never worked in the artifact viewer, and a gesture you
//     cannot perform is not a feature.
//
// They all end in the same place: onDrop(sessionId, date), and the calendar
// asks what the drop means. This file knows nothing about sessions beyond an
// id, and nothing about what a move does.
//
// Cells are found by a `data-date` attribute and draggable chips by
// `data-session-id`; the grip inside a chip by `data-grip`.

import { useCallback, useEffect, useRef, useState } from "react";

/** How far a finger must travel before a press becomes a drag. */
const SLOP_PX = 6;

export interface SessionDrag {
  /** The session being carried by tap, or null. Draw it highlighted. */
  carrying: string | null;
  /** The date a drag or a carry is hovering, or null. Draw it as a target. */
  overDate: string | null;
  /** Put down whatever is being carried, without moving it. */
  cancel: () => void;
  /** Spread on the grid that holds the cells. */
  gridProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
}

const dateUnder = (el: Element | null): string | null => {
  const cell = el?.closest<HTMLElement>("[data-date]");
  return cell?.dataset.date ?? null;
};

export const useSessionDrag = (
  onDrop: (sessionId: string, date: string) => void,
  enabled = true,
): SessionDrag => {
  const [carrying, setCarrying] = useState<string | null>(null);
  const [overDate, setOverDate] = useState<string | null>(null);

  // The press that may become a touch drag. A ref, because pointermove fires
  // far too often to route through state.
  const press = useRef<{
    id: string;
    from: string | null;
    x: number;
    y: number;
    onGrip: boolean;
    dragging: boolean;
    pointerId: number;
  } | null>(null);
  // A drag that just ended fires a click on whatever it ended over. That click
  // must not also open the day, or every drop opens two dialogs.
  const swallowClick = useRef(false);
  const nativeId = useRef<string | null>(null);

  const cancel = useCallback(() => {
    setCarrying(null);
    setOverDate(null);
    press.current = null;
    nativeId.current = null;
  }, []);

  // Escape puts a carried session down.
  useEffect(() => {
    if (!carrying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carrying, cancel]);

  // Touch drags are followed on the window, so a finger leaving the grid does
  // not strand the gesture half-finished.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (!p.dragging) {
        if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < SLOP_PX) return;
        p.dragging = true;
      }
      setOverDate(dateUnder(document.elementFromPoint(e.clientX, e.clientY)));
    };
    const up = (e: PointerEvent) => {
      const p = press.current;
      if (!p || e.pointerId !== p.pointerId) return;
      press.current = null;

      if (p.dragging) {
        const date = dateUnder(document.elementFromPoint(e.clientX, e.clientY));
        setOverDate(null);
        swallowClick.current = true;
        if (date && date !== p.from) onDrop(p.id, date);
        return;
      }
      // A tap on the grip picks the session up; a second tap on it puts it
      // back. A tap anywhere else on the chip falls through to the cell and
      // opens the day, as it always did.
      if (p.onGrip) {
        swallowClick.current = true;
        setCarrying((c) => (c === p.id ? null : p.id));
      }
    };
    const abort = () => {
      press.current = null;
      setOverDate(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
    };
  }, [onDrop]);

  const idUnder = (el: Element | null) =>
    el?.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? null;

  const gridProps: SessionDrag["gridProps"] = {
    onPointerDown: (e) => {
      if (!enabled) return;
      // A mouse uses the browser's drag below; this path is for touch and pen,
      // and for a mouse tap on the grip.
      const target = e.target as Element;
      const id = idUnder(target);
      if (!id) return;
      const onGrip = !!target.closest("[data-grip]");
      if (e.pointerType === "mouse" && !onGrip) return;
      press.current = {
        id,
        from: dateUnder(target),
        x: e.clientX,
        y: e.clientY,
        onGrip,
        dragging: false,
        pointerId: e.pointerId,
      };
    },

    onDragStart: (e) => {
      const id = enabled ? idUnder(e.target as Element) : null;
      if (!id) {
        e.preventDefault();
        return;
      }
      // One gesture, one set of state: the pointer path stands down.
      press.current = null;
      nativeId.current = id;
      setCarrying(null);
      try {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
      } catch {
        // Some browsers are strict about when this may be set. The id is
        // already held in nativeId, which is what the drop reads.
      }
    },

    onDragOver: (e) => {
      if (!nativeId.current) return;
      const date = dateUnder(e.target as Element);
      if (!date) return;
      // Without this the browser refuses the drop.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverDate(date);
    },

    onDragLeave: (e) => {
      if (!nativeId.current) return;
      // Leaving the grid entirely clears the target; moving between cells does
      // not, or the highlight would flicker on every border.
      const next = e.relatedTarget as Element | null;
      if (!next || !next.closest?.("[data-date]")) setOverDate(null);
    },

    onDrop: (e) => {
      const id = nativeId.current;
      nativeId.current = null;
      setOverDate(null);
      if (!id) return;
      e.preventDefault();
      swallowClick.current = true;
      const date = dateUnder(e.target as Element);
      const from = document
        .querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)
        ?.closest<HTMLElement>("[data-date]")?.dataset.date;
      if (date && date !== from) onDrop(id, date);
    },

    onDragEnd: () => {
      nativeId.current = null;
      setOverDate(null);
    },

    // Capture phase, so it runs before the cell's own click opens the day.
    onClickCapture: (e) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // Carrying: this click is the drop.
      if (carrying) {
        const date = dateUnder(e.target as Element);
        if (!date) return;
        e.stopPropagation();
        e.preventDefault();
        const id = carrying;
        setCarrying(null);
        const from = document
          .querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)
          ?.closest<HTMLElement>("[data-date]")?.dataset.date;
        if (date !== from) onDrop(id, date);
      }
    },
  };

  return { carrying, overDate, cancel, gridProps };
};
