/**
 * The room to breathe: three seconds of quiet must not end a sentence.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-pause.ts
 *
 * WHY THIS FILE EXISTS
 *
 * The user asked for this by describing their own behaviour: "i may stay quiet
 * for 3 seconds, therefore give me a room to breath to continue my
 * conversation". That is a requirement with a number in it, and the number is
 * the whole feature. Three separate places in the app used to decide a thought
 * was over after about one second — the browser recogniser's final result, the
 * wake listener's 1100ms settle window, and the local recorder's 850ms silence
 * — and nothing in the code looked wrong in any of them. The symptom was three
 * layers away: half a question answered, then the rest of it arriving as a
 * second turn.
 *
 * WHAT IS ASSERTED
 *
 *   1. The requirement itself, in the user's own units: 3.0s of quiet inside a
 *      4.0s window does not fire, and neither does anything shorter.
 *   2. The window fires when the quiet outlasts it, and only then.
 *   3. The clamp, on both ends, including a hand-edited settings file.
 *   4. The recorder window handed to the VAD grows with the pause, so a long
 *      sentence plus a long think cannot be cut off by the ceiling instead of
 *      by silence.
 *   5. The copy counts down in seconds, because a four second wait with no
 *      explanation reads as having been missed.
 *   6. The four call sites still use this module rather than their own numbers.
 *      This one is a source reading, and it is the assertion that keeps the
 *      feature from silently un-shipping itself: the previous state of every
 *      file involved looked correct.
 *
 * What is NOT asserted is how the wait looks while it runs, or the exact
 * millisecond at which a real recogniser finalises a result. The first is a
 * screenshot's job; the second is not ours to decide, which is the point of
 * owning the window on this side.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  normalisePauseMs,
  pauseElapsed,
  recorderWindow,
  remainingMs,
  waitCopy,
} from "../src/lib/voice/pause";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const T0 = 1_700_000_000_000;

/* ------------------------------------------------------------------ */

group("The three seconds the user named", () => {
  check(
    "the default window is longer than three seconds",
    DEFAULT_PAUSE_MS > 3_000,
    `${DEFAULT_PAUSE_MS}ms`,
  );
  check(
    "3.0s of quiet does not end the turn on the default",
    !pauseElapsed(T0, T0 + 3_000, DEFAULT_PAUSE_MS),
  );
  check(
    "3.9s of quiet does not end it either",
    !pauseElapsed(T0, T0 + 3_900, DEFAULT_PAUSE_MS),
  );
  check(
    "4.0s of quiet does end it, on the millisecond",
    pauseElapsed(T0, T0 + 4_000, DEFAULT_PAUSE_MS),
  );
  check("nothing is pending before anything is heard", !pauseElapsed(null, T0 + 60_000, DEFAULT_PAUSE_MS));
  check(
    "the countdown reports the remaining time",
    remainingMs(T0, T0 + 1_000, 4_000) === 3_000,
    `${remainingMs(T0, T0 + 1_000, 4_000)}ms`,
  );
  check(
    "and never goes negative",
    remainingMs(T0, T0 + 99_000, 4_000) === 0,
  );
  check(
    "a window of 1.5s fires at 1.5s, not at 1.4s",
    !pauseElapsed(T0, T0 + 1_400, 1_500) && pauseElapsed(T0, T0 + 1_500, 1_500),
  );
});

group("The clamp, including a hand-edited settings file", () => {
  check("zero becomes the floor", normalisePauseMs(0) === MIN_PAUSE_MS);
  check("a negative value becomes the floor", normalisePauseMs(-5_000) === MIN_PAUSE_MS);
  check("a minute becomes the ceiling", normalisePauseMs(60_000) === MAX_PAUSE_MS);
  check("NaN becomes the default", normalisePauseMs(Number.NaN) === DEFAULT_PAUSE_MS);
  check("a string becomes the default", normalisePauseMs("4000" as unknown) === DEFAULT_PAUSE_MS);
  check("a missing value becomes the default", normalisePauseMs(undefined) === DEFAULT_PAUSE_MS);
  check("a real value survives intact", normalisePauseMs(4_500) === 4_500);
  check("and is rounded to a tenth of a second", normalisePauseMs(4_517) === 4_500);
  check("the floor is below the default", MIN_PAUSE_MS < DEFAULT_PAUSE_MS);
  check("the default is below the ceiling", DEFAULT_PAUSE_MS < MAX_PAUSE_MS);
});

group("What the recorder is told", () => {
  const window = recorderWindow(DEFAULT_PAUSE_MS);
  check(
    "the silence window is the pause itself",
    window.silenceMs === DEFAULT_PAUSE_MS,
    `${window.silenceMs}ms`,
  );
  check(
    "the ceiling grows with the pause, so a long sentence is not cut off by it",
    window.maxMs > window.silenceMs,
    `${window.maxMs}ms`,
  );
  check(
    "and leaves real room for speech on top of the pause",
    window.maxMs - window.silenceMs >= 10_000,
    `${window.maxMs - window.silenceMs}ms of speech`,
  );
  check(
    "a short pause still gets the same speech ceiling",
    recorderWindow(1_500).maxMs - recorderWindow(1_500).silenceMs === window.maxMs - window.silenceMs,
  );
  check(
    "an out-of-range value is clamped before it reaches the VAD",
    recorderWindow(99_999).silenceMs === MAX_PAUSE_MS,
  );
});

group("What the user reads while waiting", () => {
  check(
    "the countdown reads in seconds",
    waitCopy(3_200) === "Listening — take your time, answering in 4s",
    waitCopy(3_200),
  );
  check("a whole second does not round down", waitCopy(4_000) === "Listening — take your time, answering in 4s");
  check("the last moment still says a second", waitCopy(1) === "Listening — take your time, answering in 1s");
  check("the end of the wait says so", waitCopy(0) === "Listening — answering now");
  check("no exclamation marks, per the interface voice", !waitCopy(2_500).includes("!"));
});

group("The four call sites still use this module", () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");

  const composer = read("src/components/xana/Composer.tsx");
  const wake = read("src/components/xana/useWakeListener.ts");
  const page = read("src/app/page.tsx");

  check("the composer imports the pause module", /from "@\/lib\/voice\/pause"/.test(composer));
  check("the composer waits out the pause on a final result", /setArmedAt\(Date\.now\(\)\)/.test(composer));
  check("the composer gives the recorder the pause window", /recorderWindow\(pause\)/.test(composer));
  check("the composer shows the countdown", /waitCopy\(waitLeft\)/.test(composer));

  check("the wake listener imports the pause module", /from "@\/lib\/voice\/pause"/.test(wake));
  check(
    "the wake listener's old 1100ms settle window is gone",
    !/SETTLE_MS/.test(wake),
    "SETTLE_MS is still referenced",
  );
  check("the wake listener settles on the user's pause", /}, pauseRef\.current\)/.test(wake));
  check("the wake listener's recorder waits it out too", /recorderWindow\(pauseRef\.current\)/.test(wake));
  check(
    "the wake listener's command window is at least three pauses",
    /Math\.max\(COMMAND_WINDOW_MS, pauseRef\.current \* 3\)/.test(wake),
  );

  check("the composer is given the setting", /pauseMs=\{pauseMs\}/.test(page));
  check("the wake listener is given the setting", /^\s*pauseMs,$/m.test(page));
});

/* ------------------------------------------------------------------ */
/* The value, through the real settings file                           */
/* ------------------------------------------------------------------ */

/**
 * The form and the store are two hand-written validators for one number.
 *
 * The slider clamps on the way out and the store clamps on the way in, and
 * neither is exercised by the assertions above, which test the rule rather than
 * the file. This writes to a real settings file in a throwaway directory — one
 * that also proves the value survives JSON, which is where a number arrives as
 * a string if anybody ever changes the writer.
 *
 * The environment variable is set before the store is imported because the
 * store resolves its directory at module load, which is the whole reason this
 * import is dynamic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const scratch = mkdtempSync(join(tmpdir(), "xana-pause-"));
process.env.XANA_DATA_DIR = scratch;

const settings = await import("../src/lib/settings/store");

group("The value, through the real settings file", () => {
  const reread = () => {
    settings.invalidateSettingsCache();
    return settings.loadSettings().voice.pauseMs;
  };
  const write = (pauseMs: number) => {
    settings.saveSettings(settings.mergePatch(settings.loadSettings(), { voice: { pauseMs } }));
    return reread();
  };

  check("a fresh install starts at four seconds", reread() === DEFAULT_PAUSE_MS, `${reread()}ms`);
  check("a saved value is on disk, not only in memory", write(6_000) === 6_000, `${reread()}ms`);
  check("a hand-edited 99s is clamped on the way in", write(99_000) === MAX_PAUSE_MS);
  check("and so is a 0.1s", write(100) === MIN_PAUSE_MS);
  check("the file itself carries the clamped number", (() => {
    const raw = JSON.parse(readFileSync(settings.settingsPath(), "utf8")) as {
      voice?: { pauseMs?: unknown };
    };
    return raw.voice?.pauseMs === MIN_PAUSE_MS;
  })());
});

rmSync(scratch, { recursive: true, force: true });

/* ------------------------------------------------------------------ */

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
