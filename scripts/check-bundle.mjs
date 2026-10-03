/**
 * Is the running server's client bundle actually current?
 *
 *   node scripts/check-bundle.mjs [baseUrl]
 *
 * This session repeatedly saw the dev server serve stale compiled chunks
 * while the source on disk was correct, so "the code is right but the
 * browser behaves like the old code" is a real state this project can be
 * in. This reports which of a few known markers are present in the bundle
 * the page actually references.
 */

import { readFileSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:4310";

/** Strings that only exist in the current source. */
const MARKERS = [
  ["Test connection button", "Test connection"],
  ["Save key button", "Save key"],
  ["sticky action bar", "There are unsaved changes"],
  ["the key input id", "xana-api-key"],
  ["My cave header button", "My cave"],
  ["cave board columns", "Set aside"],
  ["cave quick add", "What are you working towards"],
  ["memory room", "What she remembers"],
  ["endpoint preview line", "Requests go to"],
  ["the sentinel import", "__xana_keep__"],
  ["the composer slash hint", "Press / to jump here"],
  // The room to breathe, as the user reads it. The countdown is generated from
  // the setting, so its presence in the served chunk is the difference between
  // "the pause is wired to the interface" and "the pause exists in a module
  // nothing imports any more".
  ["composer: room to breathe", "take your time, answering in"],
  ["settings: room to breathe", "Room to breathe"],
  // The briefing card's own wording. These are the markers that catch a client
  // holding an old bundle: a stale page keeps rendering the previous card
  // shape while the server sends the new one, which looks exactly like the
  // feature not working. Reading the served chunks is the only way to tell
  // those two apart from outside a browser.
  ["briefing: focus session label", "in progress"],
  ["briefing: queued task label", "next in the list"],
  ["briefing: week total", "focused this week"],
  ["briefing: pattern attribution", "read by the model"],
  ["briefing: energy not reported", "Not reported yet"],
  // The ambient panel is the briefing most people actually read — it is the
  // region under the orb on a cold start. Its row labels are the ones that
  // tell "this is what you are on" apart from "this is what is next".
  ["ambient: focus in progress", "in progress"],
  ["ambient: next task label", "next in the list"],
  ["ambient: session is last not current", "last session"],
  ["cave: task form", "What needs doing?"],
  ["cave: tasks room", "Add a task"],
  // The cave's rooms used to render the empty state their state started in —
  // nobody ever sent the read. Both of these live in the module that decides
  // between "still reading" and "nothing here", so a served bundle that
  // carries the new sentence is a bundle that carries the fix.
  ["cave: reading state", "Reading…"],
  ["cave: memory room empty state", "No memories yet."],
  // The log. Its markers are the words a person sees when they open the room and
  // find it empty, plus the sentence that says a number can be spoken — the two
  // things that make the feature discoverable rather than merely present.
  ["cave: log room", "not recorded"],
  ["cave: log room speech hint", "Saying it works too"],
  // Not "Last 7 days": the window comes from the server, so that sentence only
  // exists once the component runs. A bundle marker has to be a literal.
  ["cave: log window", "what the energy forecast is built on"],
  // The calendar. Three literals from the room that replaced the two-day list,
  // one per thing it gained: a place to type, a grid you can drag in, and an
  // honest empty state. A page holding the old Schedule list instead of these
  // is a page holding a stale bundle, which is the one failure that looks
  // exactly like the feature not working.
  ["cave: calendar quick add", "What's going on? Press Enter to put it in"],
  ["cave: calendar drag hint", "Drag a block to move it, its edge to change how long it lasts"],
  ["cave: calendar empty state", "Nothing in these days. Press any slot to add one."],
];

const html = await (await fetch(base)).text();
const chunks = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);

console.log(`${base}`);
console.log(`  page references ${chunks.length} script chunks`);

/** The registry lives server-side; the panel markers live in a client chunk. */
const combined = [];
for (const chunk of chunks) {
  try {
    combined.push(await (await fetch(base + chunk)).text());
  } catch {
    /* a chunk that will not load is its own problem, reported below */
  }
}
const haystack = combined.join("\n");

for (const [label, marker] of MARKERS) {
  const clientSide = marker !== "deepseek-chat";
  if (!clientSide) {
    console.log(`  n/a   ${label} (server-side only)`);
    continue;
  }
  console.log(`  ${haystack.includes(marker) ? "ok   " : "MISS "} ${label}`);
}

/**
 * The source is the tiebreaker: if these markers are in `src/` but not in
 * the served bundle, the running server predates the edit.
 */
console.log("\n  source on disk:");
for (const file of [
  "src/components/xana/settings/ModelPanel.tsx",
  "src/lib/settings/providers.ts",
]) {
  try {
    const text = readFileSync(file, "utf8");
    console.log(
      `    ${file.padEnd(48)} Test connection=${text.includes("Test connection")} apiKey=${text.includes("apiKey")}`,
    );
  } catch {
    console.log(`    ${file} (missing)`);
  }
}

/**
 * The stylesheet is the other half of "is it current", and it fails
 * differently from the JS: Tailwind only re-emits when a class it knows
 * about changes, and it will happily keep serving the previous bundle.
 *
 * That matters more than it sounds. Reading a stale stylesheet is how a
 * utility that compiles perfectly well gets diagnosed as broken, which
 * produced a false finding in a critique pass. So: check that the utilities
 * the source actually asks for are in the served CSS.
 *
 * Two of these are arbitrary values Tailwind has to parse, and those are the
 * ones worth pinning. `shadow-[0_1px_0_rgb(0_0_0/0.35)]` has a slash inside
 * `rgb()` and `accent-[var(--accent)]` is a bare `var()` in a property whose
 * value type has to be inferred. Both work here; if either ever stops
 * working the checkbox or the keycap silently loses its styling, with no
 * error anywhere.
 */
const cssHref = html.match(/href="(\/_next\/static\/chunks\/[^"]+\.css)"/)?.[1];
if (!cssHref) {
  console.log("\n  stylesheet: the page references no CSS chunk");
} else {
  const css = await (await fetch(base + cssHref)).text();
  console.log(`\n  stylesheet (${css.length} bytes):`);
  // Matched on the resolved declaration, not the escaped selector: the
  // selector spelling depends on how many characters Tailwind had to escape
  // (and got one of these wrong on the first attempt here), while the
  // declaration is exactly what the browser will apply. Only declarations
  // specific to these two controls are listed; a generic one like
  // `height: var(--s-5)` would pass because some unrelated component wants it.
  for (const [label, declaration] of [
    ["keycap radius", "border-radius: 6px"],
    // Tailwind v4 does not emit `box-shadow: 0 1px 0 rgb(0 0 0/0.35)`. It
    // routes arbitrary shadows through `--tw-shadow`, and it rewrites the
    // alpha channel as hex (`#00000059`). Pinning the resolved property
    // rather than the authored value is the only form that survives that.
    ["keycap shadow", "--tw-shadow: 0 1px 0 var(--tw-shadow-color, #00000059)"],
    ["keycap press transition", "transition-property: transform, box-shadow"],
    ["milestone checkbox accent", "accent-color: var(--accent)"],
    // The composer's focus ring is a cascade fight, not a style choice:
    // Tailwind emits its utilities after this stylesheet, and the global
    // `:focus-visible` rule is unlayered while `.outline-none` is not, so
    // the textarea's own `outline-none` loses either way. The ring is
    // suppressed by excluding the composer in the global rule, which means
    // a change to that exclusion silently reintroduces an accent box drawn
    // inside the composer's pill.
    ["composer excluded from the focus ring", ":focus-visible:not(#xana-composer)"],
    // 64%, not 24%. The pill's border *is* the composer's focus indicator, and
    // at 24% it composited to rgb(39 67 72) on `--surface` — 1.79:1, which is
    // a focus state nobody can see. `--a-64` measures 5.6:1. Pinned here
    // because the value is invisible in review and load-bearing in use.
    ["composer pill still shows focus", "focus-within\\:border-accent\\/64"],
    ["the global focus ring is visible", "outline: 2px solid var(--a-64)"],
  ]) {
    console.log(`  ${css.includes(declaration) ? "ok   " : "MISS "} ${label}`);
  }

  /**
   * Every accent utility in the source, looked up in the served stylesheet.
   *
   * This is the check for a class that compiles to nothing. Tailwind v4 drops
   * an opacity with a leading zero, so `bg-accent/04` and `bg-accent/08` are
   * silently absent from the page while the source reads as though the wash is
   * there — which is exactly what happened to the goals board's empty lane, and
   * what no screenshot can show, because a missing 8% wash looks like a wash
   * that is subtle. `check:design` refuses the spelling; this refuses the
   * outcome, and it covers every accent utility rather than the two steps.
   */
  const accentUtilities = await collectAccentUtilities();
  const missing = accentUtilities.filter((entry) => !css.includes(entry.needle));
  console.log(`\n  accent utilities in the source (${accentUtilities.length}):`);
  if (missing.length === 0) {
    console.log("  ok    every one of them reached the stylesheet");
  } else {
    for (const entry of missing) {
      console.log(`  MISS  ${entry.needle.replace(/\\/g, "")} — ${entry.where}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Every `…-accent/NN` (and `-accent-2/NN`) utility written under `src/`,
 * as the escaped class name Tailwind emits.
 *
 * The escape matters: Tailwind writes `bg-accent\/8`, so the needle has to be
 * the escaped spelling or the lookup finds nothing and reports a false miss.
 * The location is kept so a failure names the file rather than only the class.
 */
async function collectAccentUtilities() {
  const { readdirSync, statSync } = await import("node:fs");
  const { join, relative, sep } = await import("node:path");
  const root = join(process.cwd(), "src");

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(entry)) files.push(full);
    }
  };
  walk(root);

  const seen = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b((?:bg|border|text|from|to|ring|fill|stroke|decoration)-(?:accent|accent-2)\/(\d{1,3}))\b/g)) {
      if (seen.has(match[1])) continue;
      const escaped = match[1].replace("accent-2/", "accent-2\\/").replace(/accent\//, "accent\\/");
      seen.set(match[1], {
        needle: escaped,
        where: `${relative(process.cwd(), file).split(sep).join("/")}`,
      });
    }
  }
  return [...seen.values()];
}
