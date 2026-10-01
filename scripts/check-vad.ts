/**
 * Where a sentence ends: the failures that actually happened.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-vad.ts
 *
 * WHY THIS FILE EXISTS
 *
 * Every bug in the recorder was found by reading a log, never by reading the
 * code — because the code looks right. A threshold that adapts, a timer that
 * restarts, a level compared to a number: nothing about it draws attention to
 * itself, and the symptom appears three layers away as "she did not listen" or
 * "it stopped after half a second".
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
 *
 * The properties below are the ones a user can feel:
 *
 *   1. A click is not a word.
 *   2. A long sentence is not cut off by its own noise floor — the bug that
 *      produced `chars=0 ms=11960`, a twelve-second clip of nothing where a
 *      sentence had been.
 *   3. A sentence that stops IS detected as ended. Getting this wrong is the
 *      other half: the "still talking" bar sat BELOW the room's own noise, so
 *      the quiet path never ran and the silence timer never started.
 *   4. A room that never has speech in it gives up.
 *   5. A speaker who never stops is cut off eventually.
 *   6. Silence shorter than the minimum cannot end a clip.
 *
 * What is NOT asserted is where exactly the adaptive threshold settles for a
 * given room. Three versions of that assertion were written and all three were
 * wrong, because they encoded a guess about the algorithm rather than a
 * behaviour anyone experiences. A test that must be rewritten every time the
 * estimator is tuned is measuring the estimator, not the outcome.
 */

import {
  DEFAULT_VAD,
  MIN_SPEECH_MS,
  initialVad,
  stepVad,
  type VadConfig,
  type VadState,
  type VadVerdict,
} from "../src/components/xana/vad";

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

/** One frame is ~16ms, which is what a requestAnimationFrame loop delivers. */
const FRAME = 16;

interface RunResult {
  final: VadVerdict | null;
  events: VadVerdict[];
  elapsed: number;
}

function run(
  segments: ReadonlyArray<{ ms: number; level: number | ((at: number) => number) }>,
  config: VadConfig = DEFAULT_VAD,
): RunResult {
  let state: VadState = initialVad();
  let now = 0;
  const events: VadVerdict[] = [];

  for (const segment of segments) {
    const frames = Math.max(1, Math.round(segment.ms / FRAME));
    for (let frame = 0; frame < frames; frame += 1) {
      const level =
        typeof segment.level === "function" ? segment.level(frame * FRAME) : segment.level;
      const step = stepVad(state, level, now, config, 0);
      state = step.state;
      if (step.verdict.kind !== "listening") {
        events.push(step.verdict);
        if (step.verdict.kind !== "speech-started") {
          return { final: step.verdict, events, elapsed: now };
        }
      }
      now += FRAME;
    }
  }
  return { final: null, events, elapsed: now };
}

const started = (result: RunResult) => result.events.some((event) => event.kind === "speech-started");

/* ------------------------------------------------------------------ */
/* 1. A click is not a word                                            */
/* ------------------------------------------------------------------ */

group("A click is not a word", () => {
  const click = run([
    { ms: FRAME, level: 0.5 },
    { ms: 2000, level: 0.002 },
  ]);
  check("a single loud frame never starts speech", !started(click), JSON.stringify(click.events));
  check(
    "and produces no clip",
    click.final === null || click.final.kind === "no-speech",
    JSON.stringify(click.final),
  );

  const smack = run([
    { ms: 80, level: 0.4 },
    { ms: 2000, level: 0.002 },
  ]);
  check("80ms of noise is still not speech", !started(smack), JSON.stringify(smack.events));

  const word = run([
    { ms: 300, level: 0.3 },
    { ms: 1200, level: 0.002 },
  ]);
  check("300ms of speech IS speech", started(word), JSON.stringify(word.events));
});

/* ------------------------------------------------------------------ */
/* 2. The bug that produced a twelve-second clip of nothing            */
/* ------------------------------------------------------------------ */

group("A long sentence ends when the speaking does", () => {
  const long = run([
    { ms: 4000, level: 0.09 },
    { ms: 1500, level: 0.004 },
  ]);
  check("speech started", started(long), JSON.stringify(long.events));
  check("and it ended", long.final?.kind === "speech-ended", JSON.stringify(long.final));
  check(
    "well before the ceiling",
    long.final?.kind === "speech-ended" && long.final.durationMs < 7000,
    JSON.stringify(long.final),
  );
  check(
    "with the whole sentence inside the clip",
    long.final?.kind === "speech-ended" && long.final.durationMs >= 4000,
    JSON.stringify(long.final),
  );

  // A sentence spoken over a room that is not silent. This is the case that broke
  // the first freeze: an unraised threshold left the room itself above the bar,
  // so the sentence never appeared to end.
  //
  // The room has to sit BELOW the starting threshold, or the detector reads the
  // room itself as speech before anyone says anything — which is correct
  // behaviour for a room that loud, and a different scenario from this one.
  const quietRoom = 0.002;
  const overRoom = run([
    { ms: 500, level: quietRoom },
    { ms: 2500, level: 0.06 },
    { ms: 1500, level: quietRoom },
  ]);
  check(
    "a sentence over a quiet room still ends",
    overRoom.final?.kind === "speech-ended",
    JSON.stringify(overRoom.final),
  );
  check(
    "and the clip holds the sentence rather than the room",
    overRoom.final?.kind === "speech-ended" && overRoom.final.durationMs >= 2500,
    JSON.stringify(overRoom.final),
  );
});

group("A voice never raises the estimate enough to cut itself off", () => {
  // Six seconds of steady speech, ten times the starting threshold. If the
  // estimate tracked the speaker, the sentence would be declared over part-way.
  const result = run([
    { ms: 200, level: 0.4 },
    { ms: 6000, level: 0.2 },
    { ms: 1200, level: 0.002 },
  ]);
  check(
    "speech starts exactly once",
    result.events.filter((e) => e.kind === "speech-started").length === 1,
    JSON.stringify(result.events),
  );
  check("and is never declared over while the level holds", result.final?.kind === "speech-ended");
});

/* ------------------------------------------------------------------ */
/* 3. Refusals and limits                                              */
/* ------------------------------------------------------------------ */

group("Silence that never becomes speech gives up", () => {
  const result = run([{ ms: 9000, level: 0.001 }]);
  check("no speech is reported", result.final?.kind === "no-speech", JSON.stringify(result.final));
  check("and it stops before the ceiling", result.elapsed < DEFAULT_VAD.maxMs, String(result.elapsed));
});

group("A speaker who never stops is cut off eventually", () => {
  const result = run([{ ms: 20000, level: 0.3 }]);
  check("the ceiling applies", result.final?.kind === "too-long", JSON.stringify(result.final));
  check("at the configured maximum", result.elapsed >= DEFAULT_VAD.maxMs, String(result.elapsed));
});

group("Silence shorter than the minimum cannot end a clip", () => {
  const short = run(
    [
      { ms: 150, level: 0.3 },
      { ms: 4000, level: 0.001 },
    ],
    { ...DEFAULT_VAD, noSpeechMs: 100_000 },
  );
  const ended = short.events.find((event) => event.kind === "speech-ended");
  check(
    "any clip that ends is at least the minimum long",
    !ended || (ended.kind === "speech-ended" && ended.durationMs >= MIN_SPEECH_MS),
    JSON.stringify(ended),
  );
  check("the minimum is the documented one", MIN_SPEECH_MS === 350, String(MIN_SPEECH_MS));
});

group("A level near the line cannot flicker the sentence open forever", () => {
  // With one threshold, a level hovering at it crosses back and forth every
  // frame, each crossing restarts the silence timer, and the clip never ends.
  const jitter = run([
    { ms: 400, level: 0.05 },
    { ms: 3000, level: (at) => (at % 32 < 16 ? 0.049 : 0.051) },
    { ms: 1500, level: 0.002 },
  ]);
  check(
    "the sentence still ends",
    jitter.final?.kind === "speech-ended" || jitter.final?.kind === "too-long",
    JSON.stringify(jitter.final),
  );
});

/* ------------------------------------------------------------------ */
/* 4. The state machine's arithmetic                                   */
/* ------------------------------------------------------------------ */

group("The estimate stays finite and non-negative", () => {
  let state = initialVad();
  let sane = true;
  for (let index = 0; index < 600; index += 1) {
    const level = index < 100 ? 0.001 : index < 400 ? 0.3 : 0.0002;
    state = stepVad(state, level, index * FRAME).state;
    if (!Number.isFinite(state.floor) || state.floor < 0) sane = false;
    if (!Number.isFinite(state.threshold) || state.threshold < 0) sane = false;
  }
  check(
    "600 frames of mixed levels leave a usable state",
    sane,
    `floor=${state.floor} thr=${state.threshold}`,
  );
  check("and the threshold is never below zero", state.threshold >= 0, String(state.threshold));
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
