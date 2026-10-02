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

/**
 * The same file with its comments removed, one entry per line.
 *
 * A gate that reads raw text reports the file that *documents* a rule. Three of
 * the rules below name banned tokens in their own explanations, and two of those
 * comments are inside components, so the first version of rule 9 failed on the
 * comment that said "`bg-accent/04` compiles to nothing" — the most annoying
 * possible false positive, because the fix is to delete the explanation.
 *
 * Line numbers are preserved by returning a same-length array, and the `//` tail
 * is only treated as a comment when whitespace precedes it, so a `https://` in a
 * string survives. That last heuristic is a heuristic: it is right for this
 * codebase's formatting and it errs toward scanning code rather than skipping it.
 */
function codeLines(file) {
  const raw = readFileSync(file, "utf8").split(/\r?\n/);
  let inBlock = false;
  return raw.map((line) => {
    let text = line;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) return "";
      text = text.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = text.indexOf("/*");
      if (start === -1) break;
      const end = text.indexOf("*/", start + 2);
      if (end === -1) {
        text = text.slice(0, start);
        inBlock = true;
        break;
      }
      text = `${text.slice(0, start)} ${text.slice(end + 2)}`;
    }
    return text.replace(/\s\/\/.*$/, "");
  });
}

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
 * Any literal size of 12px or less in the same class list is flagged, so the
 * 10px micro-label is caught by the same rule as the 11px one. A size that
 * comes from a token or a media query is still not guessed at — that is what
 * rule 8 reads instead.
 */
function ruleTypeFloor() {
  const rule = "type floor — no font-light at 12px or below";
  for (const file of UI_FILES) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/className=/.test(line)) return;
      if (!/font-light/.test(line)) return;
      const size = line.match(/text-\[(\d+(?:\.\d+)?)px\]/);
      if (!size) return;
      if (Number(size[1]) > 12) return;
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
/* Rule 7 — a component never authors a colour                        */
/* ------------------------------------------------------------------ */

/**
 * No hex or `rgb()` literal in a component.
 *
 * The one structural rule DESIGN.md states outright: accents are stored as raw
 * sRGB channels and every shade is *composed* from them, which is what lets a
 * theme picker recolour the interface without any component knowing it exists.
 * A component that writes `#7fe3e3` opts itself out of every theme, silently,
 * and it looks correct in the default palette — which is exactly why nobody
 * reports it.
 *
 * **Where the finished colours are allowed to live, and why.** Two things in
 * this app genuinely cannot read a custom property: `<meta name="theme-color">`
 * (consumed before the document exists) and `<input type="color">` (takes
 * `#rrggbb` and nothing else). Both now take their values from `PALETTE` in
 * `lib/settings/types.ts`, so the rule is enforced everywhere except that one
 * declaration — and the rule caught a real drift while it was being written:
 * the layout's fallback was `#07070A` while `--void` is `#040406`.
 */
const LITERAL_COLOUR_ALLOWED = new Set(["src/lib/settings/types.ts"]);

function ruleNoLiteralColour() {
  const rule = "colour — components compose from channels, never author a colour";
  for (const file of UI_FILES) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (LITERAL_COLOUR_ALLOWED.has(rel)) continue;
    const lines = codeLines(file);
    lines.forEach((line, index) => {
      checked++;
      const literal = line.match(/#[0-9a-fA-F]{3,8}\b/);
      if (!literal) return;
      if (/href="#|viewBox|xlinkHref/.test(line)) return;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 96)}" — ${literal[0]} is a finished colour`,
        "Compose from the channels: `rgb(var(--accent-rgb) / 0.4)`, or take it from PALETTE if a CSS variable genuinely cannot reach.",
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 8 — the stylesheet obeys the same floor as the components     */
/* ------------------------------------------------------------------ */

/**
 * The utility classes are text too, and they were the hole in rule 1.
 *
 * Rule 1 reads `className` lists in `.tsx`. Every text treatment the app
 * actually reads in — `.label`, `.timestamp`, `.btn`, `.field` — is declared
 * in `globals.css` instead, and there the floor was not enforced at all. The
 * result was exactly the drift the rule exists to prevent: `.timestamp` set
 * 11px at `font-weight: 300`, which is the pair DESIGN.md §1 forbids in the
 * same document that documents the token, while CI stayed green because no
 * class list ever contained the combination.
 *
 * A design detector measured it before this rule existed: 11px body text, nine
 * times on one screen, plus the 10px label below the 11px floor for functional
 * text. Both values are fixed; this is the gate that keeps them fixed.
 *
 * Two decidable rules, on every block that sets a size:
 *   - no text below 11px anywhere in the stylesheet;
 *   - nothing at 12px or below may be weight 300 or lighter.
 * Weights above the floor are read as written, so `.metric`'s 200 stays legal
 * at 30px, which is the point: the floor is about small text, not about taste.
 */
function ruleCssTypeFloor() {
  const rule = "type floor — stylesheet utilities obey the floor too";
  const css = readFileSync(CSS_FILES[0], "utf8");
  for (const match of css.matchAll(/([^{}\n][^{}]*)\{([^{}]*)\}/g)) {
    const [, rawSelector, body] = match;
    const size = body.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    if (!size) continue;
    checked++;
    const selector = rawSelector
      .split("*/")
      .pop()
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 60) || "(unnamed block)";
    const line =
      css.slice(0, match.index).split(/\r?\n/).length +
      body.slice(0, size.index).split(/\r?\n/).length -
      1;
    const px = Number(size[1]);
    if (px < 11) {
      fail(
        rule,
        CSS_FILES[0],
        line,
        `${selector} sets font-size: ${px}px`,
        "11px is the floor for functional text (DESIGN.md §2). Raise it, or say in a comment why this one is not text.",
      );
      continue;
    }
    const weight = body.match(/font-weight:\s*(\d+)/);
    const light = weight ? Number(weight[1]) <= 300 : /font-light/.test(body);
    if (px <= 12 && light) {
      fail(
        rule,
        CSS_FILES[0],
        line,
        `${selector} sets ${px}px at weight ${weight ? weight[1] : "300"}`,
        "Weight is part of legibility at this size: use 400, as `.timestamp` now does.",
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rule 9 — the accent ramp, and the wells                            */
/* ------------------------------------------------------------------ */

/**
 * A wash is one of six alphas, and a recessed surface is one of three wells.
 *
 * DESIGN.md §1 has said "use these, never invented opacities" since the ramp
 * existed, and the interface had drifted to nine off-ramp alphas anyway: /5,
 * /10, /15, /20, /30, /48 and /55 for the accent, each one a slightly different
 * answer to the same question, and four different black literals for a
 * recessed surface. The visual cost is small and the systemic cost is not: a
 * chosen chip looks different in every room, and the theme picker's promise
 * (change three integers and the interface re-derives) is only as true as the
 * ramp is small.
 *
 * The wells are `--well`, `--well-deep` and `--scrim`. Anything else that
 * reaches for black is a new depth level pretending not to be one.
 */
const ACCENT_RAMP = new Set(["4", "8", "14", "24", "40", "64"]);
const ACCENT_2_RAMP = new Set(["8", "14", "24"]);

/**
 * Why the two lowest steps are spelled `/4` and `/8` and not `/04` and `/08`.
 *
 * Tailwind v4 drops an opacity with a leading zero: `bg-accent/04` and
 * `bg-accent/08` compile to no rule at all, silently. A well was missing its
 * wash in the goals board for exactly this reason and nothing could see it,
 * because an absent utility looks identical to a utility whose effect is
 * subtle. So this rule rejects the leading-zero spelling outright, and
 * `check:bundle` separately asserts that every accent utility written in the
 * source has a rule in the *served* stylesheet. The second one is the real
 * gate; this one exists so the failure is named at the point it is written.
 */
function ruleRampAndWells() {
  const rule = "colour — the ramp and the wells are the only washes";
  for (const file of UI_FILES) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (LITERAL_COLOUR_ALLOWED.has(rel)) continue;
    const lines = codeLines(file);
    lines.forEach((line, index) => {
      checked++;
      for (const match of line.matchAll(/\b(accent-2|accent)\/(\d{1,3})\b/g)) {
        if (/^0/.test(match[2])) {
          fail(
            rule,
            file,
            index + 1,
            `${match[0]} has a leading zero, so Tailwind emits no rule for it — "${line.trim().slice(0, 64)}"`,
            `Write ${match[1]}/${Number(match[2])}, or use the token form \`bg-[var(--a-${match[2].slice(1).padStart(2, "0")})]\`.`,
          );
          continue;
        }
        const ramp = match[1] === "accent" ? ACCENT_RAMP : ACCENT_2_RAMP;
        if (ramp.has(match[2])) continue;
        fail(
          rule,
          file,
          index + 1,
          `${match[0]} is not on the ramp — "${line.trim().slice(0, 72)}"`,
          `The accent ramp is ${[...ACCENT_RAMP].map((a) => `accent/${a}`).join(", ")} (secondary: ${[...ACCENT_2_RAMP].map((a) => `accent-2/${a}`).join(", ")}). Pick the nearest step rather than a new number.`,
        );
      }
      const black = line.match(/\b(?:bg|text|border|from|to)-black\/(\d{1,3})\b/);
      if (black) {
        fail(
          rule,
          file,
          index + 1,
          `${black[0]} is a black literal — "${line.trim().slice(0, 72)}"`,
          "Use a well: `bg-well`, `bg-well-deep`, or `bg-scrim` behind a dialog.",
        );
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 10 — no stock motion                                          */
/* ------------------------------------------------------------------ */

/**
 * Every duration is a token and every animation is the project's own.
 *
 * `duration-150` next to `duration-[var(--t-fast)]` is not a style choice, it
 * is one control that forgot which system it is in, and `animate-pulse` is
 * literally another product's loading state. Both were shipping.
 *
 * The two live meters are the one real exception and they are named rather
 * than pattern-matched: a loudness meter needs a time constant shorter than
 * any designed duration, or the bar trails the voice it is measuring.
 */
const METER_FILES = new Set([
  "src/app/xana/mic/page.tsx",
  "src/components/xana/Composer.tsx",
]);

function ruleStockMotion() {
  const rule = "motion — durations are tokens, animations are the project's";
  for (const file of UI_FILES) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const lines = codeLines(file);
    lines.forEach((line, index) => {
      checked++;
      const duration = line.match(/\bduration-(\d{2,4})\b/);
      if (duration && !METER_FILES.has(rel)) {
        fail(
          rule,
          file,
          index + 1,
          `duration-${duration[1]} — "${line.trim().slice(0, 72)}"`,
          "Use `duration-[var(--t-fast)]`, `--t-state` or `--t-base`, so the motion slider still moves it.",
        );
      }
      if (/\banimate-pulse\b/.test(line)) {
        fail(
          rule,
          file,
          index + 1,
          `animate-pulse — "${line.trim().slice(0, 72)}"`,
          "Tailwind's pulse is another product's loading state. Use `.skeleton`, or the two drifting bars.",
        );
      }
      if (/\btransition-all\b/.test(line)) {
        fail(
          rule,
          file,
          index + 1,
          `transition-all — "${line.trim().slice(0, 72)}"`,
          "Name the properties: `transition-colors`, or an explicit list, so a layout change cannot animate by accident.",
        );
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 11 — one uppercase treatment                                  */
/* ------------------------------------------------------------------ */

/**
 * Uppercase text wears the label treatment, or says why it does not.
 *
 * The signature of this interface is 11px, weight 500, 0.15em, uppercase. It
 * had been re-invented five times with a different size or tracking each time
 * (13px at 0.02em for section headings, 11px at 0.12em for pills), so the same
 * visual idea rendered four ways in one panel. Rule 11 makes the treatment a
 * class you use rather than a recipe you retype.
 *
 * Two exemptions, both explicit: the wordmark, which is a mark rather than a
 * label and carries its own 0.32em tracking, and anything carrying `data-mark`,
 * which is how a genuinely different treatment (a toned status pill) declares
 * itself instead of looking like an oversight.
 */
function ruleOneUppercaseTreatment() {
  const rule = "type — uppercase wears the label treatment";
  for (const file of UI_FILES) {
    const lines = codeLines(file);
    lines.forEach((line, index) => {
      if (!/className=/.test(line)) return;
      if (!/\buppercase\b/.test(line)) return;
      checked++;
      if (/\blabel\b/.test(line)) return;
      if (/tracking-\[0\.32em\]/.test(line) || /data-mark/.test(line)) return;
      fail(
        rule,
        file,
        index + 1,
        `"${line.trim().slice(0, 88)}"`,
        "Add the `label` class, or add `data-mark` if this treatment is deliberately different.",
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/* Rule 12 — a class the stylesheet owns is not overridden inline     */
/* ------------------------------------------------------------------ */

/**
 * `.chip`, `.label` and `.field` are unlayered, so they beat every utility.
 *
 * That is deliberate — the tap floor and the type floor are safety rules, not
 * preferences, and a utility must not be able to undo them — but it has a trap
 * that costs an hour every time: `className="chip text-accent"` looks right,
 * paints nothing, and leaves no trace anywhere. Three workarounds went into
 * this pass for exactly that reason (a tone class, a `data-` state, an inner
 * span for the tone on a pill), and the next person will not know the rule
 * exists unless something tells them.
 *
 * So this refuses the combination: a utility that sets a property the class
 * already sets. Only the properties those three classes actually declare are
 * listed, and `rounded-full`/`px-2` inside a class list that also carries a
 * *different* shared class is unaffected.
 */
const OWNED_PROPERTIES = {
  chip: [/^rounded(-|$)/, /^px-/, /^py-/, /^p-/, /^text-\[?\d/, /^text-(?!left|right|center|wrap|ellipsis|nowrap)/, /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, /^tracking-/, /^uppercase$/, /^border$/],
  label: [/^text-\[?\d/, /^text-(?!left|right|center|wrap|ellipsis|nowrap)/, /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, /^tracking-/, /^uppercase$/],
  // `font-mono` is deliberately absent: `.field` sets a size and a weight, not
  // a family, so a monospace field is one of the few utilities that does apply.
  field: [/^rounded(-|$)/, /^px-/, /^py-/, /^p-/, /^text-\[?\d/, /^text-(?!left|right|center|wrap|ellipsis|nowrap)/, /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, /^bg-/, /^border$/, /^border-(?!t|b|l|r|danger)/],
};

function ruleClassOwnsItsProperties() {
  const rule = "composition — a shared class is not overridden by a utility";
  for (const file of UI_FILES) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (LITERAL_COLOUR_ALLOWED.has(rel)) continue;
    const lines = codeLines(file);
    lines.forEach((line, index) => {
      const match = line.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
      if (!match) return;
      const classes = (match[1] ?? match[2] ?? "").split(/\s+/).filter(Boolean);
      for (const [owner, patterns] of Object.entries(OWNED_PROPERTIES)) {
        if (!classes.includes(owner)) continue;
        for (const token of classes) {
          if (token === owner) continue;
          if (!patterns.some((pattern) => pattern.test(token))) continue;
          checked++;
          fail(
            rule,
            file,
            index + 1,
            `"${token}" on a .${owner} — "${line.trim().slice(0, 72)}"`,
            `.${owner} is unlayered and owns that property, so the utility paints nothing. Use a variant the class offers (chip-accent, chip-danger, data-mark) or an inner element.`,
          );
        }
      }
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
ruleNoLiteralColour();
ruleCssTypeFloor();
ruleRampAndWells();
ruleStockMotion();
ruleOneUppercaseTreatment();
ruleClassOwnsItsProperties();
await ruleBrowserSurfaces();

console.log(
  `\n  ${checked} checks across ${UI_FILES.length} components and ${CSS_FILES.length} stylesheet\n`,
);

if (failures > 0) {
  console.log(`  ${failures} rule violation${failures === 1 ? "" : "s"}.\n`);
  process.exit(1);
}

console.log("  ok    every craft-floor rule holds\n");
