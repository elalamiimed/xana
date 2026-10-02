"use client";

import { useEffect, useState } from "react";

/**
 * The one small visualisation primitive (DESIGN.md §8): no axes, no grids, no
 * legends. A hairline ring or a 3px bar, and a number. Used for goal progress
 * and habit streaks, which are the same shape of fact.
 *
 * The SVG is `role="img"` with a real sentence as its label, so the value is
 * never carried by arc length alone.
 */

const RING_SIZE = 34;
const RING_STROKE = 2;
const TRACK_OPACITY = 0.14;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function percent(value: number): number {
  return Math.round(clamp01(value) * 100);
}

export interface RingProps {
  /** 0..1 */
  value: number;
  /** A full sentence: "Health goal, 40 percent complete". */
  label: string;
}

/** A thin arc. Track is the same hue at low alpha — never a second colour. */
export function Ring({ value, label }: RingProps) {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = clamp01(value) * circumference;
  /**
   * The sweep, as a dash offset.
   *
   * This was SVG `<animate dur="520ms">`, and it was wrong three ways. A
   * `dur` is an XML attribute, so it can never read `var(--t-slow)` and the
   * motion slider never moved it. No `prefers-reduced-motion` rule can reach
   * an `<animate>` element, so the comment beside it claiming the ring was
   * held still under reduced motion was false. And a frozen SMIL animation
   * does not re-run when the value changes, so a ring at 40% that became 70%
   * only redrew on the next remount.
   *
   * `stroke-dashoffset` is a CSS property, so the same 520ms sweep is a
   * transition of `var(--t-slow)`: the motion slider scales it, the
   * reduced-motion block at the foot of globals.css zeroes it to 1ms, and
   * `motion-reduce:transition-none` states that outright rather than
   * implying it. A value change after mount animates too, which is what a
   * readout wants.
   *
   * The element mounts empty and moves to its target on the next frame, so
   * the arc still grows into place rather than appearing at full length.
   */
  const [offset, setOffset] = useState(circumference);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOffset(circumference - filled));
    return () => cancelAnimationFrame(frame);
  }, [circumference, filled]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="shrink-0"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeOpacity={TRACK_OPACITY}
        strokeWidth={RING_STROKE}
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        // A dash as long as the whole circle: at offset 0 every pixel of the
        // path is drawn, and an offset of `C - filled` draws exactly `filled`.
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={offset}
        className="motion-reduce:transition-none"
        style={{ transition: "stroke-dashoffset var(--t-slow) var(--ease)" }}
        // Start the arc at twelve o'clock rather than three.
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
      />
    </svg>
  );
}

export interface BarProps {
  /** 0..1 */
  value: number;
  /** A full sentence: "Meditation, 3 of 5 this week". */
  label: string;
}

/** A 3px bar. The only other shape the design allows. */
export function Bar({ value, label }: BarProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className="h-[3px] w-full overflow-hidden rounded-full bg-accent/14"
    >
      {/* The fill grows on `scaleX`, not on `width`.
       *
       * Both draw the same picture, and only one of them is composited: an
       * animated `width` re-runs layout on every frame of a 520ms sweep, while
       * a transform runs on the compositor. The rounding survives because the
       * bar is 3px tall — a 2px cap squashed horizontally is not a shape
       * anyone can see. */}
      <div
        className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-[var(--t-slow)] ease-[var(--ease)]"
        style={{ transform: `scaleX(${percent(value) / 100})` }}
      />
    </div>
  );
}
