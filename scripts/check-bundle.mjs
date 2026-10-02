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
    ["composer pill still shows focus", "focus-within\\:border-accent\\/24"],
  ]) {
    console.log(`  ${css.includes(declaration) ? "ok   " : "MISS "} ${label}`);
  }
}
