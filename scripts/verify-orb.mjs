/**
 * Verify the orb's 3D scene and maths.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/verify-orb.mjs
 *
 * The orb is the one part of the interface that cannot be verified by
 * fetching HTML: it is a canvas, and the served bytes only prove a
 * `<canvas>` tag exists. So the model *behind* the drawing is checked here
 * instead — the shell, the rings, the per-presence behaviour table, and the
 * breath — on the same TypeScript the canvas imports, not a copy.
 *
 * What this cannot check is whether it looks good. That is what the
 * screenshots are for.
 */

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

const scene = await import("../src/components/xana/orb/scene.ts");
const math = await import("../src/components/xana/orb/math3d.ts");

const { buildScene, PRESENCE_STYLE, visiblePoints, breathAt, advance } = scene;
const { orient, project, projectionScratch, smooth, rotateX, rotateY, circlePoint } = math;

/* ---------------- the shell ---------------- */
section("The shell");

const full = buildScene(1, 12345);
check("has points", full.points.length >= 200, String(full.points.length));
check("has three orbit rings", full.rings.length === 3, String(full.rings.length));
check(
  "every point lies on the unit sphere",
  full.points.every((p) => Math.abs(Math.hypot(p.dir[0], p.dir[1], p.dir[2]) - 1) < 1e-6),
);

// Cosine-distributed polar angle is what keeps the density even. A uniform
// angle would clump at the poles and read as a spinning top.
const upper = full.points.filter((p) => p.dir[1] > 0.5).length;
const band = full.points.filter((p) => Math.abs(p.dir[1]) <= 0.5).length;
check(
  "density is even rather than pole-heavy",
  band > upper,
  `${upper} near a pole vs ${band} in the equatorial band`,
);

check(
  "the layout is deterministic across loads",
  JSON.stringify(buildScene(1, 12345).points[0]) === JSON.stringify(full.points[0]),
);
check(
  "a different seed gives a different layout",
  JSON.stringify(buildScene(1, 999).points[0]) !== JSON.stringify(full.points[0]),
);

const sparse = visiblePoints(full.points, 0.25);
check("low density thins the shell", sparse.length < full.points.length * 0.4);
const sparseFront = sparse.filter((p) => p.dir[2] > 0).length;
check(
  "a sparse shell still covers the whole sphere",
  sparseFront > sparse.length * 0.3 && sparseFront < sparse.length * 0.7,
  `${sparseFront}/${sparse.length} on the near side`,
);

/* ---------------- the presence table ---------------- */
section("The presence table");

const presences = ["dormant", "idle", "thinking", "speaking", "acting"];
check("every presence has a style", presences.every((name) => Boolean(PRESENCE_STYLE[name])));
check(
  "thinking is denser than idle",
  PRESENCE_STYLE.thinking.density > PRESENCE_STYLE.idle.density,
);
check(
  "thinking rotates faster than idle",
  PRESENCE_STYLE.thinking.spin < PRESENCE_STYLE.idle.spin,
);
check(
  "speaking has the brightest core",
  presences.every(
    (name) => name === "speaking" || PRESENCE_STYLE[name].core <= PRESENCE_STYLE.speaking.core,
  ),
);
check(
  "dormant is the dimmest and the slowest",
  PRESENCE_STYLE.dormant.gain === Math.min(...presences.map((n) => PRESENCE_STYLE[n].gain)) &&
    PRESENCE_STYLE.dormant.spin === Math.max(...presences.map((n) => PRESENCE_STYLE[n].spin)),
);
check(
  "only acting uses the secondary accent",
  PRESENCE_STYLE.acting.tint === 1 && presences.filter((n) => n !== "acting").every((n) => PRESENCE_STYLE[n].tint === 0),
);

/* ---------------- the breath ---------------- */
section("The breath");

const cycle = Array.from({ length: 40 }, (_, i) => breathAt(i * 0.2, 6.5, 0.045));
check("stays within its amplitude", cycle.every((v) => v >= 0.955 && v <= 1.045));
check("actually moves", Math.max(...cycle) - Math.min(...cycle) > 0.04);
check(
  "is a smooth sine rather than a wave with corners",
  // A sine's second difference is small everywhere; a triangle wave's is
  // concentrated at the extremes, which is the corner the eye catches.
  (() => {
    const second = cycle.slice(1, -1).map((v, i) => Math.abs(v * 2 - cycle[i] - cycle[i + 2]));
    return Math.max(...second) < 0.004;
  })(),
);
check("a zero period does not divide by zero", breathAt(3, 0, 0.05) === 1);

/* ---------------- angles ---------------- */
section("Angles");

check("advance wraps into 0..TAU", (() => {
  let angle = 0;
  for (let i = 0; i < 500; i += 1) angle = advance(angle, 7, 0.05);
  return angle >= 0 && angle < Math.PI * 2;
})());
check("advance goes backwards for a negative speed", (() => {
  const forward = advance(0, 1, 1);
  const backward = advance(0, -1, 1);
  return backward > forward;
})());

/* ---------------- projection ---------------- */
section("Projection");

const scratch = projectionScratch();
const opts = { focal: 100, centerX: 50, centerY: 50, radius: 40 };

const near = project([0, 0, 30], opts, scratch);
check("a near vertex is magnified", near.depth > 0.8, String(near.depth));
check("a near vertex is visible", near.visible === 1);

const far = project([0, 0, -30], opts, { ...scratch });
check("a far vertex has low depth", far.depth < 0.2, String(far.depth));
check(
  "depth spans the full range for an object its own size",
  (() => {
    const front = project([0, 0, 40], opts, { ...scratch }).depth;
    const back = project([0, 0, -40], opts, { ...scratch }).depth;
    return front > 0.99 && back < 0.01;
  })(),
);
check(
  "a point at depth 0.5 is a point at the origin",
  Math.abs(project([0, 0, 0], opts, { ...scratch }).depth - 0.5) < 1e-9,
);

const offscreen = project([0, 0, 200], opts, { ...scratch });
check("a vertex behind the lens is culled", offscreen.visible === 0);

const centre = project([0, 0, 0], opts, { ...scratch });
check("the origin projects to the centre", Math.abs(centre.x - 50) < 1e-9 && Math.abs(centre.y - 50) < 1e-9);

// Y is flipped: screen coordinates grow downward, world coordinates upward.
const up = project([0, 20, 0], opts, { ...scratch });
check("+Y projects upward on screen", up.y < 50, String(up.y));

/* ---------------- rotation ---------------- */
section("Rotation");

const rotated = rotateY([1, 0, 0], Math.PI / 2);
check(
  "a quarter turn about Y maps +X to -Z",
  Math.abs(rotated[0]) < 1e-9 && Math.abs(rotated[2] + 1) < 1e-9,
  JSON.stringify(rotated),
);
const tilted = rotateX([0, 1, 0], Math.PI / 2);
check(
  "a quarter turn about X maps +Y to +Z",
  Math.abs(tilted[1]) < 1e-9 && Math.abs(tilted[2] - 1) < 1e-9,
  JSON.stringify(tilted),
);
check(
  "orientation composition preserves length",
  (() => {
    const v = orient([0.3, -0.5, 0.8], 0.4, 1.1, -0.2);
    return Math.abs(Math.hypot(v[0], v[1], v[2]) - Math.hypot(0.3, -0.5, 0.8)) < 1e-9;
  })(),
);
check(
  "a circle point sits at its radius",
  (() => {
    const p = circlePoint(12, 1.234, 0.7, 0.4);
    return Math.abs(Math.hypot(p[0], p[1], p[2]) - 12) < 1e-9;
  })(),
);

/* ---------------- smoothing ---------------- */
section("Easing");

check("smooth closes half the gap in one half-life", (() => {
  const value = smooth(0, 1, 100, 100);
  return Math.abs(value - 0.5) < 1e-9;
})());
check("smooth is frame-rate independent", (() => {
  // One 100ms step must land where two 50ms steps land.
  const once = smooth(0, 1, 100, 100);
  const twice = smooth(smooth(0, 1, 100, 50), 1, 100, 50);
  return Math.abs(once - twice) < 1e-9;
})());
check("smooth reaches the target", Math.abs(smooth(0, 1, 100, 10_000) - 1) < 1e-6);
check("a zero half-life snaps", smooth(0, 1, 0, 16) === 1);
check("smooth survives a zero-length frame", smooth(0.3, 1, 100, 0) === 0.3);

/* ---------------- one frame, end to end ---------------- */
section("A frame of the shell");

// The real per-frame path: rotate every vertex, project it, and confirm the
// result lands inside the canvas and that near points really do draw larger.
const size = 320;
const half = size / 2;
const radius = half * 0.96;
const focal = radius * 2.6;
const shellRadius = radius * PRESENCE_STYLE.idle.shell;
const frameScratch = projectionScratch();
const frame = full.points.map((point) => {
  const r = shellRadius * (0.82 + point.seed * 0.18);
  const v = orient([point.dir[0] * r, point.dir[1] * r, point.dir[2] * r], -0.24, 0.4, 0);
  // Depth normalised against the shell, exactly as the renderer does.
  const p = project(v, { focal, centerX: half, centerY: half, radius: shellRadius }, frameScratch);
  return { ...p, z: v[2] };
});

check("every projected point is on the canvas", frame.every((p) => p.visible === 1));
check(
  "the shell fits inside the orb",
  frame.every((p) => Math.hypot(p.x - half, p.y - half) <= radius),
  `max ${Math.max(...frame.map((p) => Math.hypot(p.x - half, p.y - half))).toFixed(1)} vs ${radius.toFixed(1)}`,
);
check(
  "nearer points project further from the centre",
  (() => {
    const sorted = [...frame].sort((a, b) => b.z - a.z);
    const nearRadius = Math.hypot(sorted[0].x - half, sorted[0].y - half);
    const farRadius = Math.hypot(sorted[sorted.length - 1].x - half, sorted[sorted.length - 1].y - half);
    return nearRadius > farRadius;
  })(),
  "perspective is not inverted",
);
check(
  "depth spans most of its range",
  Math.max(...frame.map((p) => p.depth)) - Math.min(...frame.map((p) => p.depth)) > 0.5,
);

/* ---------------- result ---------------- */
section("Result");
console.log(`  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
