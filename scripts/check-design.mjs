/**
 * The craft floor, as a check.
 *
 * WHY THIS EXISTS
 *
 * The visual pass that produced these rules ran by hand, reading the panel and
 * `globals.css` — and it found five real drifts: an unthemed caret, an unthemed
 * native control, a card that was a hairline box rather than the project's own
 * `.card`, two sibling heading levels where the nesting wanted parent and child,
 * and a long token with nowhere to wrap. Every one of them is a *pattern*, not
 * a one-off typo, and every one could come back the next time a panel is added.
 *
 * The rest of this project already answers that with a script: `verify:web`
 * asserts the contrast ratios, `check:encodings` asserts no damaged characters,
 * `check:bundle` asserts the client bundle really carries the behaviour. The
 * rules that were only auditable by eye had no equivalent. This is it.
 *
 * WHAT IT IS NOT
 *
 * It is not a design detector and it does not judge taste. It cannot see a
 * screenshot, and it will not tell you a panel is beautiful. It checks the
 * handful of invariants that are decidable from the source and that the design
 * review keeps having to re-derive — the ones where "I forgot" is the whole
 * failure mode.
 *
 * Each rule earns its place by having caught something real. A rule that only
 * encodes a preference belongs in DESIGN.md as prose, not here as a gate.
 *
 *   node scripts/check-design.mjs
 *
 * Exit 0 when every rule holds; exit 1 with the file, the line and the reason
 * when one does not.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const CSS_FILES = [join(SRC, "app", "globals.css")];

let failures = 0;
let checked = 0;

function fail(rule, file, line, message, fix) {
  failures++;
  const where = relative(ROOT, file).split(sep).join("/");
  console.log(`\n  FAIL  ${rule}`);
  console.log(`        ${where}:${line}`);
  console.log(`        ${message}`);
  if (fix) console.log(`        ${fix}`);
}

/** Every `.ts`/`.tsx` under `src`, in a stable order. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const UI_FILES = sourceFiles(SRC).filter((file) => file.endsWith(".tsx"));

/* ------------------------------------------------------------------ */
/* Rule 1 — the type scale floor                                      */
/* ------------------------------------------------------------------ */

/**
 * `font-light` is not used at 12px or below (DESIGN.md §1).
 *
 * The rule exists because the palette can pass every contrast ratio and the
 * interface still reads as fog: a 300-weight stroke at 11px on a near-black
 * field is about one pixel wide. The project measured this once and changed the
 * weight of a large fraction of its text; the measurement is worthless if a new
 * component can reintroduce the same combination.
 *
 * Only a literal 11px or 12px in the same class list is flagged, so a size that
 * comes from a token or a media query is not guessed at.
 */
function ruleTypeFloor() {
  const rule = "type floor — no font-light at 12px or below";
  for (const file of UI_FILES) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/className=/.test(line)) return;
      if (!/font-light/.test(line)) return;
      if (!/text-\[(11|12)px\]/.test(line)) return;
      checked++;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 96)}"`,
        "Weight is part of legibility: use font-normal at this size, or raise the size to 13px.",
      );
    });
    checked++;
  }
}

/* ------------------------------------------------------------------ */
/* Rule 2 — a page has one h1                                         */
/* ------------------------------------------------------------------ */

/**
 * No component in this app renders an `<h1>`.
 *
 * The shell owns the only h1 (the app's name), and every panel below it starts
 * at `h2`. A component that opens its own h1 to get a big heading breaks the
 * document outline for a screen reader, which is a real cost paid for a styling
 * shortcut — `text-[15px]` gets the same visual result.
 */
function ruleSingleH1() {
  const rule = "heading outline — components do not render h1";
  for (const file of UI_FILES) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      checked++;
      if (!/<h1[\s>]/.test(line)) return;
      if (/^\s*\*/.test(line)) return;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 96)}"`,
        "Only the shell renders an h1. Use h2 with the type scale for the look you want.",
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 3 — a heading never jumps a level below its own parent        */
/* ------------------------------------------------------------------ */

/**
 * The rule that *is* decidable: within one file, the levels a component uses
 * for its own nested headings never skip.
 *
 * The first version of this rule assumed a component's first heading sits
 * directly under the shell's h1 and flagged every h3 in the app — including six
 * that are perfectly correct, because their parent section renders an h2 this
 * file cannot see. That is a rule reporting on something it has no way to know,
 * which is worse than no rule: it teaches people to ignore the output.
 *
 * So the check is scoped to what a file can actually be wrong about. It records
 * the levels a file uses in source order and requires each step down to be at
 * most one: `h3, h4, h5, h4` passes, `h3, h5` does not. That is exactly the
 * mistake the Connections panel made — a group heading and a card title both at
 * h4, so a card was a sibling of its group — and it is the mistake that a new
 * panel is most likely to make again.
 *
 * Jumping *up* is free and common (`h4` inside a section, `h3` in the next
 * block), so only descents are checked.
 */
function ruleHeadingOrder() {
  const rule = "heading outline — levels in one component do not skip";
  for (const file of UI_FILES) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let deepest = 0;
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      const match = line.match(/<h([1-6])[\s>]/);
      if (!match) return;
      checked++;
      const level = Number(match[1]);
      // Only a step *below* the deepest level this file has already used can
      // skip. Anything at or above it is a new block at a level already
      // established, which is a shape, not a mistake.
      if (level > deepest && deepest > 0 && level > deepest + 1) {
        fail(
          rule,
          file,
          index + 1,
          `h${level} follows h${deepest} in this component — "${line.trim().slice(0, 80)}"`,
          `Use h${deepest + 1}; a card inside a group is one level below it, not four.`,
        );
      }
      deepest = Math.max(deepest, level);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 4 — long unbreakable values can wrap                          */
/* ------------------------------------------------------------------ */

/**
 * A URL or a token rendered in a `<code>` block carries a wrap rule.
 *
 * A URL has no spaces, so `overflow-wrap` is the only thing that gives the
 * browser somewhere to break; without it the value widens the panel instead of
 * wrapping inside it. The Connections panel renders two URLs and a 64-character
 * token, on a surface that has to survive 390px.
 *
 * Flagged only when the same element also carries `overflow-x-auto` — the
 * pattern that looks like it handles long values and does not.
 */
function ruleLongValueWrap() {
  const rule = "long values — code blocks that scroll also wrap";
  for (const file of UI_FILES) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/<code/.test(line) || !/className=/.test(line)) return;
      checked++;
      if (!/overflow-x-auto/.test(line)) return;
      if (/wrap-anywhere|break-all|break-words/.test(line)) return;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 96)}"`,
        "Add `wrap-anywhere` (or `break-all`) beside the scroll, so the value wraps before it ever scrolls.",
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 5 — the browser's own surfaces are themed                     */
/* ------------------------------------------------------------------ */

/**
 * The caret and native controls derive from the palette.
 *
 * The cheapest signal that a page was built rather than assembled, and the one
 * a token system forgets first: `caret-color` and `accent-color` default to a
 * system blue that belongs to no theme. Asserted against the stylesheet that is
 * actually served, not against the source file, because the token has to
 * survive Tailwind.
 */
async function ruleBrowserSurfaces() {
  const rule = "browser surfaces — caret and native controls are themed";
  const base = process.env.XANA_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;

  let css = "";
  const local = CSS_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
  try {
    const page = await fetch(base, { signal: AbortSignal.timeout(4000) });
    const html = await page.text();
    for (const href of [...html.matchAll(/\/_next\/static\/[^"']+\.css/g)].map((m) => m[0])) {
      const response = await fetch(`${base}${href}`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) css += await response.text();
    }
  } catch {
    // No server running: fall back to the source, with the caveat printed.
    console.log(
      "  note  no server on " + base + " — checking the source stylesheet only\n" +
        "        (run `npm run dev` for the served-stylesheet version of this rule)",
    );
  }

  const haystack = css.length > 0 ? css : local;
  checked++;
  if (!/caret-color:\s*rgb\(var\(--accent-rgb\)\)/.test(haystack)) {
    fail(
      rule,
      CSS_FILES[0],
      1,
      "caret-color does not resolve from --accent-rgb",
      "Add `caret-color: rgb(var(--accent-rgb));` to :root in globals.css.",
    );
  }
  checked++;
  if (!/accent-color:\s*rgb\(var\(--accent-rgb\)\)/.test(haystack)) {
    fail(
      rule,
      CSS_FILES[0],
      1,
      "accent-color does not resolve from --accent-rgb",
      "Add `accent-color: rgb(var(--accent-rgb));` to :root in globals.css.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Rule 6 — the design system owns the card                          */
/* ------------------------------------------------------------------ */

/**
 * A bordered box that is a card uses `.card`, not an ad-hoc hairline.
 *
 * DESIGN.md §3 defines a card as a surface, a fill sheen, a hairline and
 * `--shadow-1`, and every card in the app is that. The Connections panel shipped
 * as `rounded-lg border border-hairline` with no fill, which on a near-black page
 * reads as a wireframe — the "ghost card" a design review names. The rule flags
 * the exact combination, so a genuinely different surface (a nested well, a
 * disclosure) is unaffected.
 */
function ruleCardSurface() {
  const rule = "card surface — bordered panels use .card";
  for (const file of UI_FILES) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/className=/.test(line)) return;
      checked++;
      const rounded = /\brounded-(lg|xl|md)\b/.test(line);
      const hairline = /border-hairline/.test(line);
      if (!rounded || !hairline) return;
      if (/\bcard\b|card-interactive|floating|panel/.test(line)) return;
      if (/border-t|border-b|border-l|border-r/.test(line)) return;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 96)}"`,
        "Use the project's `card` class, or say in a comment why this surface is not one.",
      );
    });
  }
}

/* ------------------------------------------------------------------ */

console.log("Design system — the craft floor, checked against the source");

ruleTypeFloor();
ruleSingleH1();
ruleHeadingOrder();
ruleLongValueWrap();
ruleCardSurface();
await ruleBrowserSurfaces();

console.log(
  `\n  ${checked} checks across ${UI_FILES.length} components and ${CSS_FILES.length} stylesheet\n`,
);

if (failures > 0) {
  console.log(`  ${failures} rule violation${failures === 1 ? "" : "s"}.\n`);
  process.exit(1);
}

console.log("  ok    every craft-floor rule holds\n");
