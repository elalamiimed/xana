/**
 * The orb's 3D scene description.
 *
 * This module is deliberately free of DOM, canvas and React. It answers
 * one question — "what is in the orb, and where is it right now?" — and
 * the renderer's only job is to draw the answer. That split is what lets
 * `scripts/demo.ts` assert on the orb's behaviour without a browser,
 * which matters because the orb is the one piece of the UI that cannot be
 * verified by fetching HTML.
 *
 * The object is a **shell**, not a ball: a few hundred points distributed
 * over a sphere with every point tagged with its depth relative to the
 * shell. Rendering only the front half would give a solid dome; rendering
 * the whole thing with alpha falling off toward the back gives something
 * you can see *through*, which is the quality that reads as volume rather
 * than as a circle with dots on it.
 */

import { TAU, mulberry32, type Vec3 } from "./math3d";

/* ------------------------------------------------------------------ */
/* Presence vocabulary                                                */
/* ------------------------------------------------------------------ */

export type OrbPresence = "dormant" | "idle" | "thinking" | "speaking" | "acting";

export const ORB_PRESENCES: readonly OrbPresence[] = [
  "dormant",
  "idle",
  "thinking",
  "speaking",
  "acting",
];

/**
 * How each presence looks. Every field is a *target*: the renderer eases
 * toward these values, so moving between presences is a transition rather
 * than a cut. Nothing here is a duration or a frame count — the easing
 * half-lives live in the renderer, and the drift speeds are in radians
 * per second so they are independent of frame rate.
 */
export interface PresenceStyle {
  /** Radius of the shell, as a fraction of the orb's half-size. */
  shell: number;
  /** Fraction of shell points drawn. Lower = sparser, more diffuse. */
  density: number;
  /** How much each point swells toward the camera. */
  pointSize: number;
  /** Peak alpha of a point at the front of the shell. */
  pointAlpha: number;
  /** Radial glow strength at the centre. */
  core: number;
  /** Radius of the core glow, as a fraction of the orb's half-size. */
  coreRadius: number;
  /** Orbit ring opacity. */
  rings: number;
  /** Seconds per full rotation of the shell about its own axis. */
  spin: number;
  /** Seconds per breath cycle. */
  breath: number;
  /** Depth of the breath, as a fraction of the shell radius. */
  breathAmp: number;
  /** Accent mix, 0 = primary accent, 1 = secondary. */
  tint: number;
  /** Global gain on every point, for the dimmer presences. */
  gain: number;
}

/**
 * The state table. Read it as a sentence per row:
 *
 *   dormant   — sparse, slow, cold, barely there. She is resting.
 *   idle      — the resting state: a full quiet shell, breathing once
 *               every six seconds.
 *   thinking  — denser and faster, the shell visibly tighter, rings up.
 *               Motion is the signal; nothing here says "please wait".
 *   speaking  — the widest breath and the brightest core, one ripple.
 *   acting    — the thinking shell shifted toward the secondary accent,
 *               so a write-back is legible as a different *kind* of
 *               activity rather than merely more of it.
 */
export const PRESENCE_STYLE: Record<OrbPresence, PresenceStyle> = {
  dormant: {
    shell: 0.42,
    density: 0.38,
    pointSize: 0.9,
    pointAlpha: 0.3,
    core: 0.3,
    coreRadius: 0.3,
    rings: 0.06,
    spin: 150,
    breath: 9,
    breathAmp: 0.02,
    tint: 0,
    gain: 0.55,
  },
  idle: {
    shell: 0.52,
    density: 0.78,
    pointSize: 1,
    pointAlpha: 0.5,
    core: 0.6,
    coreRadius: 0.42,
    rings: 0.1,
    spin: 96,
    breath: 6.5,
    breathAmp: 0.045,
    tint: 0,
    gain: 1,
  },
  thinking: {
    shell: 0.47,
    density: 0.96,
    pointSize: 1.1,
    pointAlpha: 0.66,
    core: 0.8,
    coreRadius: 0.5,
    rings: 0.2,
    spin: 26,
    breath: 2.4,
    breathAmp: 0.06,
    tint: 0,
    gain: 1,
  },
  speaking: {
    shell: 0.53,
    density: 0.86,
    pointSize: 1.25,
    pointAlpha: 0.72,
    core: 1,
    coreRadius: 0.6,
    rings: 0.16,
    spin: 60,
    breath: 3.4,
    breathAmp: 0.09,
    tint: 0,
    gain: 1,
  },
  acting: {
    shell: 0.46,
    density: 1,
    pointSize: 1.15,
    pointAlpha: 0.68,
    core: 0.85,
    coreRadius: 0.5,
    rings: 0.24,
    spin: 20,
    breath: 2.8,
    breathAmp: 0.05,
    tint: 1,
    gain: 1,
  },
};

/* ------------------------------------------------------------------ */
/* Scene construction                                                 */
/* ------------------------------------------------------------------ */

export interface ShellPoint {
  /** Unit direction on the sphere. */
  dir: Vec3;
  /** 0..1, a stable per-point random. Drives twinkle phase and size jitter. */
  seed: number;
  /** 0..1, which of the tint endpoints this point leans toward. */
  tint: number;
}

export interface OrbitRing {
  /** Orbit radius, as a fraction of the orb's half-size. */
  radius: number;
  /** Inclination about X, in radians. */
  tilt: number;
  /** A second rotation about Z, so the rings are not coplanar. */
  tiltZ: number;
  /** Radians per second. Sign gives the direction. */
  speed: number;
  /** Relative opacity against `PresenceStyle.rings`. */
  weight: number;
  /** Points around the orbit. More for the larger rings. */
  segments: number;
}

export interface OrbScene {
  points: ShellPoint[];
  rings: OrbitRing[];
}

/**
 * Build the scene.
 *
 * `quality` is 1 for a full field and lower for a small viewport or a
 * low-power hint. The point count is the only thing that changes: the
 * ring geometry is cheap and stays constant so the orb never changes
 * *shape* between devices, only density.
 */
export function buildScene(quality = 1, seed = 0x5a17a): OrbScene {
  const count = Math.max(60, Math.round(280 * quality));
  const rand = mulberry32(seed);

  const points: ShellPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    // Cosine-distributed polar angle gives an even area density on the
    // sphere. Sampling the angle uniformly instead would clump every
    // point at the poles and read as a spinning top.
    const u = rand() * 2 - 1;
    const theta = rand() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    points.push({
      dir: [r * Math.cos(theta), u, r * Math.sin(theta)],
      seed: rand(),
      tint: rand(),
    });
  }

  const rings: OrbitRing[] = [
    // The equator, nearly edge-on: reads as the orb's own axis.
    { radius: 0.5, tilt: 1.16, tiltZ: 0.22, speed: 0.36, weight: 0.5, segments: 88 },
    // A wide, shallow ring: the outer boundary of the object.
    { radius: 0.78, tilt: 0.34, tiltZ: -0.5, speed: -0.22, weight: 0.34, segments: 112 },
    // A tight, steep ring close in: the sense of an inner mechanism.
    { radius: 0.3, tilt: 1.44, tiltZ: 0.9, speed: 0.62, weight: 0.42, segments: 64 },
  ];

  return { points, rings };
}

/**
 * The breath, as a scalar in `1 - amp .. 1 + amp`.
 *
 * A true sine rather than a triangle: the whole point of the breath is
 * that it has no visible start or end, and a triangle wave has a corner
 * at every extreme that the eye reliably catches on a slow cycle.
 */
export function breathAt(seconds: number, period: number, amp: number): number {
  if (period <= 0) return 1;
  return 1 + Math.sin((seconds / period) * TAU) * amp;
}

/**
 * Advance an angle by a per-second speed, normalised to 0..TAU.
 *
 * Normalising every frame is what keeps float precision usable in a
 * session left open for hours: without it, a long-running page
 * accumulates a large angle and `Math.cos` of 10^7 radians loses the
 * low bits that the animation depends on.
 */
export function advance(angle: number, speed: number, dtSec: number): number {
  const next = angle + speed * dtSec;
  return ((next % TAU) + TAU) % TAU;
}

/**
 * Which shell points to draw for a given density.
 *
 * Rather than slicing the array — which would always drop the same tail
 * and make the sphere visibly lopsided at low density — this takes every
 * n-th point with a stride derived from the density, so a sparse field is
 * still evenly spread over the whole sphere.
 */
export function visiblePoints(
  points: readonly ShellPoint[],
  density: number,
): ShellPoint[] {
  const total = points.length;
  const target = Math.max(1, Math.round(total * density));
  if (target >= total) return points as ShellPoint[];

  const stride = total / target;
  const out: ShellPoint[] = [];
  for (let i = 0; i < target; i += 1) {
    out.push(points[Math.floor(i * stride) % total] as ShellPoint);
  }
  return out;
}
