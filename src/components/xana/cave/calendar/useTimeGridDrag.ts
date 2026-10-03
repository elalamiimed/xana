"use client";

/**
 * Dragging in the time grid: move a block, resize it, or draw a new one.
 *
 * WHAT THIS OWNS
 *
 * The whole gesture: which columns exist, where the pointer is in minutes, what
 * the drop would mean, and every pixel written while it happens. What it does
 * not own is what a drop *does* — the room hands in `onMove` / `onResize` /
 * `onCreate` and this file never talks to the server, which is what lets the
 * whole interaction be reasoned about without a database.
 *
 * HOW A FRAME IS SPENT
 *
 * One `requestAnimationFrame` per frame, and inside it, in this order: read the
 * scroller's `scrollTop`, autoscroll if the pointer is near an edge, turn the
 * pointer into a day and a minute, snap, then write transforms. Reads before
 * writes, always: the browser lays the page out once per frame instead of once
 * per statement, which is the difference between a solid 60 and a drag that
 * stutters whenever the machine is busy.
 *
 * The one thing React does during a drag is render the ghost and the drop
 * indicator, once, when the gesture arms. Everything after that is a
 * `style.transform` and a `textContent` on nodes React is not re-rendering.
 *
 * WHEN A PREVIEW APPEARS
 *
 * Once the gesture arms, and not before — `onArm`, never `pointerdown`. A finger
 * that rests on the grid for a moment has not drawn anything yet, and a dashed
 * slot that appears under a touch that turns out to be a scroll is the calendar
 * claiming an intention nobody had. It also means there is nothing to take down
 * on the paths where the gesture never arms, which is what made a tap leave a
 * lit slot behind for the rest of the session.
 *
 * Nothing here draws outside `onArm` and nothing removes outside `onEnd` /
 * `onCancel`; the engine guarantees exactly one of those two runs.
 */

import { useCallback, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import {
  blockMinutes,
  columnAt,
  dayLength,
  dragLabel,
  dropMinutes,
  eventsForDay,
  formatClock,
  minutesAt,
  snap,
  DEFAULT_MINUTES,
  SLOT_MINUTES,
  type ColumnBox,
} from "@/lib/calendar/geometry";

import { beginPointerDrag, swallowNextClick, type DragFrame } from "./pointerDrag";

export interface TimeGridDragOptions {
  /** The element that scrolls vertically. Also the frame the grid is measured in. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Day columns, in order, matching the `data-column` attributes in the grid. */
  columns: readonly string[];
  hourHeight: number;
  /** Whether this record may be changed at all. A synced feed is not ours. */
  canEdit: (event: CalendarEvent) => boolean;
  onMove: (event: CalendarEvent, dayKey: string, startMin: number) => void;
  onResize: (event: CalendarEvent, dayKey: string, startMin: number, minutes: number) => void;
  onCreate: (dayKey: string, startMin: number, minutes: number) => void;
}

export interface TimeDragPreview {
  kind: "move" | "resize-start" | "resize-end" | "create";
  title: string;
  /** Where the floating copy starts, in viewport pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The line the ghost carries: the range it is about to land on. */
  label: string;
  /** False for a create drag, where the selection itself is the preview. */
  ghost: boolean;
}

/** Pixels from the top or bottom of the scroller where autoscroll begins. */
const EDGE = 64;
/** The fastest autoscroll, in pixels per frame. */
const EDGE_SPEED = 16;

export interface TimeGridDrag {
  preview: TimeDragPreview | null;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  labelRef: React.RefObject<HTMLSpanElement | null>;
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  /** True while the drop indicator should be on screen. */
  showIndicator: boolean;
  /** Press on a block: move it. A press that does not travel is left to `click`. */
  onBlockPointerDown: (event: React.PointerEvent<HTMLElement>, record: CalendarEvent, dayKey: string) => void;
  /** Press on a block's top or bottom edge: change when it starts or ends. */
  onHandlePointerDown: (
    event: React.PointerEvent<HTMLElement>,
    record: CalendarEvent,
    dayKey: string,
    edge: "start" | "end",
  ) => void;
  /** Press on empty grid: draw a new block. */
  onSurfacePointerDown: (event: React.PointerEvent<HTMLElement>, dayKey: string) => void;
  /**
   * Click on empty grid: put an entry there.
   *
   * This is the tap's own path. A finger that lifts inside the hold window never
   * armed, so the pointer engine reports a cancel and no creation happens from
   * it — the `click` that follows is the whole meaning of that gesture, and it
   * lands here. A mouse produces this too, but its `pointerdown` armed at once
   * and the drag has already swallowed the click, so nothing is created twice.
   */
  onSurfaceClick: (event: React.MouseEvent<HTMLElement>, dayKey: string) => void;
}

export function useTimeGridDrag(options: TimeGridDragOptions): TimeGridDrag {
  const { scrollRef, columns, hourHeight, canEdit, onMove, onResize, onCreate } = options;

  const [preview, setPreview] = useState<TimeDragPreview | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  /** The geometry React last drew a resized block with, so it can be handed back. */
  const liveRef = useRef<{ node: HTMLElement; top: number; height: number } | null>(null);
  const release = useRef<(() => void) | null>(null);

  /** Every column's pixel extent and every day's length, read once per gesture. */
  const measure = useCallback((): { boxes: ColumnBox[]; lengths: Map<string, number> } => {
    const grid = scrollRef.current;
    const boxes: ColumnBox[] = [];
    if (grid) {
      for (const node of grid.querySelectorAll<HTMLElement>("[data-column]")) {
        const key = node.dataset.column;
        if (!key) continue;
        const box = node.getBoundingClientRect();
        boxes.push({ key, left: box.left, width: box.width });
      }
    }
    const lengths = new Map<string, number>();
    for (const key of columns) lengths.set(key, dayLength(key));
    return { boxes, lengths };
  }, [columns, scrollRef]);

  const stop = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);

  /** Hand a block back to React at the geometry it was drawn with. */
  const releaseLive = useCallback(() => {
    const live = liveRef.current;
    if (!live) return;
    live.node.style.top = `${live.top}px`;
    live.node.style.height = `${live.height}px`;
    liveRef.current = null;
  }, []);

  const onBlockPointerDown = useCallback(
    (reactEvent: React.PointerEvent<HTMLElement>, record: CalendarEvent, dayKey: string) => {
      // The column underneath draws a new block on a press, so a press on a block
      // must not also be one. Stopped before the ownership test: a synced entry is
      // still not empty space.
      reactEvent.stopPropagation();
      if (reactEvent.button !== 0 || !canEdit(record)) return;
      const grid = scrollRef.current;
      if (!grid) return;
      // One gesture at a time. A second finger on a second block would otherwise
      // overwrite the first gesture's cleanup, leaving its listeners attached and
      // its block dimmed for the rest of the session.
      stop();

      const placed = eventsForDay([record], dayKey)[0];
      if (!placed) return;
      const node = reactEvent.currentTarget;
      const blockRect = node.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const { boxes, lengths } = measure();
      const durationMin = blockMinutes(placed);
      const anchorMin = placed.startMin;

      // Where inside the block the pointer took hold, so the block does not jump
      // to meet the pointer the moment it moves.
      const grab = Math.min(
        Math.max(minutesAt(reactEvent.clientY, gridRect.top, grid.scrollTop, hourHeight) - anchorMin, 0),
        durationMin,
      );

      let targetDay = dayKey;
      let targetStart = anchorMin;

      release.current = beginPointerDrag({
        pointerId: reactEvent.pointerId,
        element: node,
        originX: reactEvent.clientX,
        originY: reactEvent.clientY,
        touch: reactEvent.pointerType === "touch",
        onArm: () => {
          node.style.opacity = "0.35";
          setPreview({
            kind: "move",
            title: record.title,
            left: blockRect.left,
            top: blockRect.top,
            width: blockRect.width,
            height: blockRect.height,
            label: dragLabel(dayKey, anchorMin, durationMin),
            ghost: true,
          });
        },
        onFrame: (frame) => {
          autoscroll(grid, frame.clientY);
          const top = grid.getBoundingClientRect().top;
          targetDay = columnAt(frame.clientX, boxes) ?? dayKey;
          const raw = minutesAt(frame.clientY, top, grid.scrollTop, hourHeight);
          targetStart = dropMinutes(raw, grab, durationMin, lengths.get(targetDay) ?? 24 * 60);

          if (ghostRef.current) {
            ghostRef.current.style.transform = `translate3d(${frame.dx}px, ${frame.dy}px, 0)`;
          }
          if (labelRef.current) {
            labelRef.current.textContent = dragLabel(targetDay, targetStart, durationMin);
          }
          paintIndicator(
            indicatorRef.current,
            boxes,
            gridRect.left,
            grid.scrollLeft,
            targetDay,
            targetStart,
            durationMin,
            hourHeight,
          );
        },
        onEnd: (frame) => {
          node.style.opacity = "";
          setPreview(null);
          if (!frame.moved) return; // A press: the block's own `click` opens it.
          swallowNextClick();
          if (targetDay === dayKey && targetStart === anchorMin) return;
          onMove(record, targetDay, targetStart);
        },
        onCancel: () => {
          node.style.opacity = "";
          setPreview(null);
        },
      });
    },
    [canEdit, hourHeight, measure, onMove, scrollRef],
  );

  const onHandlePointerDown = useCallback(
    (
      reactEvent: React.PointerEvent<HTMLElement>,
      record: CalendarEvent,
      dayKey: string,
      edge: "start" | "end",
    ) => {
      reactEvent.stopPropagation();
      if (reactEvent.button !== 0 || !canEdit(record)) return;
      const grid = scrollRef.current;
      if (!grid) return;
      stop();

      const placed = eventsForDay([record], dayKey)[0];
      if (!placed) return;

      const node = reactEvent.currentTarget.parentElement ?? reactEvent.currentTarget;
      const gridRect = grid.getBoundingClientRect();
      const { lengths } = measure();
      const anchorStart = placed.startMin;
      const anchorLength = blockMinutes(placed);
      const anchorEnd = anchorStart + anchorLength;
      const dayMinutes = lengths.get(dayKey) ?? 24 * 60;

      liveRef.current = {
        node,
        top: (anchorStart / 60) * hourHeight,
        height: (anchorLength / 60) * hourHeight,
      };

      let start = anchorStart;
      let length = anchorLength;

      release.current = beginPointerDrag({
        pointerId: reactEvent.pointerId,
        element: reactEvent.currentTarget,
        originX: reactEvent.clientX,
        originY: reactEvent.clientY,
        touch: reactEvent.pointerType === "touch",
        // No indicator: the block itself is the preview, under the pointer. The
        // state is still set on arming rather than on press, so the one rule
        // holds everywhere — a preview exists only while a gesture is armed.
        onArm: () =>
          setPreview({
            kind: edge === "start" ? "resize-start" : "resize-end",
            title: record.title,
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            label: "",
            ghost: false,
          }),
        onFrame: (frame) => {
          autoscroll(grid, frame.clientY);
          const raw = snap(minutesAt(frame.clientY, gridRect.top, grid.scrollTop, hourHeight));
          if (edge === "end") {
            const wanted = Math.max(raw, anchorStart + SLOT_MINUTES);
            length = Math.min(Math.max(wanted - anchorStart, SLOT_MINUTES), dayMinutes - anchorStart);
            start = anchorStart;
          } else {
            start = Math.min(Math.max(raw, 0), anchorEnd - SLOT_MINUTES);
            length = anchorEnd - start;
          }
          node.style.top = `${(start / 60) * hourHeight}px`;
          node.style.height = `${Math.max((length / 60) * hourHeight, (SLOT_MINUTES / 60) * hourHeight)}px`;
          if (labelRef.current) labelRef.current.textContent = dragLabel(dayKey, start, length);
        },
        onEnd: (frame) => {
          releaseLive();
          setPreview(null);
          if (!frame.moved) return;
          swallowNextClick();
          if (start === anchorStart && length === anchorLength) return;
          onResize(record, dayKey, start, length);
        },
        onCancel: () => {
          releaseLive();
          setPreview(null);
        },
      });
    },
    [canEdit, hourHeight, measure, onResize, releaseLive, scrollRef],
  );

  const onSurfacePointerDown = useCallback(
    (reactEvent: React.PointerEvent<HTMLElement>, dayKey: string) => {
      if (reactEvent.button !== 0) return;
      const grid = scrollRef.current;
      if (!grid) return;
      stop();
      const gridRect = grid.getBoundingClientRect();
      const { boxes, lengths } = measure();
      const dayMinutes = lengths.get(dayKey) ?? 24 * 60;
      const anchorMin = Math.min(
        Math.max(snap(minutesAt(reactEvent.clientY, gridRect.top, grid.scrollTop, hourHeight)), 0),
        dayMinutes - SLOT_MINUTES,
      );

      let start = anchorMin;
      let length = SLOT_MINUTES;
      let targetDay = dayKey;

      release.current = beginPointerDrag({
        pointerId: reactEvent.pointerId,
        element: reactEvent.currentTarget,
        originX: reactEvent.clientX,
        originY: reactEvent.clientY,
        touch: reactEvent.pointerType === "touch",
        onArm: () =>
          setPreview({
            kind: "create",
            title: "",
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            label: dragLabel(dayKey, anchorMin, DEFAULT_MINUTES),
            ghost: false,
          }),
        onFrame: (frame) => {
          autoscroll(grid, frame.clientY);
          targetDay = columnAt(frame.clientX, boxes) ?? dayKey;
          const current = snap(minutesAt(frame.clientY, gridRect.top, grid.scrollTop, hourHeight));
          // Dragging up extends the block upward rather than growing it from the
          // wrong end: "from the anchor to the pointer", in either direction.
          const low = Math.min(anchorMin, current);
          const high = Math.max(anchorMin, current);
          start = Math.min(Math.max(low, 0), dayMinutes - SLOT_MINUTES);
          length = Math.max(high - low, SLOT_MINUTES);
          if (labelRef.current) labelRef.current.textContent = dragLabel(targetDay, start, length);
          paintIndicator(
            indicatorRef.current,
            boxes,
            gridRect.left,
            grid.scrollLeft,
            targetDay,
            start,
            length,
            hourHeight,
          );
        },
        onEnd: (frame) => {
          setPreview(null);
          swallowNextClick();
          // A press that never moved is still an intention — "put something
          // here" — and an hour is what a calendar means by it. A drag means
          // exactly the block that was drawn, down to the quarter hour.
          if (!frame.moved) onCreate(targetDay, anchorMin, DEFAULT_MINUTES);
          else onCreate(targetDay, start, length);
        },
        onCancel: () => setPreview(null),
      });
    },
    [hourHeight, measure, onCreate, scrollRef],
  );

  const onSurfaceClick = useCallback(
    (reactEvent: React.MouseEvent<HTMLElement>, dayKey: string) => {
      const grid = scrollRef.current;
      if (!grid) return;
      const gridRect = grid.getBoundingClientRect();
      const { lengths } = measure();
      const dayMinutes = lengths.get(dayKey) ?? 24 * 60;
      // The same snap the drag uses, so a tap and a small drag into the same
      // pixel produce the same entry rather than two different ones.
      const at = Math.min(
        Math.max(snap(minutesAt(reactEvent.clientY, gridRect.top, grid.scrollTop, hourHeight)), 0),
        dayMinutes - SLOT_MINUTES,
      );
      onCreate(dayKey, at, DEFAULT_MINUTES);
    },
    [hourHeight, measure, onCreate, scrollRef],
  );

  return {
    preview,
    ghostRef,
    labelRef,
    indicatorRef,
    showIndicator: preview !== null && preview.kind !== "resize-start" && preview.kind !== "resize-end",
    onBlockPointerDown,
    onHandlePointerDown,
    onSurfacePointerDown,
    onSurfaceClick,
  };
}

/** Scroll the grid when the pointer is held near its top or bottom edge. */
function autoscroll(grid: HTMLElement, clientY: number): void {
  const box = grid.getBoundingClientRect();
  const fromTop = clientY - box.top;
  const fromBottom = box.bottom - clientY;
  if (fromTop < EDGE) {
    const ramp = (EDGE - Math.max(fromTop, 0)) / EDGE;
    grid.scrollTop -= Math.ceil(EDGE_SPEED * ramp);
  } else if (fromBottom < EDGE) {
    const ramp = (EDGE - Math.max(fromBottom, 0)) / EDGE;
    grid.scrollTop += Math.ceil(EDGE_SPEED * ramp);
  }
}

/**
 * Draw the block a drop would create.
 *
 * Positioned inside the scrolled content, so the y is a plain content offset and
 * the vertical scroll needs no arithmetic; only the horizontal one does, and it
 * is read from the scroller rather than measured, so no frame forces a layout.
 * Written as a transform rather than as `top`/`left`, so the browser composites
 * it instead of laying the grid out again on every frame.
 */
function paintIndicator(
  node: HTMLElement | null,
  boxes: readonly ColumnBox[],
  gridLeft: number,
  scrollLeft: number,
  dayKey: string,
  startMin: number,
  durationMin: number,
  hourHeight: number,
): void {
  if (!node) return;
  const box = boxes.find((candidate) => candidate.key === dayKey);
  if (!box) {
    node.style.opacity = "0";
    return;
  }
  // Only what changed is written. The width and height move only when the drop
  // changes column or length, and the two data attributes change even less; the
  // transform is the one thing that is genuinely different every frame. Writing
  // all five each frame dirties layout and attributes for nothing, which showed
  // up as style-recalc work during a drag in the browser measurement.
  const width = `${box.width}px`;
  if (node.style.width !== width) node.style.width = width;
  const height = `${Math.max((durationMin / 60) * hourHeight, (SLOT_MINUTES / 60) * hourHeight)}px`;
  if (node.style.height !== height) node.style.height = height;
  node.style.opacity = "1";
  node.style.transform = `translate3d(${box.left - gridLeft + scrollLeft}px, ${(startMin / 60) * hourHeight}px, 0)`;
  if (node.dataset.day !== dayKey) node.dataset.day = dayKey;
  const range = `${formatClock(startMin)}–${formatClock(startMin + durationMin)}`;
  if (node.dataset.range !== range) node.dataset.range = range;
}

export type { DragFrame };
