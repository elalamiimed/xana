"use client";

/**
 * Dragging a chip in the month grid: one day to another.
 *
 * The month view has no clock to be precise about, so a drag here is a single
 * question — which cell is under the pointer — and the answer is drawn by
 * highlighting that cell and floating a copy of the chip above the grid. The
 * event keeps its hour: moving "Standup" from Tuesday to Thursday must not also
 * move it from 09:30 to whenever the pointer happened to be.
 *
 * Like the time grid, the copy is a fixed-position node moved by `transform` in
 * a frame loop and nothing re-renders until the drop, and like the time grid it
 * appears on arming rather than on the press. The one thing this does that the
 * time grid does not is hit-test whole cells, because the target here is a box
 * rather than a line.
 */

import { useCallback, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import { dayTitle } from "@/lib/calendar/geometry";

import { beginPointerDrag, swallowNextClick } from "./pointerDrag";

export interface MonthDragOptions {
  /** The element that contains the day cells, used to read their boxes. */
  rootRef: React.RefObject<HTMLElement | null>;
  canEdit: (event: CalendarEvent) => boolean;
  /** Committed on release, with the day the chip was dropped on. */
  onMove: (event: CalendarEvent, dayKey: string) => void;
}

export interface MonthDragPreview {
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

export interface MonthDrag {
  preview: MonthDragPreview | null;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  labelRef: React.RefObject<HTMLSpanElement | null>;
  onChipPointerDown: (event: React.PointerEvent<HTMLElement>, record: CalendarEvent, dayKey: string) => void;
}

export function useMonthDrag(options: MonthDragOptions): MonthDrag {
  const { rootRef, canEdit, onMove } = options;
  const [preview, setPreview] = useState<MonthDragPreview | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const release = useRef<(() => void) | null>(null);
  const marked = useRef<HTMLElement | null>(null);

  const unmark = useCallback(() => {
    if (marked.current) delete marked.current.dataset.drop;
    marked.current = null;
  }, []);

  const stop = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);

  const onChipPointerDown = useCallback(
    (reactEvent: React.PointerEvent<HTMLElement>, record: CalendarEvent, dayKey: string) => {
      // The day cell underneath draws a new entry on a press, so a press on a
      // chip must not also be one — and a feed's chip is still not empty space.
      reactEvent.stopPropagation();
      if (reactEvent.button !== 0 || !canEdit(record)) return;
      const root = rootRef.current;
      if (!root) return;
      // One gesture at a time: a second finger would otherwise overwrite the
      // first gesture's cleanup and leave its chip dimmed for good.
      stop();

      const cells: { key: string; left: number; top: number; right: number; bottom: number }[] = [];
      for (const node of root.querySelectorAll<HTMLElement>("[data-day]")) {
        const key = node.dataset.day;
        if (!key) continue;
        const box = node.getBoundingClientRect();
        cells.push({ key, left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
      if (cells.length === 0) return;

      const node = reactEvent.currentTarget;
      const box = node.getBoundingClientRect();

      let targetDay = dayKey;

      release.current = beginPointerDrag({
        pointerId: reactEvent.pointerId,
        element: node,
        originX: reactEvent.clientX,
        originY: reactEvent.clientY,
        touch: reactEvent.pointerType === "touch",
        onArm: () => {
          node.style.opacity = "0.3";
          setPreview({
            title: record.title,
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            label: dayTitle(dayKey),
          });
        },
        onFrame: (frame) => {
          const hit = cells.find(
            (cell) =>
              frame.clientX >= cell.left &&
              frame.clientX < cell.right &&
              frame.clientY >= cell.top &&
              frame.clientY < cell.bottom,
          );
          if (hit && hit.key !== targetDay) {
            targetDay = hit.key;
            if (labelRef.current) labelRef.current.textContent = dayTitle(targetDay);
          }
          if (ghostRef.current) {
            ghostRef.current.style.transform = `translate3d(${frame.dx}px, ${frame.dy}px, 0)`;
          }
          const cell = hit
            ? root.querySelector<HTMLElement>(`[data-day="${hit.key}"]`)
            : null;
          if (cell !== marked.current) {
            unmark();
            if (cell) {
              cell.dataset.drop = "true";
              marked.current = cell;
            }
          }
        },
        onEnd: (frame) => {
          node.style.opacity = "";
          unmark();
          setPreview(null);
          if (!frame.moved) return; // A press: the chip's own `click` opens it.
          swallowNextClick();
          if (targetDay === dayKey) return;
          onMove(record, targetDay);
        },
        onCancel: () => {
          node.style.opacity = "";
          unmark();
          setPreview(null);
        },
      });
    },
    [canEdit, onMove, rootRef, stop, unmark],
  );

  return { preview, ghostRef, labelRef, onChipPointerDown };
}
