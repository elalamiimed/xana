/**
 * The palette contract, measured instead of trusted.
 *
 * `npm run verify:web` already asserts that `--text`, `--text-dim` and
 * `--text-faint` clear 4.5:1 against every surface in the *served* stylesheet,
 * and that is the promise that matters most. This script measures the rest of
 * what DESIGN.md claims and takes no server: the surface ladder has to read as
 * steps, and the three semantic colours have to be legible on the void.
 *
 * WHY BOTH EXIST
 *
 * `verify:web` needs a running server because its point is that a token made it
 * through Tailwind intact. This one needs nothing, so it can run in `check`
 * beside the craft floor — and it is where a *new* token gets measured before
 * anyone looks at it. The comment in `globals.css` about `--text-faint` being
 * raised twice is the argument for this existing at all: the second regression
 * was invisible because the promise lived in prose.
 *
 *   node scripts/check-palette.mjs
 */

import { readFileSync } from "node:fs";

const CSS = readFileSync("src/app/globals.css", "utf8");

/** The channel form tokens use: hex only. An accent is channels and is not here. */
function token(name) {
  const match = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  return match ? match[1].toLowerCase() : null;
}

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let failures = 0;
let checks = 0;

function assert(label, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const SURFACES = ["void", "surface", "surface-2", "surface-3"];
const TEXT_FLOOR = 4.5;

console.log("Palette — measured against DESIGN.md §1");

/* ---- text on every surface ---------------------------------------- */

for (const name of ["text", "text-dim", "text-faint"]) {
  const colour = token(name);
  if (!colour) {
    assert(`--${name} exists`, false, "no hex value found");
    continue;
  }
  const measured = SURFACES.map((surface) => ({ surface, ratio: contrast(colour, token(surface)) }));
  const worst = measured.sort((a, b) => a.ratio - b.ratio)[0];
  assert(
    `--${name} clears ${TEXT_FLOOR}:1 on every surface`,
    worst.ratio >= TEXT_FLOOR,
    `worst ${worst.ratio.toFixed(2)}:1 on --${worst.surface}`,
  );
}

/* ---- the ladder has to read as steps ------------------------------ */

/**
 * 1.08:1 is the number the file itself settled on, after a ladder that measured
 * 1.05:1 between the page and a card was judged invisible. Below that an edge
 * stops reading and a nested panel looks like the panel it sits on.
 */
for (let i = 1; i < SURFACES.length; i++) {
  const step = contrast(token(SURFACES[i - 1]), token(SURFACES[i]));
  assert(
    `--${SURFACES[i - 1]} -> --${SURFACES[i]} reads as a step`,
    step >= 1.08,
    `${step.toFixed(3)}:1`,
  );
}

/* ---- semantic colours on the void --------------------------------- */

/**
 * No floor beyond "legible": these are 1px accents and small words, not body
 * copy, and DESIGN.md wants them warm rather than loud. Measured so a future
 * palette edit sees the number it is moving.
 */
for (const name of ["warn", "good", "danger"]) {
  const ratio = contrast(token(name), token("void"));
  assert(`--${name} is legible on the void`, ratio >= 4.5, `${ratio.toFixed(2)}:1`);
}

console.log(`\n  ${checks} checks\n`);

if (failures > 0) {
  console.log(`  ${failures} palette claim${failures === 1 ? "" : "s"} no longer hold.\n`);
  process.exit(1);
}

console.log("  ok    the palette still holds its own contract\n");
