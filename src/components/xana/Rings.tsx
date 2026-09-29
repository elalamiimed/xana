"use client";

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

/**
 * The ring's sweep, in milliseconds.
 *
 * A literal rather than `var(--t-slow)`: SVG's `animate` element takes
 * `dur` as an XML attribute, not a CSS property, and attributes cannot
 * resolve custom properties. 520ms is the same value `--t-slow` carries at
 * a normal motion setting, which is what matters here — the ring is a
 * readout, and holding it still under reduced motion is correct anyway.
 */
const SWEEP_MS = 520;

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
        strokeDasharray={`${filled} ${circumference}`}
        // Start the arc at twelve o'clock rather than three.
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
      >
        {/* The arc grows into place rather than appearing at full length:
            a ring that snaps to 62% reads as a different ring each time,
            where a ring that travels there reads as a number changing. */}
        <animate
          attributeName="stroke-dasharray"
          from={`0 ${circumference}`}
          to={`${filled} ${circumference}`}
          dur={`${SWEEP_MS}ms`}
          fill="freeze"
        />
      </circle>
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
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-[var(--t-slow)] ease-[var(--ease)]"
        style={{ width: `${percent(value)}%` }}
      />
    </div>
  );
}
