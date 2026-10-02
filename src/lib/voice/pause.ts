/**
 * The room to breathe: how long a silence means "I have finished".
 *
 * WHY THIS EXISTS
 *
 * Every voice path in this app used to decide that a thought was over after
 * about a second of quiet, and each one decided it differently:
 *
 *   - the browser recogniser finalises a result on its own schedule, roughly
 *     1.0-1.5s of quiet, and the composer sent a spoken question the moment a
 *     final result arrived;
 *   - the wake listener submitted a request as soon as the interim transcript
 *     stopped changing for 1100ms, so pausing to think mid-sentence sent the
 *     half of it that existed and the rest arrived as a second request. That is
 *     worse than losing it: it reads as the app mishearing rather than as the
 *     app interrupting;
 *   - the local recorder closed a clip after 850ms of quiet and transcribed the
 *     fragment.
 *
 * The user asked for this in as many words: "i may stay quiet for 3 seconds
 * therefore, give me a room to breath to continue my conversation". A person
 * thinking mid-sentence is not finished, and the app has to wait for them
 * rather than guess. The default is therefore 4 seconds, above the three the
 * user named, and it is a setting, because the right number is a property of
 * the person and not of the software.
 *
 * WHAT IT IS APPLIED TO
 *
 * One number, four places, so the paths cannot drift apart again:
 *
 *   1. composer, browser engine  — a final result arms the window instead of
 *                                  sending; any new result restarts it;
 *   2. composer, local engine    — the recorder's own `silenceMs`;
 *   3. wake listener, browser    — the settle window after the transcript stops
 *                                  changing, a final result included;
 *   4. wake listener, local      — the recorder's `silenceMs` while a request
 *                                  is expected.
 *
 * It is deliberately NOT a VAD tuning knob. `vad.ts` decides *where a sentence
 * ended* from loudness; this decides *whether the person is done talking*, and
 * the second question is not answerable from the audio.
 *
 * It lives in `lib/` rather than beside the components because the settings
 * store has to clamp the stored value with the same rule the slider and the
 * recognisers use, and a settings store importing from `components/` would be
 * backwards.
 */

/**
 * Four seconds.
 *
 * Three would satisfy the letter of the request and fail it in practice: the
 * pause and the app's own reaction time stack, so a person who stops for
 * exactly three seconds still hears the answer start before they do.
 */
export const DEFAULT_PAUSE_MS = 4_000;

/**
 * The floor is 1.5s, not zero, and that is a real limit rather than a
 * preference: below it the window stops being room to think and becomes a
 * slower version of the same interruption, because the recogniser's own
 * endpointing already spends about a second.
 */
export const MIN_PAUSE_MS = 1_500;

/**
 * A ceiling, so a hand-edited settings file cannot hold the microphone open for
 * minutes or make "she did not answer" the normal outcome.
 */
export const MAX_PAUSE_MS = 10_000;

/** Clamp anything that arrives from a settings file or a slider. */
export function normalisePauseMs(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PAUSE_MS;
  return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Math.round(n / 100) * 100));
}

/** When the quiet started, or `null` when nothing is pending. */
export type ArmedAt = number | null;

/** Milliseconds left before the thought counts as finished. Never negative. */
export function remainingMs(armedAt: ArmedAt, now: number, pauseMs: number): number {
  if (armedAt === null) return 0;
  return Math.max(0, normalisePauseMs(pauseMs) - (now - armedAt));
}

/** Whether the quiet has lasted long enough for the turn to be over. */
export function pauseElapsed(armedAt: ArmedAt, now: number, pauseMs: number): boolean {
  if (armedAt === null) return false;
  return remainingMs(armedAt, now, pauseMs) === 0;
}

/**
 * What to tell the recorder, given the pause the user asked for.
 *
 * `silenceMs` is the pause itself: the clip closes only after the person has
 * been quiet for as long as they said they might be. `maxMs` is the ceiling
 * that stops a noisy room recording forever, and it has to grow with the pause
 * or a long sentence plus a long think would be cut off by the ceiling instead
 * of by silence, which is the same bug wearing a different hat.
 */
export function recorderWindow(
  pauseMs: number,
  speechCeilingMs = 12_000,
): { silenceMs: number; maxMs: number } {
  const pause = normalisePauseMs(pauseMs);
  return { silenceMs: pause, maxMs: pause + speechCeilingMs };
}

/**
 * The line shown while the app is waiting, in the interface's own voice.
 *
 * The countdown is the whole point: without it a four second wait reads as the
 * app having missed the request, and the user repeats themselves into a
 * recogniser that is already listening. With it, the wait is visibly theirs.
 */
export function waitCopy(remaining: number): string {
  if (remaining <= 0) return "Listening — answering now";
  const seconds = Math.ceil(remaining / 1000);
  return `Listening — take your time, answering in ${seconds}s`;
}
