/**
 * Small 3D maths for the orb, plus the two easing functions the renderer
 * leans on for every state change.
 *
 * Why hand-rolled rather than three.js: the orb is one object, on one
 * canvas, with a fixed camera. A full 3D engine would add ~600 KB to a
 * local-first assistant that must work with no network and no build
 * step, to draw a few hundred line segments. This file is 200 lines and
 * has no failure modes beyond "the maths is wrong", which the unit
 * checks in scripts/demo.ts cover.
 *
 * Conventions, everywhere, without exception:
 *   - Right-handed, Y up, camera looking down -Z.
 *   - A vertex is a plain `[x, y, z]` tuple. No classes: these are
 *     allocated once per frame at most and then discarded.
 *   - Rotations compose X (pitch), then Y (yaw), then Z (roll).
 */

export type Vec3 = readonly [number, number, number];

/** A point in camera space: millimetres in front of the lens. */
export interface CameraPoint {
  x: number;
  y: number;
  z: number;
}

/** Scratch object so `project` can be allocation-free on the hot path. */
export interface Projected {
  /** Screen x, in CSS pixels. */
  x: number;
  /** Screen y, in CSS pixels. */
  y: number;
  /** 0 = far, 1 = near. Drives size and alpha. */
  depth: number;
  /** 1 for units inside the perspective window, 0 for anything behind. */
  visible: number;
}

/* ------------------------------------------------------------------ */
/* Scalars                                                            */
/* ------------------------------------------------------------------ */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate-independent exponential smoothing.
 *
 * A plain `a += (b - a) * 0.1` runs twice as fast at 120 Hz as at 60 Hz,
 * so every eased value in the orb would move at a different speed on a
 * different display — the exact thing that makes hand-rolled animation
 * feel wrong. This is the standard fix: the per-frame coefficient is
 * derived from the elapsed time, so a given `halfLifeMs` behaves the
 * same at any refresh rate.
 *
 * `halfLifeMs` is the time to close half the remaining distance.
 */
export function smooth(
  current: number,
  target: number,
  halfLifeMs: number,
  dtMs: number,
): number {
  if (halfLifeMs <= 0) return target;
  const t = 1 - Math.pow(2, -dtMs / halfLifeMs);
  return current + (target - current) * t;
}

/** Angular smoothing. Linear interpolation is correct here because the
 *  orb's angles never wrap far enough in one frame to take the long way
 *  round, and `clamp` keeps a tab-switch from jumping more than a full turn. */
export function smoothAngle(
  current: number,
  target: number,
  halfLifeMs: number,
  dtMs: number,
): number {
  const delta = clamp(target - current, -Math.PI, Math.PI);
  if (halfLifeMs <= 0) return current + delta;
  const t = 1 - Math.pow(2, -dtMs / halfLifeMs);
  return current + delta * t;
}

/* ------------------------------------------------------------------ */
/* Vectors                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rotate about X. Returns a new tuple rather than mutating: the callers
 * are render loops where an accidental shared mutation is the worst kind
 * of bug to find, and the allocation is one small array per vertex.
 */
export function rotateX(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

export function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

export function rotateZ(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** Rotate the whole space by yaw about Y, then pitch about X, then roll
 *  about Z — the single call the renderer makes per vertex. */
export function orient(v: Vec3, pitch: number, yaw: number, roll: number): Vec3 {
  let p = v;
  if (yaw !== 0) p = rotateY(p, yaw);
  if (pitch !== 0) p = rotateX(p, pitch);
  if (roll !== 0) p = rotateZ(p, roll);
  return p;
}

/** A point on a circle of `radius`, at `angle`, tilted about X by `tilt`
 *  and about Z by `tiltZ`. Used for the orbital rings and the ripple. */
export function circlePoint(
  radius: number,
  angle: number,
  tilt: number,
  tiltZ = 0,
): Vec3 {
  const flat: Vec3 = [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
  let p = tilt === 0 ? flat : rotateX(flat, tilt);
  if (tiltZ !== 0) p = rotateZ(p, tiltZ);
  return p;
}

/* ------------------------------------------------------------------ */
/* Projection                                                         */
/* ------------------------------------------------------------------ */

/**
 * Perspective projection.
 *
 * `focal` is the distance from the lens to the projection plane, in the
 * same units as the scene. A vertex at z = focal projects 1:1; anything
 * nearer than that is magnified and anything behind the lens is culled
 * rather than mirrored, which is what `visible` reports.
 *
 * `radius` must be the radius of the *thing being projected* — the shell,
 * not the canvas. It normalises `depth` to 0..1 across that object, which
 * is what lets the renderer map depth straight onto size and alpha. Pass
 * the orb's radius here and a shell that only fills half of it collapses
 * into the middle of the depth range: every particle draws at nearly the
 * same size, and the sphere flattens into a disc.
 */
export function project(
  p: Vec3,
  opts: { focal: number; centerX: number; centerY: number; radius: number },
  out: Projected,
): Projected {
  const z = opts.focal - p[2];
  out.visible = z > 1 ? 1 : 0;
  const scale = out.visible ? opts.focal / z : 0;
  out.x = opts.centerX + p[0] * scale;
  out.y = opts.centerY - p[1] * scale;
  const span = opts.radius > 0 ? opts.radius : 1;
  out.depth = clamp(0.5 + p[2] / (span * 2), 0, 1);
  return out;
}

/** A fresh projection scratch object. Reused for the whole frame. */
export function projectionScratch(): Projected {
  return { x: 0, y: 0, depth: 0.5, visible: 0 };
}

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                           */
/* ------------------------------------------------------------------ */

/**
 * mulberry32. A tiny, fast, well-distributed PRNG with an explicit seed.
 *
 * The scene must be identical on every load — a particle field that
 * reshuffles on each refresh reads as noise rather than as an object —
 * and it must not use `Math.random`, which would also make the layout
 * differ between the server render and the client hydration.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
