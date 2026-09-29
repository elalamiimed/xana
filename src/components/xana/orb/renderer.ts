/**
 * The orb renderer: a hand-rolled 3D renderer on a 2D canvas.
 *
 * It owns a `requestAnimationFrame` loop, all of the easing, and the
 * pointer interaction. React never sees a per-frame value — the component
 * hands this object a *target* (the current presence) and the renderer
 * eases toward it. That is the whole reason the motion is smooth: a React
 * re-render per frame would put the animation behind a scheduling
 * boundary, and any dropped frame would show up as a stutter in the
 * easing rather than in the drawing.
 *
 * WHAT IS ACTUALLY 3D HERE
 *
 * Everything. Shell points live on a sphere with real [x, y, z]
 * coordinates; the orbit rings are sampled circles tilted by real
 * rotations; the ripples expand in the orb's own equatorial plane. Each
 * frame the whole space is rotated (pitch / yaw / roll),
 * perspective-projected, and drawn with size and alpha derived from each
 * vertex's post-rotation depth. Nothing is faked with CSS `rotate3d`, so
 * the curvature is genuine: points on the far side of the sphere really do
 * travel along a shorter apparent path than points at the rim.
 *
 * The camera also drifts: a slow parallax sway plus a lean toward the
 * pointer. Both ease rather than track directly, so the orb feels like it
 * has mass — it is responding to you, not mirroring your cursor.
 */

import {
  TAU,
  circlePoint,
  clamp,
  mulberry32,
  orient,
  project,
  projectionScratch,
  smooth,
  type Projected,
  type Vec3,
} from "./math3d";
import {
  PRESENCE_STYLE,
  advance,
  breathAt,
  buildScene,
  visiblePoints,
  type OrbPresence,
  type OrbitRing,
  type OrbScene,
} from "./scene";

/* ------------------------------------------------------------------ */
/* Easing constants                                                   */
/* ------------------------------------------------------------------ */

/**
 * Half-lives, in milliseconds, for every eased quantity. Collected here
 * because the *relationships* between them are the orb's character: the
 * camera leans faster than the shell breathes, and the tint crossfades
 * slowest of all, so a change of activity reads as a mood shift rather
 * than a colour switch.
 */
const HALF_LIFE = {
  style: 460,
  camera: 620,
  pointer: 300,
  inertia: 900,
} as const;

/** A tab hidden for a minute must not resume with one huge frame. */
const MAX_FRAME_MS = 64;

/** How far inside the shell a point may sit, as a fraction of it. */
const SHELL_INNER = 0.82;

/** Camera distance as a multiple of the orb radius. Lower is a wider
 *  lens: more foreshortening, more of a sense of looking *into* it. */
const FOCAL_FACTOR = 2.6;

interface Ripple {
  /** Seconds since it started. Negative means it has not started yet. */
  age: number;
  /** Seconds it lives for. */
  life: number;
}

interface AccentRgb {
  primary: readonly [number, number, number];
  secondary: readonly [number, number, number];
  glow: readonly [number, number, number];
}

const DEFAULT_ACCENT: AccentRgb = {
  primary: [111, 227, 227],
  secondary: [156, 140, 255],
  glow: [111, 227, 227],
};

/* ------------------------------------------------------------------ */
/* Colour helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse the `R G B` channel triplet the stylesheet stores in
 * `--accent-rgb`. Falls back rather than throwing: a theme-token typo
 * should cost a colour, not the orb.
 */
function readChannels(
  value: string,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 3) return fallback;
  const r = parts[0] as number;
  const g = parts[1] as number;
  const b = parts[2] as number;
  if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    return fallback;
  }
  return [r, g, b];
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): readonly [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** `rgb()` with alpha, from a channel triplet. */
function rgba(c: readonly [number, number, number], alpha: number): string {
  const a = clamp(alpha, 0, 1);
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

/**
 * A radial-gradient sprite, drawn once and then blitted.
 *
 * The naive version of this renderer calls `createRadialGradient` and
 * `addColorStop` for every particle on every frame — roughly 900 gradient
 * objects a second at 280 points, which is the single easiest way to make
 * a canvas animation drop frames on a laptop. One cached bitmap, scaled
 * per particle, is visually identical at these sizes and effectively free.
 */
function glowSprite(
  size: number,
  stops: readonly (readonly [number, string])[],
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  canvas.width = Math.ceil(size * dpr);
  canvas.height = Math.ceil(size * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* The renderer                                                       */
/* ------------------------------------------------------------------ */

export interface OrbRendererOptions {
  /** Scales the point count. Below 1 thins the shell for small viewports. */
  quality?: number;
  /** Seed for the deterministic point layout. */
  seed?: number;
}

export class OrbRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scene: OrbScene;
  private size = 260;

  private frame = 0;
  private running = false;
  private disposed = false;
  private lastTime = 0;
  private time = 0;

  /** The target style, and the eased copy that chases it. */
  private target = PRESENCE_STYLE.idle;
  private style = { ...PRESENCE_STYLE.idle };
  private tint = 0;
  private gain = 1;

  /** Camera: base angles plus drift plus pointer lean. */
  private yaw = 0.4;
  private pitch = -0.24;
  private roll = 0;
  private driftYaw = 0;
  private driftPitch = 0;

  private leanX = 0;
  private leanY = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;

  /** Spin inertia from a drag, in radians per second. */
  private spinVelocity = 0;
  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragMoved = 0;

  private breath = 1;
  private ripples: Ripple[] = [];
  private rippleKey = 0;

  private accents: AccentRgb = DEFAULT_ACCENT;
  private themeFingerprint = "";

  private sprites = new Map<string, HTMLCanvasElement>();
  private projected: Projected = projectionScratch();
  private reduced = false;
  private visible = true;
  private readonly quality: number;

  constructor(options: OrbRendererOptions = {}) {
    this.quality = clamp(options.quality ?? 1, 0.25, 1);
    this.scene = buildScene(this.quality, options.seed);
  }

  /* ---------------- lifecycle ---------------- */

  attach(canvas: HTMLCanvasElement): void {
    if (this.disposed) return;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.sprites.clear();
    this.resize();
    // Refresh before the first frame so the orb is never drawn in the
    // default accent for one frame after a themed reload.
    this.refreshPalette();
  }

  /** Resize the backing store to the element's box at the current DPR. */
  resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssSize = Math.max(1, Math.min(rect.width, rect.height) || this.size);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const backing = Math.round(cssSize * dpr);

    if (canvas.width !== backing || canvas.height !== backing) {
      canvas.width = backing;
      canvas.height = backing;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = cssSize;
    this.sprites.clear();
  }

  /** Mark the renderer on/off screen. Off screen, the loop idles. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.start();
    else this.stop();
  }

  /**
   * Switch to reduced motion.
   *
   * This is not "run the same animation slowly". The loop stops entirely
   * and the orb is drawn once as a still, fully-rendered shell: for a
   * reader who has asked the system not to move things, an object that
   * rotates forever is precisely what they asked not to have. The still
   * frame keeps the 3D form, so the orb is still recognisably the orb —
   * it just holds still.
   */
  setReducedMotion(reduced: boolean): void {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    if (reduced) {
      this.stop();
      this.render();
    } else {
      this.start();
    }
  }

  /**
   * Set the presence. Everything visual is a consequence of this call:
   * the style targets change, and the eased values catch up over the next
   * few hundred milliseconds.
   */
  setPresence(presence: OrbPresence): void {
    const next = PRESENCE_STYLE[presence];
    if (!next || this.target === next) return;
    this.target = next;
    if (this.reduced) {
      // No easing to watch: adopt the target at once and repaint.
      this.style = { ...next };
      this.tint = next.tint;
      this.gain = next.gain;
      this.render();
    }
  }

  /** Fire one ripple. `key` is opaque: any change from the last call fires. */
  setRippleKey(key: number): void {
    if (key === this.rippleKey) return;
    this.rippleKey = key;
    if (this.reduced) return;
    // Two waves, the second delayed, so the ripple has a trailing edge
    // rather than reading as a single expanding circle.
    this.ripples.push({ age: 0, life: 1.05 });
    this.ripples.push({ age: -0.12, life: 1.2 });
    if (this.ripples.length > 6) this.ripples.splice(0, this.ripples.length - 6);
  }

  /* ---------------- pointer ---------------- */

  /**
   * Feed a pointer position, normalised to about -1..1 from the orb's
   * centre, plus the raw client coordinates.
   *
   * Movement *while not dragging* leans the camera; movement while
   * dragging spins the orb. Tracking both from one handler is what makes
   * the interaction feel like one object with two behaviours rather than
   * two separate modes.
   */
  pointerMove(nx: number, ny: number, clientX: number, clientY: number): void {
    this.pointerX = clamp(nx, -1.5, 1.5);
    this.pointerY = clamp(ny, -1.5, 1.5);
    this.pointerInside = true;

    if (!this.dragging) return;
    const dx = clientX - this.dragLastX;
    const dy = clientY - this.dragLastY;
    this.dragLastX = clientX;
    this.dragLastY = clientY;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    // 0.006 rad per pixel: a full-width drag is roughly half a turn.
    this.yaw += dx * 0.006;
    this.pitch = clamp(this.pitch + dy * 0.004, -1.1, 1.1);
    this.spinVelocity = dx * 0.28;
  }

  pointerLeave(): void {
    this.pointerInside = false;
    this.dragging = false;
  }

  pointerDown(clientX: number, clientY: number): void {
    this.dragging = true;
    this.dragMoved = 0;
    this.dragLastX = clientX;
    this.dragLastY = clientY;
    this.spinVelocity = 0;
  }

  /**
   * End a drag. Returns true when the gesture travelled far enough to
   * count as a drag, so the component can tell a spin from a click.
   */
  pointerUp(): boolean {
    const wasDrag = this.dragMoved > 6;
    this.dragging = false;
    return wasDrag;
  }

  /* ---------------- palette ---------------- */

  /**
   * Re-read the accent channels from the document.
   *
   * The theme picker writes new channels onto `<html>`; this is how the
   * canvas finds out. Reading computed styles is expensive enough that
   * the result is fingerprinted and skipped when nothing changed.
   */
  refreshPalette(): void {
    if (typeof window === "undefined") return;
    const styles = getComputedStyle(document.documentElement);
    const raw = [
      styles.getPropertyValue("--accent-rgb").trim(),
      styles.getPropertyValue("--accent-2-rgb").trim(),
      styles.getPropertyValue("--glow-rgb").trim(),
    ];
    const fingerprint = raw.join("|");
    if (fingerprint === this.themeFingerprint) return;
    this.themeFingerprint = fingerprint;
    this.accents = {
      primary: readChannels(raw[0] ?? "", DEFAULT_ACCENT.primary),
      secondary: readChannels(raw[1] ?? "", DEFAULT_ACCENT.secondary),
      glow: readChannels(raw[2] ?? "", DEFAULT_ACCENT.glow),
    };
    this.sprites.clear();
  }

  /* ---------------- the loop ---------------- */

  start(): void {
    if (this.disposed || this.reduced || this.running || !this.visible) return;
    this.running = true;
    this.lastTime = 0;
    this.frame = requestAnimationFrame(this.onFrame);
  }

  stop(): void {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.canvas = null;
    this.ctx = null;
    this.sprites.clear();
  }

  private onFrame = (timestamp: number): void => {
    if (!this.running || this.disposed) return;
    const dt = this.lastTime
      ? Math.min(MAX_FRAME_MS, timestamp - this.lastTime)
      : 16.7;
    this.lastTime = timestamp;

    this.step(dt / 1000, dt);
    this.render();

    if (this.running) this.frame = requestAnimationFrame(this.onFrame);
  };

  /**
   * Advance the animation by `dtSec`.
   *
   * Split out from `render` so a test can step the simulation without a
   * canvas, and so `render` stays a description of what to draw.
   */
  step(dtSec: number, dtMs: number): void {
    this.time += dtSec;
    this.refreshPalette();

    /* --- style easing --- */
    const s = this.style;
    const t = this.target;
    s.shell = smooth(s.shell, t.shell, HALF_LIFE.style, dtMs);
    s.density = smooth(s.density, t.density, HALF_LIFE.style, dtMs);
    s.pointSize = smooth(s.pointSize, t.pointSize, HALF_LIFE.style, dtMs);
    s.pointAlpha = smooth(s.pointAlpha, t.pointAlpha, HALF_LIFE.style, dtMs);
    s.core = smooth(s.core, t.core, HALF_LIFE.style, dtMs);
    s.coreRadius = smooth(s.coreRadius, t.coreRadius, HALF_LIFE.style, dtMs);
    s.rings = smooth(s.rings, t.rings, HALF_LIFE.style, dtMs);
    s.spin = smooth(s.spin, t.spin, HALF_LIFE.style, dtMs);
    s.breath = smooth(s.breath, t.breath, HALF_LIFE.style, dtMs);
    s.breathAmp = smooth(s.breathAmp, t.breathAmp, HALF_LIFE.style, dtMs);
    // The tint crossfades slowest: a change of activity should read as a
    // shift of mood, not as the orb being switched to another colour.
    this.tint = smooth(this.tint, t.tint, HALF_LIFE.style * 1.8, dtMs);
    this.gain = smooth(this.gain, t.gain, HALF_LIFE.style, dtMs);

    /* --- the breath --- */
    this.breath = breathAt(this.time, s.breath, s.breathAmp);

    /* --- camera drift --- */
    // Two mismatched periods (23s and 31s) that realign only every few
    // minutes, so the sway never settles into a recognisable loop.
    this.driftYaw = Math.sin((this.time / 23) * TAU) * 0.1;
    this.driftPitch = Math.sin((this.time / 31) * TAU + 1.1) * 0.06;

    // While dragging, the pointer lean is heavily damped: the drag is the
    // input, and chasing the cursor at the same time fights it.
    const pointerWeight = this.dragging ? 0.25 : 1;
    this.leanX = smooth(
      this.leanX,
      this.pointerInside ? this.pointerX * 0.16 * pointerWeight : 0,
      HALF_LIFE.pointer,
      dtMs,
    );
    this.leanY = smooth(
      this.leanY,
      this.pointerInside ? this.pointerY * 0.12 * pointerWeight : 0,
      HALF_LIFE.pointer,
      dtMs,
    );

    // A deliberate roll, coupled to the pointer: the orb banks slightly
    // into a lean, which is the cue that reads as weight.
    this.roll = smooth(
      this.roll,
      this.driftPitch * 0.4 + this.leanX * 0.18,
      HALF_LIFE.camera,
      dtMs,
    );

    /* --- spin --- */
    if (!this.dragging) {
      this.yaw += this.spinVelocity * dtSec;
      this.spinVelocity = smooth(this.spinVelocity, 0, HALF_LIFE.inertia, dtMs);
      if (Math.abs(this.spinVelocity) < 0.0005) this.spinVelocity = 0;
    }
    this.yaw = advance(this.yaw, 1 / Math.max(6, s.spin), dtSec);

    /* --- ripples --- */
    if (this.ripples.length) {
      for (const ripple of this.ripples) ripple.age += dtSec;
      this.ripples = this.ripples.filter((r) => r.age < r.life);
    }
  }

  /* ---------------- drawing ---------------- */

  private render(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const size = this.size;
    const half = size / 2;
    const radius = half * 0.96;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const accent = mixRgb(this.accents.primary, this.accents.secondary, this.tint);
    const glow = mixRgb(this.accents.glow, this.accents.secondary, this.tint * 0.7);
    const gain = this.gain;

    const pitch = this.pitch + this.driftPitch + this.leanY;
    const yaw = this.yaw + this.driftYaw + this.leanX;
    const roll = this.roll;
    const focal = radius * FOCAL_FACTOR;
    const breath = this.breath;
    const shellRadius = radius * this.style.shell;

    /* --- 1. the halo: a wide, very soft wash behind everything ------ */
    const halo = ctx.createRadialGradient(half, half, 0, half, half, radius);
    halo.addColorStop(0, rgba(glow, 0.1 * gain * this.style.core));
    halo.addColorStop(0.45, rgba(glow, 0.04 * gain * this.style.core));
    halo.addColorStop(1, rgba(glow, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    /* --- 2. orbit rings -------------------------------------------- */
    if (this.style.rings > 0.01) {
      for (const ring of this.scene.rings) {
        this.drawOrbit(ctx, ring, pitch, yaw, roll, radius, focal, accent, gain);
      }
    }

    /* --- 3. the shell ---------------------------------------------- */
    this.drawShell(
      ctx,
      half,
      radius,
      shellRadius * breath,
      pitch,
      yaw,
      roll,
      focal,
      accent,
      gain,
    );

    /* --- 4. the core: a luminous centre, over the shell ------------ */
    const coreRadius = Math.max(2, radius * this.style.coreRadius * breath);
    const core = ctx.createRadialGradient(half, half, 0, half, half, coreRadius);
    core.addColorStop(0, rgba(glow, 0.52 * gain * this.style.core));
    core.addColorStop(0.5, rgba(glow, 0.15 * gain * this.style.core));
    core.addColorStop(1, rgba(glow, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(half, half, coreRadius, 0, TAU);
    ctx.fill();

    /* --- 5. ripples: a wave leaving the core ---------------------- */
    for (const ripple of this.ripples) {
      if (ripple.age < 0) continue;
      const progress = clamp(ripple.age / ripple.life, 0, 1);
      // Ease-out expansion: fast off the core, slowing as it dissipates.
      const eased = 1 - Math.pow(1 - progress, 2.4);
      this.strokeCircle3d(
        ctx,
        radius * (0.3 + eased * 0.78),
        pitch,
        yaw,
        roll,
        half,
        focal,
        accent,
        (1 - progress) * 0.32,
      );
    }
  }

  /**
   * Stroke a circle that exists in 3D: sampled in the orb's equatorial
   * plane and projected point by point, so it is genuinely round in
   * perspective rather than an ellipse drawn to look like one.
   */
  private strokeCircle3d(
    ctx: CanvasRenderingContext2D,
    circleRadius: number,
    pitch: number,
    yaw: number,
    roll: number,
    half: number,
    focal: number,
    color: readonly [number, number, number],
    alpha: number,
    segments = 80,
  ): void {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * TAU;
      const verts = orient(
        circlePoint(circleRadius, angle, 0.5, 0.9) as Vec3,
        pitch,
        yaw,
        roll,
      );
      const p = project(
        verts,
        // The circle's own radius normalises depth: this circle *is* the
        // object being projected, so its far side must read as far.
        { focal, centerX: half, centerY: half, radius: circleRadius },
        this.projected,
      );
      if (!p.visible) {
        started = false;
        continue;
      }
      if (started) ctx.lineTo(p.x, p.y);
      else {
        ctx.moveTo(p.x, p.y);
        started = true;
      }
    }
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * One orbit ring, drawn in two passes — the far half dimmer than the
   * near half. A single path would make the ring read as flat, which is
   * exactly the impression the whole renderer exists to avoid.
   */
  private drawOrbit(
    ctx: CanvasRenderingContext2D,
    ring: OrbitRing,
    pitch: number,
    yaw: number,
    roll: number,
    radius: number,
    focal: number,
    accent: readonly [number, number, number],
    gain: number,
  ): void {
    const spin = this.time * ring.speed;
    const ringRadius = radius * ring.radius * this.breath;
    const alpha = this.style.rings * ring.weight * gain;
    const segments = ring.segments;

    for (const near of [false, true]) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= segments; i += 1) {
        const angle = (i / segments) * TAU + spin;
        const verts = orient(
          circlePoint(ringRadius, angle, ring.tilt, ring.tiltZ) as Vec3,
          pitch,
          yaw,
          roll,
        );
        // Split on the vertex's own depth, not on the projected point:
        // the 3D position is the fact, the projection is a consequence.
        if ((verts[2] > 0) !== near) {
          started = false;
          continue;
        }
        const p = project(
          verts,
          // Normalised against the ring's own radius, so the far half of
          // the orbit genuinely reads as behind rather than merely dimmer.
          { focal, centerX: this.size / 2, centerY: this.size / 2, radius: ringRadius },
          this.projected,
        );
        if (!p.visible) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(p.x, p.y);
        else {
          ctx.moveTo(p.x, p.y);
          started = true;
        }
      }
      ctx.strokeStyle = rgba(accent, alpha * (near ? 1 : 0.42));
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawShell(
    ctx: CanvasRenderingContext2D,
    half: number,
    radius: number,
    shellRadius: number,
    pitch: number,
    yaw: number,
    roll: number,
    focal: number,
    accent: readonly [number, number, number],
    gain: number,
  ): void {
    const points = visiblePoints(this.scene.points, this.style.density);
    // The sprite is drawn at full alpha and modulated with globalAlpha, so
    // the falloff is applied exactly once. Doing it in both places would
    // square the curve and make the dim end of the depth range vanish.
    const baseSize = Math.max(2.5, radius * 0.052 * this.style.pointSize);
    const sprite = this.spriteFor(accent, baseSize);

    for (const point of points) {
      // Radial jitter gives the shell thickness, so it reads as a volume
      // of points rather than a painted surface.
      const r = shellRadius * (SHELL_INNER + point.seed * (1 - SHELL_INNER));
      const verts = orient(
        [point.dir[0] * r, point.dir[1] * r, point.dir[2] * r] as Vec3,
        pitch,
        yaw,
        roll,
      );
      const p = project(
        verts,
        // The shell's radius, not the orb's: passing the larger one would
        // squeeze every particle into the middle of the depth range and
        // flatten the sphere into a disc.
        { focal, centerX: half, centerY: half, radius: shellRadius },
        this.projected,
      );
      if (!p.visible) continue;

      // Facing: how much this point points at the camera. Far-side points
      // are kept — they are what makes the sphere look like a sphere — at
      // a fraction of the alpha.
      const facing = 0.5 + (verts[2] / Math.max(1, shellRadius)) * 0.5;
      const twinkle = 0.85 + Math.sin(this.time * 0.9 + point.seed * TAU) * 0.15;
      const alpha = this.style.pointAlpha * gain * facing * twinkle;
      if (alpha < 0.015) continue;

      const drawSize = baseSize * (0.45 + p.depth * 0.9);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.drawImage(sprite, p.x - drawSize / 2, p.y - drawSize / 2, drawSize, drawSize);
    }
    ctx.globalAlpha = 1;

    // The silhouette: a true 3D circle at the shell's own radius, so the
    // object has an edge to read against and breathes with the shell.
    this.strokeCircle3d(
      ctx,
      shellRadius,
      pitch,
      yaw,
      roll,
      half,
      focal,
      accent,
      0.11 * gain,
      72,
    );
  }

  /**
   * A glow sprite tinted for the current accent and sized for the current
   * particle. Keyed on both, so a theme change or a resize rebuilds it
   * once rather than every frame.
   */
  private spriteFor(
    accent: readonly [number, number, number],
    size: number,
  ): HTMLCanvasElement {
    const key = `${Math.round(accent[0])}|${Math.round(accent[1])}|${Math.round(accent[2])}|${Math.round(size)}`;
    const cached = this.sprites.get(key);
    if (cached) return cached;

    const sprite = glowSprite(Math.max(4, Math.ceil(size * 2.6)), [
      [0, rgba(accent, 1)],
      [0.32, rgba(accent, 0.3)],
      [1, rgba(accent, 0)],
    ]);
    // A small cache: a theme change and a resize produce a handful of
    // entries, and an unbounded map would leak across a long session.
    if (this.sprites.size > 12) this.sprites.clear();
    this.sprites.set(key, sprite);
    return sprite;
  }
}

/** A stable seed for the point layout, so the shell is identical on every
 *  load rather than reshuffling on each refresh. */
export function orbSeed(): number {
  return Math.floor(mulberry32(0x5a17a)() * 0xffffffff);
}
