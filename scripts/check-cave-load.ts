/**
 * The cave asks for its data when it opens, and no room claims emptiness
 * before the answer lands.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-cave-load.ts
 *
 * WHY THESE ASSERTIONS ARE ABOUT THE SOURCE
 *
 * The failure this guards against is not a wrong answer, it is a question
 * nobody asked. `useCave` published a `reload()`, took an `open` flag it
 * never read, and the five rooms rendered from state that nothing had ever
 * filled — so a database holding three goals and an open task showed
 * "Nothing on the board yet" in My cave while the front page beside it listed
 * them. Every other check in this repo passed: the route was right, the types
 * were right, and the component rendered exactly what it was handed. A screen
 * that never fetches is invisible to `tsc` and to anything that talks HTTP
 * instead of pixels.
 *
 * Seeing it for real needs a browser: press the button, read the text. None
 * can launch in the sandbox this was written in — Chromium's IPC is built on
 * named pipes, which the sandbox denies, and it dies with a Mojo
 * `platform_channel` error before DevTools answers. `scripts/verify-browser.mjs`
 * does the real thing on a machine where a browser exists, and it is the
 * check that catches this class of bug directly. What is left here is the two
 * invariants that a browser would have observed, asserted against the source
 * that has to hold them:
 *
 *   - the read is triggered by an effect that depends on `open`, so opening
 *     the cave sends the request and closing it does not;
 *   - every room routes its empty sentence through `emptyNote`, so "Nothing
 *     open" cannot be printed for a list that has not been read yet.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { emptyNote, READING } from "../src/components/xana/cave/empty-note";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(66)}\n${title}\n${"─".repeat(66)}`);
}

const CAVE_DIR = path.join(process.cwd(), "src", "components", "xana", "cave");

function source(file: string): string {
  return readFileSync(path.join(CAVE_DIR, file), "utf8");
}

/** The text from a signature to the next closing brace in column one. */
function bodyOf(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start === -1) return "";
  const end = text.indexOf("\n}", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/** From a call to the end of its argument list, as far as a grep can tell. */
function callAt(text: string, needle: string): string {
  const start = text.indexOf(needle);
  if (start === -1) return "";
  const end = text.indexOf("]);", start);
  return end === -1 ? text.slice(start) : text.slice(start, end + 3);
}

/** Every room that can be empty, and the file it is rendered from. */
const ROOMS = [
  "CaveBoard.tsx",
  "TasksRoom.tsx",
  "ScheduleRoom.tsx",
  "MemoryRoom.tsx",
  "TrashRoom.tsx",
] as const;

function main(): void {
  /* ---------------- the read ---------------- */
  section("Opening the cave reads it");

  const hook = source("useCave.ts");
  check(
    "the hook imports useEffect",
    /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*"react"/.test(hook),
  );

  const hookBody = bodyOf(hook, "export function useCave(");
  check(
    "useCave is where it is expected to be",
    hookBody.length > 200,
    `found ${hookBody.length} chars of hook body`,
  );

  const effect = callAt(hookBody, "useEffect(");
  check("the hook has an effect", effect.length > 0);
  check("the effect calls reload()", /reload\s*\(\s*\)/.test(effect), effect.slice(0, 120));
  check(
    "it waits until the cave is open",
    /if\s*\(\s*!\s*open\s*\)\s*return\s*;/.test(effect),
    "without this the app would fetch the cave on every page load",
  );
  check(
    "and re-runs whenever open changes",
    /\}\s*,\s*\[[^\]]*\bopen\b[^\]]*\]\s*\)/.test(effect),
    "reading once per mount leaves the board stale for the rest of the session",
  );

  section("Nothing outside the hook opens the cave");

  const cave = source("Cave.tsx");
  check("Cave hands its open flag to the hook", /useCave\(\s*open\s*\)/.test(cave));

  /* ---------------- the empty state ---------------- */
  section("No room claims emptiness before the answer lands");

  check("while reading, the line says so", emptyNote(true, "Nothing open.") === READING);
  check(
    "once read, the room's own sentence is used",
    emptyNote(false, "Nothing open.") === "Nothing open.",
  );
  check("and the reading state is a word, not a blank", READING.trim().length > 0);

  for (const room of ROOMS) {
    const text = source(room);
    check(`${room} asks emptyNote before saying nothing`, /emptyNote\(/.test(text));
    check(
      `${room} does not spell the reading state itself`,
      !text.includes(READING),
      "one string, one place: use READING",
    );
  }

  check(
    "the cave's summary and footer wait for the read too",
    (cave.match(/controller\.loading/g) ?? []).length >= 1 && cave.includes("READING"),
  );
  check(
    "and they do not spell it either",
    !cave.includes(READING),
    "the header would otherwise read as empty while the first request is in flight",
  );

  section("Result");
  console.log(`  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
